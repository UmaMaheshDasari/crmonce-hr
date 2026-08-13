/**
 * Late Login requests (and, future-ready, other self-service request types via
 * hr_requesttype: Early Logout / WFH / Permission / On Duty / Client Visit /
 * Business Travel — the same table + API serve all of them).
 *
 * An employee submits a Late Login (Date, Expected/Actual login time, Reason,
 * Remarks, optional Attachment). Two-step approval: reporting manager → HR (unless
 * settings disable approval, then it is auto-approved). Attendance stays Present
 * and NO leave/salary is deducted — this is purely a record (a future payroll
 * penalty hook exists in settings but is off by default).
 */
const d365 = require('./d365.service');
const payrollSettings = require('./payroll-settings.service');
const { toValue } = require('./picklist');
const requestNotify = require('./request-notify.service');       // getApprovers() → HR recipients (reused)
const { punchesFromRecord } = require('./attendance.util');       // check-in verification
const { resolveSender } = require('./email/sender');              // dynamic employee mailbox (reused)
const ledger = require('./notification-ledger.service');          // one-email idempotency (reused)
const time = require('./time.util');                             // company-timezone (IST) "today"
const T = require('./email/templates');                          // shared HTML email templates
let notif; try { notif = require('./notification.service'); } catch (_) { notif = null; }
let activity; try { activity = require('./activity.service'); } catch (_) { activity = null; }

const LATE = d365.constructor.entities.lateLogin;
const EMP = d365.constructor.entities.employee;
const ATT = d365.constructor.entities.attendance;
const ATT_PUNCH_SELECT = 'hr_hrattendanceid,hr_date,hr_allpunches,hr_intime,hr_outtime,hr_punchcount,_hr_hremployee_value';

