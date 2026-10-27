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
const PP = require('./permission-policy.service');                // monthly tier policy + CL debit
const { withKeyLock } = require('./concurrency.util');            // process-local per-event serialisation
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

// OData clause for the request-type filter. Legacy Late Login rows created before hr_requesttype
// was populated have a NULL type; they ARE late-login records (the table only ever held those),
// so a late_login query must INCLUDE null-typed rows — otherwise those rows silently disappear
// from the list/counts. Early Logout stays strict (eq) so null-typed legacy rows never leak into
// it. Returns null when no type filter applies.
const typeClause = (requestType) => {
  if (!requestType) return null;
  if (requestType === 'late_login') return `(hr_requesttype eq 'late_login' or hr_requesttype eq null)`;
  return `hr_requesttype eq '${esc(requestType)}'`;
};

async function list({ employeeId, month, status, requestType, from, to } = {}) {
  const filters = [];
  if (employeeId) filters.push(`hr_employeeid eq '${esc(employeeId)}'`);
  if (month) filters.push(`hr_month eq '${esc(month)}'`);
  if (status) filters.push(`hr_status eq '${esc(status)}'`);
  const tc = typeClause(requestType);
  if (tc) filters.push(tc);
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

/** How many active requests (of this type) the employee already has this month. */
async function monthlyCount(employeeId, month, requestType) {
  try {
    const tc = typeClause(requestType);
    const typeFilter = tc ? ` and ${tc}` : '';
    const { data } = await d365.getList(LATE, {
      select: 'hr_lateloginid,hr_status',
      filter: `hr_employeeid eq '${esc(employeeId)}' and hr_month eq '${esc(month)}'${typeFilter}`, top: 200,
    });
    return (data || []).filter(r => !['rejected', 'cancelled'].includes(r.hr_status)).length;
  } catch { return 0; }
}

/** QUALIFYING events this month for a type (drives the monthly tier; a rejected 3rd request
 *  and cancellations never count — spec §2). */
async function qualifyingCount(employeeId, month, requestType) {
  try {
    const tc = typeClause(requestType);
    const typeFilter = tc ? ` and ${tc}` : '';
    const { data } = await d365.getList(LATE, {
      select: 'hr_lateloginid,hr_status',
      filter: `hr_employeeid eq '${esc(employeeId)}' and hr_month eq '${esc(month)}'${typeFilter}`, top: 200,
    });
    return (data || []).filter(r => PP.isQualifying(r.hr_status)).length;
  } catch { return 0; }
}

/** Monthly usage snapshot for the UI/policy route: qualifying count + remaining auto permissions. */
async function monthlyUsage(employeeId, month, requestType) {
  const used = await qualifyingCount(employeeId, month, requestType);
  return {
    used,
    autoApprovals: PP.POLICY.autoApprovals,
    autoRemaining: Math.max(0, PP.POLICY.autoApprovals - used),
    managerApprovalAt: PP.POLICY.managerApprovalAt,
    clPerEvent: PP.POLICY.clPerEvent,
    effectiveFrom: PP.POLICY.effectiveFrom,
  };
}

// ── email helpers (best-effort; never throw / block) ──────────────────────────
async function getEmployee(id) { try { return await d365.getByIdOptional(EMP, id, { select: 'hr_email,hr_hremployee1,hr_department', optionalSelect: '_hr_manager_value,hr_employeeid,hr_employeecode,hr_etimecode' }); } catch { return null; } }
// The employee's reporting-manager email (for policy approval notifications). '' if none.
// Note: this HRMS has no distinct "manager" login role — HR/Admin perform approvals — so the
// manager is notified for awareness while the authorized decision is made via the approve/
// reject endpoints (latelogin.approve / earlylogout.approve permissions). Best-effort.
async function managerEmailFor(employeeId) {
  try {
    const emp = await getEmployee(employeeId);
    const mid = emp?._hr_manager_value;
    if (!mid) return '';
    const mgr = await d365.getByIdOptional(EMP, mid, { select: 'hr_email' });
    return mgr?.hr_email || '';
  } catch { return ''; }
}

/** The employee's SHIFT START ("HH:MM") — the SAME source of truth Attendance uses
 *  (attendance.config.resolveEmployeeShift). Never a hardcoded 09:00; when no shift is
 *  configured it falls back to the configured default shift. '' only on a lookup error. */
async function resolveShiftStart(employeeId, date) {
  try {
    const emp = await d365.getByIdOptional(EMP, employeeId, { select: 'hr_hremployeeid', optionalSelect: 'hr_shiftname,hr_shiftstarttime,hr_shiftendtime' });
    // When a date is given, use the shift EFFECTIVE on that date (history-aware) so a
    // backdated Late Login is measured against the shift the employee actually worked;
    // the just-fetched employee record is the fallback when there is no history.
    if (date) {
      const s = await require('./shift-history.service').resolveShiftForDate(employeeId, String(date).slice(0, 10), emp);
      return s?.start || '';
    }
    const attnCfg = require('./attendance.config');
    return attnCfg.resolveEmployeeShift(emp?.hr_shiftname, emp?.hr_shiftstarttime, emp?.hr_shiftendtime)?.start || '';
  } catch { return ''; }
}

/** The employee's full shift WINDOW { start, end } ("HH:MM") effective on `date` — the
 *  SAME source Attendance/Late Login use (history-aware, with the configured default as
 *  fallback). Both '' only on a lookup error. Early Logout measures "early by" against the
 *  shift END, so it needs the end; Late Login uses start. One lookup serves both. */
async function resolveShiftWindow(employeeId, date) {
  try {
    const emp = await d365.getByIdOptional(EMP, employeeId, { select: 'hr_hremployeeid', optionalSelect: 'hr_shiftname,hr_shiftstarttime,hr_shiftendtime' });
    if (date) {
      const s = await require('./shift-history.service').resolveShiftForDate(employeeId, String(date).slice(0, 10), emp);
      return { start: s?.start || '', end: s?.end || '' };
    }
    const attnCfg = require('./attendance.config');
    const s = attnCfg.resolveEmployeeShift(emp?.hr_shiftname, emp?.hr_shiftstarttime, emp?.hr_shiftendtime);
    return { start: s?.start || '', end: s?.end || '' };
  } catch { return { start: '', end: '' }; }
}
/** The employee's SHIFT END ("HH:MM") — the reference point for Early Logout. */
async function resolveShiftEnd(employeeId, date) { return (await resolveShiftWindow(employeeId, date)).end; }
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

// ── Permission window (spec: Late Login AND Early Logout) ─────────────────────
// Up to and INCLUDING 2 hours → a permission request is allowed; MORE than 2 hours
// → blocked (the employee must apply for Leave instead). Enforced server-side here
// (never rely on the UI); the UI mirrors the same rule and message.
const MAX_PERMISSION_MINUTES = 120;
const LIMIT_MESSAGE = 'Permission is allowed only up to 2 hours. Please apply for leave for a longer duration.';

/**
 * Evaluate a Late Login / Early Logout against the employee's shift — PURE & overnight-aware.
 *   late_login : how LATE the login is  (login − shift START)
 *   early_logout: how EARLY the logout is (shift END − logout)
 * Returns { minutes, error, skipped }:
 *   error 'range' → the time is on the wrong side of the shift (not late / not early at all)
 *   error 'limit' → within the shift but MORE than 2 hours → must apply for leave
 *   error null    → OK; `minutes` is the late-by / early-by (1..120)
 *   skipped true  → not enough shift context to validate (fail-open; never blocks a legit submit)
 * When the shift END is known, times are placed on an overnight-aware timeline so a shift
 * that crosses midnight (e.g. 22:00–06:00) is measured correctly. Without a configured end
 * it falls back to a same-day comparison (legacy Late Login behaviour, overnight unsupported).
 */
function evaluatePermission({ requestType, shiftStart, shiftEnd, time }) {
  const isEarly = requestType === 'early_logout';
  const sMin = toMin(shiftStart), eMin = toMin(shiftEnd), tMin = toMin(time);
  if (sMin == null || tMin == null) return { minutes: null, error: null, skipped: true };

  if (eMin != null) {
    // Overnight-aware: endAbs = shift end on a timeline that starts at sMin (adds a day when
    // the shift crosses midnight; a 0-length end is treated as a full 24h shift). Each clock
    // time is mapped into [sMin, sMin+1440) the same way.
    const endAbs = sMin + ((((eMin - sMin) % 1440) + 1440) % 1440 || 1440);
    const tAbs = sMin + (((tMin - sMin) % 1440) + 1440) % 1440;
    if (isEarly) {
      if (tAbs <= sMin || tAbs >= endAbs) return { minutes: null, error: 'range' };   // not before shift end
      const early = endAbs - tAbs;
      return early > MAX_PERMISSION_MINUTES ? { minutes: early, error: 'limit' } : { minutes: early, error: null };
    }
    if (tAbs <= sMin || tAbs > endAbs) return { minutes: null, error: 'range' };       // not after shift start / outside shift
    const late = tAbs - sMin;
    return late > MAX_PERMISSION_MINUTES ? { minutes: late, error: 'limit' } : { minutes: late, error: null };
  }

  // Fallback with no configured shift end (legacy same-day semantics).
  if (isEarly) return { minutes: null, error: null, skipped: true };   // need an end to measure "early" — fail-open
  if (tMin <= sMin) return { minutes: null, error: 'range' };
  const late = tMin - sMin;
  return late > MAX_PERMISSION_MINUTES ? { minutes: late, error: 'limit' } : { minutes: late, error: null };
}

// The user-facing "wrong side of the shift" message per request type.
const rangeMessage = (requestType) => requestType === 'early_logout'
  ? 'Logout Time must be earlier than Shift End Time.'
  : 'Late Login Time must be later than Shift Start Time.';

/**
 * Minutes a request is past its shift reference, from JUST the reference + the time
 * (overnight-safe via forward wrap): late-by (shift START → login) or early-by
 * (logout → shift END). 0 = on the boundary (invalid), >120 = beyond the 2h window.
 * Used by the EDIT path, where only the stored reference time is on hand (create() uses
 * the richer, window-aware evaluatePermission). null when a time is unparseable.
 */
function permissionMinutes({ requestType, ref, time }) {
  const r = toMin(ref), t = toMin(time);
  if (r == null || t == null) return null;
  return requestType === 'early_logout'
    ? (((r - t) % 1440) + 1440) % 1440    // logout → shift END
    : (((t - r) % 1440) + 1440) % 1440;   // shift START → login
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
  // Only Late Login records are attendance-verified (check-in → completed / absent-leave).
  // Early Logout is a standalone permission record and is NOT touched by this job.
  try { rows = await list({ from: ds, to: ds, requestType: 'late_login' }); }
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
  const label = REQ_LABEL[requestType] || 'Late Login';
  const isEarly = requestType === 'early_logout';
  const p = await policy();
  const t = today();
  // Future / backdated validation (spec §3/§4).
  if (ds > t && !p.allowFuture) { const e = new Error(`Future ${label} requests are not allowed.`); e.status = 400; throw e; }
  const earliest = addDays(t, -(Number(p.backdatedDays) || 30));
  if (ds < earliest) { const e = new Error(`You can submit ${label} requests only within the previous ${Number(p.backdatedDays) || 30} days.`); e.status = 400; throw e; }

  // DUPLICATE GUARD (backend-enforced, never rely on the UI): one ACTIVE request per
  // employee + date + TYPE. Scoping by type lets an employee have (at most) one Late Login
  // AND one Early Logout on the same day — both are legitimate — while still blocking a
  // second of the same kind.
  const month = ds.slice(0, 7);
  const name = employeeName || '';
  // Shift window is AUTHORITATIVE from the shift config (source of truth), not the client —
  // the form shows it read-only, but a submitted value is never trusted. Late Login is
  // measured against the shift START; Early Logout against the shift END. (Pure validation —
  // computed BEFORE the per-event lock since it needs no serialisation.)
  const window = await resolveShiftWindow(employeeId, ds);
  const shiftStart = window.start || (isEarly ? '' : String(expectedTime || ''));
  const shiftEnd = window.end || '';
  const refTime = isEarly ? shiftEnd : shiftStart;   // stored in hr_expectedtime (authoritative reference)

  // 2-HOUR PERMISSION RULE (spec §2) + wrong-side-of-shift guard — enforced server-side
  // (the UI mirrors it). Validated only when the shift reference resolved; a shift-lookup
  // miss fails open (never blocks a legitimate submit), matching this service's resilience.
  if (refTime) {
    const ev = evaluatePermission({ requestType, shiftStart, shiftEnd, time: actualTime });
    if (!ev.skipped) {
      if (ev.error === 'range') { const e = new Error(rangeMessage(requestType)); e.status = 400; throw e; }
      if (ev.error === 'limit') { const e = new Error(LIMIT_MESSAGE); e.status = 400; throw e; }
    }
  }
  const policyActive = PP.effectiveFor(ds);

  // ── Dedupe-critical section, serialised per (type, employee, date) WITHIN this process ──
  // The duplicate guard, tier decision, CL debit, and record create run under a process-local
  // lock so two submissions on the SAME worker for the same event cannot interleave. Under PM2
  // cluster (2 workers) this does NOT serialise a submission on another worker or the scanner on
  // instance 0 — the CL debit stays event-keyed/idempotent and the daily scan reconciles the net,
  // so the financial outcome is safe; see the residual-risk note in the report.
  const lockKey = `late:${requestType}:${employeeId}:${ds}`;
  const result = await withKeyLock(lockKey, async () => {
    // DUPLICATE GUARD (backend-enforced): one ACTIVE request per employee + date + TYPE.
    try {
      const { data: dup } = await d365.getList(LATE, {
        select: 'hr_lateloginid,hr_status',
        filter: `hr_employeeid eq '${esc(employeeId)}' and hr_date eq '${esc(ds)}' and hr_requesttype eq '${esc(requestType)}' and hr_status ne 'cancelled'`, top: 1,
      });
      if (dup && dup[0]) { const e = new Error(`A ${label} request already exists for this date.`); e.status = 409; throw e; }
    } catch (err) { if (err.status) throw err; /* lookup failure (e.g. table not provisioned) must not block a legit submit */ }

    // ── Monthly permission policy (effective 2026-11-01), applied PER TYPE (spec §2) ──
    // Pre-effective dates keep the legacy information-only behaviour ('submitted'). From the
    // effective date the Nth QUALIFYING event this month decides the outcome. NO attendance
    // punch is ever inserted/modified and no attendance status changes — this only sets the
    // permission record's own workflow state (+ a CL ledger debit for the 4th+ event).
    let decision = null, warning = '';
    let finalStatus = 'submitted', finalManagerStatus = '';
    if (policyActive) {
      const priorQualifying = await qualifyingCount(employeeId, month, requestType);
      decision = PP.decide(priorQualifying);
      // Revised policy: EVERY qualifying event is auto-approved — NO leave or salary penalty is
      // ever applied. Only the notification stage escalates (handled by notifyPolicyOutcome).
      finalStatus = PP.STATUS.AUTO_APPROVED;
      warning = policyWarningText(decision, label);
    }
    const payloadInner = {
      hr_name: `${name || employeeId} · ${label} · ${ds}`.slice(0, 250),
      hr_employeeid: String(employeeId), hr_employeename: name, hr_date: ds, hr_month: month,
      hr_expectedtime: String(refTime || ''), hr_actualtime: String(actualTime || ''),
      hr_reason: reason || '', hr_remarks: remarks || '',
      hr_status: finalStatus, hr_managerstatus: finalManagerStatus,
      hr_createdby: createdBy || '', hr_requesttype: requestType || 'late_login',
      hr_ip: ip || '',
    };
    // Resilient create — strip a not-yet-provisioned optional column and retry.
    let createdInner;
    for (let i = 0; i < 5; i++) {
      try { createdInner = await d365.create(LATE, payloadInner); break; }
      catch (err) {
        if (d365._isMissingProperty?.(err)) { const prop = d365._missingPropertyName?.(err); if (prop && payloadInner[prop] !== undefined) { delete payloadInner[prop]; continue; } }
        throw err;
      }
    }
    return { created: createdInner, payload: payloadInner, decision, warning };
  });
  const { created, payload, decision, warning } = result;

  notifyUser(employeeId, 'latelogin:submitted', { date: ds });
  broadcast('latelogin:submitted', { employeeName: name, date: ds });
  audit({ category: 'Attendance', type: 'latelogin_submitted', title: `${label} submitted`, name, meta: { date: ds, requestType, ip, status: payload.hr_status, policyEvent: decision?.n, outcome: decision?.outcome } });

  if (policyActive) {
    // The employee SUBMITTED a request (requested:true): 1st–3rd send a normal confirmation (no
    // "no-request" warning); 4th+ send the existing HR/Super Admin/escalation emails unchanged.
    notifyPolicyOutcome({ employeeId, name, label, requestType, date: ds, status: payload.hr_status, decision, requested: true })
      .catch(e => global.logger?.warn?.(`[late-login] policy notify error: ${e.message}`));
  } else if (!isEarly) {
    // Legacy (pre-effective) Late Login → the existing information-only HR email.
    emailLateLoginInfoToHR({ employeeId, employeeName: name, date: ds, expectedTime: shiftStart, actualTime, reason, remarks })
      .catch(e => global.logger?.warn?.(`[late-login] HR info email error: ${e.message}`));
  }

  return { record: shape({ ...payload, hr_lateloginid: created.hr_lateloginid }), warning };
}

// Short banner returned to the submitter (toast). Never mentions a penalty — there is none.
function policyWarningText(decision, label) {
  switch (decision?.stage) {
    case 'hr_warning': return `This is your 4th ${label} this month — an HR warning has been sent. Please arrive on time going forward.`;
    case 'final_warning': return `This is your 5th ${label} this month — a FINAL warning has been sent. Please correct your arrival time.`;
    case 'escalation': return `This is ${label} #${decision.n} this month — please contact HR or your manager to discuss repeated late arrivals.`;
    default: return '';
  }
}

// Super Admin recipients = employees with the super_admin ROLE (reliable, config-free). '' list
// on error. (There is no separate "Super Admin mailbox" — the role query IS the mechanism.)
async function superAdminEmails() {
  try {
    const { data } = await d365.getList(EMP, {
      select: 'hr_email',
      filter: `hr_role eq ${toValue('hr_role', 'super_admin')} and hr_status eq ${toValue('hr_employee_status', 'active')}`,
    });
    return (data || []).map(e => e.hr_email).filter(Boolean);
  } catch { return []; }
}

/**
 * Stage-based policy notification (revised policy — NO penalty wording ever). Every email is
 * idempotent via the notification ledger (employee + date + type), so retries, re-scans and
 * multiple workers never duplicate, and a failed send is recorded 'failed' (retryable), never
 * 'sent'. `requested` = did the employee SUBMIT a Late Login request for this real-world event?
 *
 *   1st–3rd (no escalation stage) — keyed per EVENT (the event DATE, so each of the three
 *            distinct events gets its own notification; a monthly-count key would wrongly
 *            suppress the 2nd/3rd):
 *      • requested  → a normal confirmation that the request was recorded/auto-approved.
 *      • !requested → a "late without submitting a request" warning (employee only).
 *   4th  → HR warning to the employee (+ HR recipients)            — keyed per MONTH.
 *   5th  → FINAL warning via the Super Admin role recipients (+ employee) — keyed per MONTH.
 *   6th+ → escalation to contact HR/manager (+ manager + HR)       — keyed per EVENT COUNT.
 * The 4th/5th/6th+ stages fire regardless of `requested`. Best-effort; never throws.
 */
async function notifyPolicyOutcome({ employeeId, name, label, requestType, date, decision, requested = false }) {
  try {
    const stage = decision?.stage || null;
    const n = decision?.n;
    const month = String(date).slice(0, 7);
    const eventDate = String(date).slice(0, 10);   // per-event idempotency key (1st–3rd)
    const monthKeyDate = `${month}-01`;            // per-month idempotency key (4th / 5th)
    const emp = await getEmployee(employeeId);
    const empTo = emp?.hr_email && !requestNotify.isPlaceholderEmail(emp.hr_email) ? emp.hr_email : null;
    const prettyMonth = time.fmtDate(`${month}-01`).replace(/^\d+ /, '');   // e.g. "November 2026"
    const prettyDate = time.fmtDate(eventDate);
    const footer = `<p style="color:#6b7280;font-size:12px;">CRMONCE HRMS · ${label} · ${prettyMonth}${n != null ? ` · event #${n}` : ''}</p>`;
    const send = (keyDate, to, cc, type, subject, body) => ledger.sendOnce({
      employeeId, date: keyDate, type, to, cc, subject,
      html: `<p>Dear ${esc(name || 'Employee')},</p>${body}${footer}`, entity: 'attendance',
    }).catch((e) => global.logger?.warn?.(`[late-login] email (${type}) failed: ${e.message}`));

    if (!stage) {
      // 1st–3rd qualifying event. Keyed by the EVENT DATE so the three distinct events are not
      // collapsed onto a single monthly key (spec §3). No HR/salary/leave action at this tier.
      if (requested) {
        await send(eventDate, empTo, null, 'LATE_LOGIN_CONFIRM',
          `${label} Recorded (${prettyDate})`,
          `<p>Your ${label.toLowerCase()} request for <b>${prettyDate}</b> has been <b>recorded and auto-approved</b> under the monthly policy. No leave or salary is deducted.</p>`);
      } else {
        await send(eventDate, empTo, null, 'LATE_LOGIN_NO_REQUEST',
          `${label} Without a Request (${prettyDate})`,
          `<p>Our attendance system recorded a <b>late login on ${prettyDate}</b> for which <b>no ${label} request was submitted</b>. Please submit a ${label} request when you arrive late. This notice is for your information — no leave or salary is deducted.</p>`);
      }
      return;
    }

    if (stage === 'hr_warning') {
      const hrs = await hrEmails();
      await send(monthKeyDate, empTo, hrs, 'LATE_LOGIN_HR_WARNING',
        `${label} — HR Warning (${prettyMonth})`,
        `<p>You have reached <b>four ${label.toLowerCase()}s</b> during ${prettyMonth}. Please ensure you arrive on time going forward.</p>`);
    } else if (stage === 'final_warning') {
      const admins = await superAdminEmails();
      await send(monthKeyDate, empTo, admins, 'LATE_LOGIN_FINAL_WARNING',
        `${label} — FINAL Warning (${prettyMonth})`,
        `<p>This is a <b>final warning</b> for repeated late arrival during ${prettyMonth} (${n} ${label.toLowerCase()}s). Immediate improvement is expected.</p>`);
    } else if (stage === 'escalation') {
      const mgr = await managerEmailFor(employeeId);
      const hrs = await hrEmails();
      const cc = [...new Set([mgr, ...(hrs || [])])].filter(Boolean);
      await send(`${month}-01`, empTo, cc, `LATE_LOGIN_ESCALATION_${n}`,   // per-count key → one per event, retry-safe
        `${label} — Please contact HR/Manager (${prettyMonth})`,
        `<p>You now have <b>${n} ${label.toLowerCase()}s</b> during ${prettyMonth}. Please <b>contact HR or your manager</b> to discuss the repeated late arrivals.</p>`);
    }
  } catch (e) { global.logger?.warn?.(`[late-login] notifyPolicyOutcome error: ${e.message}`); }
}

/**
 * Manager/HR decision on a 3rd (manager_pending) permission. 'approved' → manager_approved
 * (now counts); 'rejected' → manager_rejected (does NOT count). Employee is notified. No
 * attendance punch is touched.
 */
async function managerDecision(id, decision, by) {
  const row = await getRaw(id);
  if (String(row.hr_status) !== PP.STATUS.MANAGER_PENDING) {
    const e = new Error('Only a request pending manager approval can be decided.'); e.status = 409; throw e;
  }
  const status = decision === 'approved' ? PP.STATUS.MANAGER_APPROVED : PP.STATUS.MANAGER_REJECTED;
  await d365.update(LATE, id, { hr_status: status, hr_managerstatus: decision, hr_approvedby: by?.name || '', hr_approveddate: today() });
  const label = REQ_LABEL[row.hr_requesttype] || 'Late Login';
  audit({ category: 'Attendance', type: `permission_${decision}`, title: `${label} ${decision}`, name: row.hr_employeename, meta: { by: by?.name, id } });
  // Notify the employee of the decision (best-effort).
  (async () => {
    const emp = await getEmployee(row.hr_employeeid);
    const to = emp?.hr_email && !requestNotify.isPlaceholderEmail(emp.hr_email) ? emp.hr_email : null;
    if (to && notif?.sendEmail) {
      const msg = decision === 'approved'
        ? `Your ${label} on ${time.fmtDate(row.hr_date)} has been approved by ${by?.name || 'your manager'}.`
        : `Your ${label} on ${time.fmtDate(row.hr_date)} has been rejected by ${by?.name || 'your manager'}. It will not count toward your monthly permissions.`;
      try { await notif.sendEmail(to, `${label} ${decision === 'approved' ? 'Approved' : 'Rejected'} (${time.fmtDate(row.hr_date)})`, `<p>Dear ${esc(row.hr_employeename || 'Employee')},</p><p>${msg}</p>`, { meta: { type: 'permission_policy' } }); } catch (_) {}
    }
  })().catch(() => {});
  return shape({ ...row, hr_status: status, hr_managerstatus: decision, hr_approvedby: by?.name || '', hr_approveddate: today() });
}

// Employee cancels their own submitted request (or HR).
async function cancel(id, by) {
  const row = await getRaw(id);
  await d365.update(LATE, id, { hr_status: 'cancelled' });
  audit({ category: 'Attendance', type: 'latelogin_cancelled', title: 'Late Login cancelled', name: row.hr_employeename, meta: { by: by?.name } });
  return shape({ ...row, hr_status: 'cancelled' });
}

/** Dashboard counts for an employee (or all, for HR). */
async function summary({ employeeId, month, requestType } = {}) {
  const rows = await list({ employeeId, month, requestType });
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
// A recorded late login (present-but-late) in ANY of these states: legacy submitted/completed/
// approved, plus the policy states that still mean "a late login happened that day"
// (auto_approved, manager_pending/approved, cl_deducted, hr_review). manager_rejected and
// cancelled are NOT present-late.
const PRESENT_LATE_STATUSES = `(hr_status eq 'submitted' or hr_status eq 'completed' or hr_status eq 'approved' or hr_status eq 'auto_approved' or hr_status eq 'manager_pending' or hr_status eq 'manager_approved' or hr_status eq 'cl_deducted' or hr_status eq 'hr_review')`;
// The "Late Present" label is for LATE LOGIN only — the shared table also holds Early Logout
// permission records, which must NEVER label a day as late-present. `ne 'early_logout'` is
// null-safe in OData (a legacy row with no request type evaluates true), so older Late Login
// records keep their existing behaviour.
const NOT_EARLY_LOGOUT = `hr_requesttype ne 'early_logout'`;

/** Is there a recorded (present-late) late login for this employee on this date? */
async function approvedOn(employeeId, date) {
  try {
    const { data } = await d365.getList(LATE, {
      select: 'hr_lateloginid',
      filter: `hr_employeeid eq '${esc(employeeId)}' and hr_date eq '${esc(String(date).slice(0, 10))}' and ${PRESENT_LATE_STATUSES} and ${NOT_EARLY_LOGOUT}`, top: 1,
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
    const filters = [PRESENT_LATE_STATUSES, NOT_EARLY_LOGOUT];
    if (employeeId) filters.push(`hr_employeeid eq '${esc(employeeId)}'`);
    if (from) filters.push(`hr_date ge '${esc(String(from).slice(0, 10))}'`);
    if (to) filters.push(`hr_date le '${esc(String(to).slice(0, 10))}'`);
    const { data } = await d365.getList(LATE, { select: 'hr_employeeid,hr_date', filter: filters.join(' and '), top: 5000 });
    return new Set((data || []).map(r => `${r.hr_employeeid}|${String(r.hr_date || '').slice(0, 10)}`));
  } catch { return new Set(); }
}

// Marker that distinguishes a SCANNER-created (punch-only) record from an employee-submitted
// one — so the scanner can reconcile/reverse only its OWN records, and the UI can badge them.
const AUTO_CREATED_BY = 'Late Login Policy (auto)';

/** The non-cancelled late_login record for (employee, date), or null. Used by the scanner to
 *  reconcile a punch with an existing permission request → the SAME event is counted once.
 *  With { strict:true } a lookup FAILURE re-throws instead of returning null, so a caller can
 *  tell "no matching request exists" apart from "could not determine" — the latter must NOT be
 *  treated as a no-request event (spec §2: never warn when the request lookup is ambiguous). */
async function existingLateFor(employeeId, date, requestType = 'late_login', { strict = false } = {}) {
  try {
    const { data } = await d365.getList(LATE, {
      select: 'hr_lateloginid,hr_status,hr_createdby,hr_date,hr_employeeid,hr_employeename,hr_requesttype,hr_actualtime',
      filter: `hr_employeeid eq '${esc(employeeId)}' and hr_date eq '${esc(String(date).slice(0, 10))}' and hr_requesttype eq '${esc(requestType)}' and hr_status ne 'cancelled'`, top: 1,
    });
    return (data && data[0]) || null;
  } catch (e) { if (strict) throw e; return null; }
}

/**
 * Record a PUNCH-ONLY qualifying Late Login event (no permission request was submitted) and
 * apply the monthly tier: 1st/2nd auto_approved · 3rd manager_pending · 4th+ 0.5 CL debit or
 * hr_review. Creates an auto-tagged hr_lateLogin record (the auditable event identity) and
 * NEVER touches attendance punches. The CL debit is event-keyed (employee+date), so it can
 * never double with the request path. Returns { recordId, status, decision }.
 */
async function recordPunchLateEvent({ employeeId, employeeName, date, firstPunch, shiftStart, createdBy }) {
  const ds = String(date).slice(0, 10);
  const month = ds.slice(0, 7);
  const requestType = 'late_login';
  const name = employeeName || '';
  // DEFENCE IN DEPTH (spec §3): never create/penalise a pre-effective event, even if a caller
  // forgets the gate. The scanner already gates; this makes the function safe on its own.
  if (!PP.effectiveFor(ds)) return { skipped: 'pre_effective' };

  // Serialise per (type, employee, date) WITHIN this process, and RE-CHECK existence inside the
  // lock so two same-process scanner/record calls for one event cannot both create a record.
  // (Process-local only — see concurrency.util; cross-worker races rely on the event-keyed CL
  // debit + the daily reconciliation pass for financial safety.)
  const lockKey = `late:${requestType}:${employeeId}:${ds}`;
  return withKeyLock(lockKey, async () => {
    // STRICT: a lookup FAILURE here must abort (throw) — never fall through and create a record
    // (and a no-request warning) when we cannot confirm whether a matching request already exists.
    const already = await existingLateFor(employeeId, ds, requestType, { strict: true });
    if (already) return { recordId: already.hr_lateloginid, status: already.hr_status, skipped: 'exists' };

    const priorQualifying = await qualifyingCount(employeeId, month, requestType);
    const decision = PP.decide(priorQualifying);
    // Revised policy: always auto-approved, NO CL/salary penalty — only the notification escalates.
    const status = PP.STATUS.AUTO_APPROVED;
    const managerStatus = '';
    let payload = {
      hr_name: `${name || employeeId} · Late Login (auto) · ${ds}`.slice(0, 250),
      hr_employeeid: String(employeeId), hr_employeename: name, hr_date: ds, hr_month: month,
      hr_expectedtime: String(shiftStart || ''), hr_actualtime: String(firstPunch || ''),
      hr_reason: 'Auto-detected late punch-in (no permission request)', hr_remarks: `Punch-in ${firstPunch || ''}`,
      hr_status: status, hr_managerstatus: managerStatus,
      hr_createdby: AUTO_CREATED_BY, hr_requesttype: requestType, hr_ip: '',
    };
    let created;
    for (let i = 0; i < 5; i++) {
      try { created = await d365.create(LATE, payload); break; }
      catch (err) { if (d365._isMissingProperty?.(err)) { const prop = d365._missingPropertyName?.(err); if (prop && payload[prop] !== undefined) { delete payload[prop]; continue; } } throw err; }
    }
    audit({ category: 'Attendance', type: 'latelogin_auto_detected', title: 'Late Login auto-detected', name, meta: { date: ds, status, policyEvent: decision.n, outcome: decision.outcome } });
    // Punch-only event → the employee did NOT submit a request (requested:false): 1st–3rd send a
    // "late without a request" warning; 4th+ send the existing HR/Super Admin/escalation emails.
    notifyPolicyOutcome({ employeeId, name, label: 'Late Login', requestType, date: ds, status, decision, requested: false })
      .catch(e => global.logger?.warn?.(`[late-login] auto notify error: ${e.message}`));
    return { recordId: created.hr_lateloginid, status, decision };
  });
}

/** Cancel a SCANNER-created auto record when a later correction makes the day on-time. The
 *  revised policy applies NO leave/salary penalty, so this ONLY cancels the record — it never
 *  writes to the CL ledger. (Legacy penalty rows are never auto-reversed; they are flagged for an
 *  approved remediation plan by the reconciler.) Only auto records. */
async function reversePunchAutoRecord(record) {
  const id = record.hr_lateloginid;
  const ds = String(record.hr_date).slice(0, 10);
  try { await d365.update(LATE, id, { hr_status: 'cancelled', hr_remarks: 'Cancelled: attendance corrected to on-time (within grace)' }); } catch (e) { global.logger?.warn?.(`[late-login] auto cancel update failed for ${id}: ${e.message}`); }
  audit({ category: 'Attendance', type: 'latelogin_auto_cancelled', title: 'Late Login auto-cancelled (correction)', name: record.hr_employeename, meta: { date: ds } });
  return { cancelled: true };
}

module.exports = {
  list, getRaw, shape, create, cancel, monthlyCount, qualifyingCount, monthlyUsage, managerDecision,
  summary, approvedOn, approvedSet, policy, REQ_LABEL,
  lateByMinutes, emailLateLoginInfoToHR, emailLeaveRequired, hasCheckIn, verifyTodaysAttendance,
  resolveShiftStart, resolveShiftEnd, resolveShiftWindow,
  evaluatePermission, permissionMinutes, rangeMessage, MAX_PERMISSION_MINUTES, LIMIT_MESSAGE,
  existingLateFor, recordPunchLateEvent, reversePunchAutoRecord, AUTO_CREATED_BY,
  notifyPolicyOutcome,
};