const audit = (p) => { try { activity?.record?.(p); } catch (_) {} };
const notifyUser = (id, ev, p) => { try { notif?.notifyUser?.(id, ev, p); } catch (_) {} };
const broadcast = (ev, p) => { try { notif?.broadcast?.(ev, p); } catch (_) {} };
const esc = (v) => String(v ?? '').replace(/'/g, "''");
const today = () => time.istDateStr();   // "today" in the company timezone (Asia/Kolkata), not raw UTC
const addDays = (dateStr, days) => { const d = new Date(`${dateStr}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + Number(days)); return d.toISOString().slice(0, 10); };

// New columns (requestType/attachmentId/ip) are optional so reads degrade until provisioned.
const SELECT_BASE = 'hr_lateloginid,hr_employeeid,hr_employeename,hr_date,hr_month,hr_expectedtime,hr_actualtime,hr_reason,hr_remarks,hr_status,hr_managerstatus,hr_approvedby,hr_approveddate,hr_createdby,createdon';
const SELECT_OPT = 'hr_requesttype,hr_attachmentid,hr_ip';

const shape = (r) => ({
  id: r.hr_lateloginid,
  employeeId: r.hr_employeeid,
  employeeName: r.hr_employeename || '',
  date: r.hr_date || '',
  month: r.hr_month || '',
  expectedTime: r.hr_expectedtime || '',
  actualTime: r.hr_actualtime || '',
  reason: r.hr_reason || '',
  remarks: r.hr_remarks || '',
  status: r.hr_status || 'pending',
  managerStatus: r.hr_managerstatus || 'pending',
  approvedBy: r.hr_approvedby || '',
  approvedDate: r.hr_approveddate || '',
  createdBy: r.hr_createdby || '',
  requestType: r.hr_requesttype || 'late_login',
  attachmentId: r.hr_attachmentid || '',
  ip: r.hr_ip || '',
  createdOn: r.createdon,
});

async function getRaw(id) {
  const r = await d365.getByIdOptional(LATE, id, { select: SELECT_BASE, optionalSelect: SELECT_OPT });
  return r;
}

async function list({ employeeId, month, status, requestType, from, to } = {}) {
  const filters = [];
  if (employeeId) filters.push(`hr_employeeid eq '${esc(employeeId)}'`);
  if (month) filters.push(`hr_month eq '${esc(month)}'`);
  if (status) filters.push(`hr_status eq '${esc(status)}'`);
  if (requestType) filters.push(`hr_requesttype eq '${esc(requestType)}'`);
  if (from) filters.push(`hr_date ge '${esc(from)}'`);
  if (to) filters.push(`hr_date le '${esc(to)}'`);
  const { data } = await d365.getListOptional(LATE, { select: SELECT_BASE, optionalSelect: SELECT_OPT, filter: filters.join(' and ') || undefined, orderby: 'createdon desc', top: 5000 });
  return (data || []).map(shape);
}

async function policy() {
  // Late Login is an INFORMATION record — FUTURE requests are ALWAYS allowed (an
  // employee can flag they will be late), regardless of the generic allow-future
  // setting. Everything else (limit, backdated window, timezone) comes from settings.
  try { return { ...(await payrollSettings.getResolved()).lateLogin, allowFuture: true }; }
  catch { return { graceMinutes: 15, maxPerMonth: 3, backdatedDays: 30, allowFuture: true, approvalRequired: false, attendanceMode: 'late_present', penaltyEnabled: false }; }
}

/** How many requests (pending or approved) the employee already has this month. */
async function monthlyCount(employeeId, month) {
  try {
    const { data } = await d365.getList(LATE, {
      select: 'hr_lateloginid,hr_status',
      filter: `hr_employeeid eq '${esc(employeeId)}' and hr_month eq '${esc(month)}'`, top: 200,
    });
    return (data || []).filter(r => !['rejected', 'cancelled'].includes(r.hr_status)).length;
  } catch { return 0; }
}

// ── email helpers (best-effort; never throw / block) ──────────────────────────
async function getEmployee(id) { try { return await d365.getByIdOptional(EMP, id, { select: 'hr_email,hr_hremployee1,hr_department', optionalSelect: '_hr_manager_value,hr_employeeid,hr_employeecode,hr_etimecode' }); } catch { return null; } }

/** The employee's SHIFT START ("HH:MM") — the SAME source of truth Attendance uses
 *  (attendance.config.resolveEmployeeShift). Never a hardcoded 09:00; when no shift is
 *  configured it falls back to the configured default shift. '' only on a lookup error. */
async function resolveShiftStart(employeeId) {
  try {
    const emp = await d365.getByIdOptional(EMP, employeeId, { select: 'hr_hremployeeid', optionalSelect: 'hr_shiftname,hr_shiftstarttime,hr_shiftendtime' });
    const attnCfg = require('./attendance.config');
    return attnCfg.resolveEmployeeShift(emp?.hr_shiftname, emp?.hr_shiftstarttime, emp?.hr_shiftendtime)?.start || '';
  } catch { return ''; }
}
async function hrEmails() {
  try {
    const { data } = await d365.getList(EMP, {
      select: 'hr_email',
      filter: `(hr_role eq ${toValue('hr_role', 'super_admin')} or hr_role eq ${toValue('hr_role', 'hr_manager')}) and hr_status eq ${toValue('hr_employee_status', 'active')}`,
    });
    return (data || []).map(e => e.hr_email).filter(Boolean);
  } catch { return []; }
}

const REQ_LABEL = { late_login: 'Late Login', early_logout: 'Early Logout', wfh: 'Work From Home', permission: 'Permission', on_duty: 'On Duty', client_visit: 'Client Visit', travel: 'Business Travel' };

// "Late By" from the submitted Expected vs Actual login times (minutes). null when a
// time is unparseable (then we DON'T suppress the email — fail open to sending).
const toMin = (hhmm) => { const m = String(hhmm || '').match(/(\d{1,2}):(\d{2})/); return m ? (+m[1]) * 60 + (+m[2]) : null; };
function lateByMinutes(expectedTime, actualTime) {
  const e = toMin(expectedTime), a = toMin(actualTime);
  if (e == null || a == null) return null;
  return a - e;   // >0 = late, <=0 = on time / early
}

/**
 * INFORMATION-ONLY email to HR after a Late Login is submitted (NO approval — no
 * Approve/Reject, no token, no manager). Sent FROM the submitting employee's own
 * company mailbox (dynamic sender, reused from Leave); TO = configured HR recipients.
 * Best-effort: a bad/absent employee mailbox is logged and skipped, never failing the
 * submission (the record is already saved by the time this runs).
 */
async function emailLateLoginInfoToHR({ employeeId, employeeName, date, expectedTime, actualTime, reason, remarks }) {
  const [emp, hrs] = await Promise.all([getEmployee(employeeId), hrEmails()]);
  const to = (hrs || []).filter(Boolean);
  if (!to.length) { global.logger?.warn?.('[late-login] HR info email skipped: no HR recipients'); return; }

  // Sender = the employee's OWN company mailbox (never a generic HR mailbox). If it is
  // missing/external, log and skip — Leave uses the exact same rule.
  const s = resolveSender({ email: emp?.hr_email, label: 'Employee' });
  if (!s.ok) { global.logger?.warn?.(`[late-login] HR info email skipped: ${s.reason}`); return; }
  const v = notif?.verifyMailbox ? await notif.verifyMailbox(s.sender) : { ok: true };
  if (!v.ok) { global.logger?.warn?.(`[late-login] HR info email skipped: ${v.reason}`); return; }

  const { subject, html } = T.lateLoginInfo({
    // Show the HUMAN Employee ID (EMP1039), never the Dataverse GUID passed in as employeeId.
    employeeName: employeeName || emp?.hr_hremployee1 || '', employeeId: requestNotify.employeeIdOf(emp) || '—',
    department: emp?.hr_department || '', date: time.fmtDate(date),
    // Display 12-hour times (4:30 PM / 11:30 PM) — AM/PM preserved from the stored 24h
    // value; Late By is computed from the raw 24h times.
    expectedTime: time.to12h(expectedTime) || expectedTime, actualTime: time.to12h(actualTime) || actualTime,
    lateBy: lateByMinutes(expectedTime, actualTime), reason, remarks,
  });
  const r = await notif.sendEmail(to, subject, html, { from: s.sender, saveToSentItems: false, meta: { type: 'late_login_info' } });
  global.logger?.[r?.success ? 'info' : 'error'](`[late-login] HR info email FROM ${s.sender} → ${to.join(',')}: ${r?.success ? 'sent' : (r?.error || 'failed')}`);
}

/** Does the employee have ANY punch (a valid Check-In) on `date`? Reads attendance in
 *  the company timezone. Best-effort → false on any read failure (never blocks). */
async function hasCheckIn(employeeId, date) {
  try {
    const ds = String(date).slice(0, 10);
    const { data } = await d365.getList(ATT, {
      select: ATT_PUNCH_SELECT,
      filter: `_hr_hremployee_value eq '${esc(employeeId)}' and hr_date eq ${ds}`, top: 5,
    });
    return (data || []).some(r => punchesFromRecord(r).length > 0);
  } catch (e) { global.logger?.warn?.(`[late-login] check-in lookup failed for ${employeeId}/${date}: ${e.message}`); return false; }
}

/** "Leave Request Required" email to the EMPLOYEE — ONE per (employee, date) via the
 *  notification ledger, so re-runs / multiple PM2 workers / restarts never duplicate it. */
async function emailLeaveRequired(row) {
  const emp = await getEmployee(row.employeeId);
  if (!emp?.hr_email || requestNotify.isPlaceholderEmail(emp.hr_email)) { global.logger?.warn?.(`[late-login] leave-required email skipped: no employee mailbox (${row.employeeId})`); return { skipped: true }; }
  const { subject, html } = T.lateLoginLeaveRequired({ employeeName: emp.hr_hremployee1 || row.employeeName || '', date: time.fmtDate(row.date) });
  return ledger.sendOnce({
    employeeId: row.employeeId, date: row.date, type: 'LATE_LOGIN_LEAVE_REQUIRED',
    to: emp.hr_email, subject, html, entity: 'attendance',
  });
}

/**
 * Daily attendance verification for Late Login requests dated TODAY (company TZ).
 * For each of today's records not already finalised: if a valid Check-In exists →
 * mark 'completed'; otherwise → mark 'absent_leave_required' and email the employee to
 * apply Leave (deduped by the ledger). Safe under PM2 (the scheduler runs on one
 * instance) AND idempotent (the ledger + status guard) so a re-run never re-emails.
 */
async function verifyTodaysAttendance() {
  const ds = today();
  let rows = [];
  try { rows = await list({ from: ds, to: ds }); }
  catch (e) { global.logger?.error?.(`[late-login] daily verify read failed: ${e.message}`); return { processed: 0, attended: 0, absent: 0 }; }

  let attended = 0, absent = 0;
  for (const r of rows) {
    if (['cancelled', 'completed', 'absent_leave_required', 'rejected'].includes(r.status)) continue;   // already handled
    const present = await hasCheckIn(r.employeeId, ds);
    try {
      if (present) { await d365.update(LATE, r.id, { hr_status: 'completed' }); attended++; }
      else {
        await d365.update(LATE, r.id, { hr_status: 'absent_leave_required' });
        await emailLeaveRequired(r);
        absent++;
      }
    } catch (e) { global.logger?.warn?.(`[late-login] daily verify failed for ${r.id}: ${e.message}`); }
  }
  global.logger?.info?.(`[late-login] daily verify ${ds}: ${rows.length} record(s), attended ${attended}, absent ${absent}`);
  return { processed: rows.length, attended, absent };
}

/**
 * Create a request. Returns { record, warning }. Validates the date window
 * (backdated ≤ setting; future only when allowed). `warning` is set when the
 * monthly limit is exceeded (submission still proceeds; HR keeps authority).
 */
async function create({ employeeId, employeeName, date, expectedTime, actualTime, reason, remarks, attachmentId, requestType = 'late_login', ip, createdBy }) {
  const ds = String(date || '').slice(0, 10);
  const p = await policy();
  const t = today();
  // Future / backdated validation (spec §3/§4).
  if (ds > t && !p.allowFuture) { const e = new Error('Future Late Login requests are not allowed.'); e.status = 400; throw e; }
  const earliest = addDays(t, -(Number(p.backdatedDays) || 30));
  if (ds < earliest) { const e = new Error(`You can submit Late Login requests only within the previous ${Number(p.backdatedDays) || 30} days.`); e.status = 400; throw e; }

  // DUPLICATE GUARD (backend-enforced, never rely on the UI): one ACTIVE Late Login per
  // employee + date. Any existing non-cancelled record for the same day blocks a new one.
  try {
    const { data: dup } = await d365.getList(LATE, {
      select: 'hr_lateloginid,hr_status',
      filter: `hr_employeeid eq '${esc(employeeId)}' and hr_date eq '${esc(ds)}' and hr_status ne 'cancelled'`, top: 1,
    });
    if (dup && dup[0]) { const e = new Error('A Late Login request already exists for this date.'); e.status = 409; throw e; }
  } catch (err) { if (err.status) throw err; /* lookup failure (e.g. table not provisioned) must not block a legit submit */ }

  const month = ds.slice(0, 7);
  const priorCount = await monthlyCount(employeeId, month);
  const warning = (priorCount + 1) > Number(p.maxPerMonth || 0)
    ? `This is Late Login #${priorCount + 1} this month, exceeding the limit of ${p.maxPerMonth}.`
    : '';
  const name = employeeName || '';
  // Shift Start Time is AUTHORITATIVE from the shift config (source of truth), not the
  // client — the form shows it read-only, but never trust a submitted value. Fall back
  // to the client value only if the lookup fails.
  const shiftStart = (await resolveShiftStart(employeeId)) || String(expectedTime || '');
  // Late Login Time must be LATER than Shift Start (else Late By is negative / "-"). This
  // also catches an AM/PM mistake (e.g. 11:30 AM entered against a 4:30 PM shift).
  const sMin = toMin(shiftStart), aMin = toMin(actualTime);
  if (sMin != null && aMin != null && aMin <= sMin) {
    const e = new Error('Late Login Time must be later than Shift Start Time.'); e.status = 400; throw e;
  }
  // Late Login is an INFORMATION record — NOT an approval workflow. New records are
  // always 'submitted' (never pending/approved/rejected). The daily verification job
  // later moves them to 'completed' or 'absent_leave_required'. Attachment is not
  // stored for Late Login (the column stays for backward compatibility).
  let payload = {
    hr_name: `${name || employeeId} · ${REQ_LABEL[requestType] || 'Late Login'} · ${ds}`.slice(0, 250),
    hr_employeeid: String(employeeId), hr_employeename: name, hr_date: ds, hr_month: month,
    hr_expectedtime: String(shiftStart || ''), hr_actualtime: String(actualTime || ''),
    hr_reason: reason || '', hr_remarks: remarks || '',
    hr_status: 'submitted', hr_managerstatus: '',
    hr_createdby: createdBy || '', hr_requesttype: requestType || 'late_login',
    hr_ip: ip || '',
  };
  // Resilient create — strip a not-yet-provisioned optional column and retry.
  let created;
  for (let i = 0; i < 5; i++) {
    try { created = await d365.create(LATE, payload); break; }
    catch (err) {
      if (d365._isMissingProperty?.(err)) { const prop = d365._missingPropertyName?.(err); if (prop && payload[prop] !== undefined) { delete payload[prop]; continue; } }
      throw err;
    }
  }

  const label = REQ_LABEL[requestType] || 'Late Login';
  notifyUser(employeeId, 'latelogin:submitted', { date: ds });
  broadcast('latelogin:submitted', { employeeName: name, date: ds });
  audit({ category: 'Attendance', type: 'latelogin_submitted', title: `${label} submitted`, name, meta: { date: ds, requestType, ip, exceeded: !!warning } });

  // INFORMATION-ONLY email to HR (from the employee's mailbox). Fire-and-forget: a mail
  // failure never blocks or fails the submission — the record is already saved.
  emailLateLoginInfoToHR({ employeeId, employeeName: name, date: ds, expectedTime: shiftStart, actualTime, reason, remarks })
    .catch(e => global.logger?.warn?.(`[late-login] HR info email error: ${e.message}`));

  return { record: shape({ ...payload, hr_lateloginid: created.hr_lateloginid }), warning };
}

// Employee cancels their own submitted request (or HR).
async function cancel(id, by) {
  const row = await getRaw(id);
  await d365.update(LATE, id, { hr_status: 'cancelled' });
  audit({ category: 'Attendance', type: 'latelogin_cancelled', title: 'Late Login cancelled', name: row.hr_employeename, meta: { by: by?.name } });
  return shape({ ...row, hr_status: 'cancelled' });
}

/** Dashboard counts for an employee (or all, for HR). */
async function summary({ employeeId, month } = {}) {
  const rows = await list({ employeeId, month });
  const n = (s) => rows.filter(r => r.status === s).length;
  return {
    total: rows.length,
    submitted: n('submitted'),
    completed: n('completed'),
    absentLeaveRequired: n('absent_leave_required'),
    cancelled: n('cancelled'),
    // legacy statuses (records created before Late Login became information-only)
    pending: n('pending'), approved: n('approved'), rejected: n('rejected'),
  };
}

// A recorded late login means the employee was PRESENT-but-late that day: 'submitted'
// (claimed), 'completed' (verified check-in) — plus legacy 'approved'. It is NOT
// 'absent_leave_required' / 'rejected' / 'cancelled'. Used only to LABEL the attendance
// grid ("Late Present"); it never changes the computed attendance status.
const PRESENT_LATE_STATUSES = `(hr_status eq 'submitted' or hr_status eq 'completed' or hr_status eq 'approved')`;

/** Is there a recorded (present-late) late login for this employee on this date? */
async function approvedOn(employeeId, date) {
  try {
    const { data } = await d365.getList(LATE, {
      select: 'hr_lateloginid',
      filter: `hr_employeeid eq '${esc(employeeId)}' and hr_date eq '${esc(String(date).slice(0, 10))}' and ${PRESENT_LATE_STATUSES}`, top: 1,
    });
    return !!(data && data[0]);
  } catch { return false; }
}

/**
 * A Set of `${employeeId}|${date}` for every present-late late login in a window —
 * used by the attendance list to label days without extra per-row queries.
 * Best-effort: any failure (e.g. table not yet provisioned) yields an empty Set.
 */
async function approvedSet({ from, to, employeeId } = {}) {
  try {
    const filters = [PRESENT_LATE_STATUSES];
    if (employeeId) filters.push(`hr_employeeid eq '${esc(employeeId)}'`);
    if (from) filters.push(`hr_date ge '${esc(String(from).slice(0, 10))}'`);
    if (to) filters.push(`hr_date le '${esc(String(to).slice(0, 10))}'`);
    const { data } = await d365.getList(LATE, { select: 'hr_employeeid,hr_date', filter: filters.join(' and '), top: 5000 });
    return new Set((data || []).map(r => `${r.hr_employeeid}|${String(r.hr_date || '').slice(0, 10)}`));
  } catch { return new Set(); }
}

module.exports = {
  list, getRaw, shape, create, cancel, monthlyCount, summary, approvedOn, approvedSet, policy, REQ_LABEL,
  lateByMinutes, emailLateLoginInfoToHR, emailLeaveRequired, hasCheckIn, verifyTodaysAttendance, resolveShiftStart,
};
