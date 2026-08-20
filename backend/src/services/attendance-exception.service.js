/**
 * Attendance Exception Management — detects missing-punch exceptions on completed
 * days and notifies employees professionally (Outlook email from info@crmonce.com
 * + in-app bell), with daily reminders and manager/HR escalation. Correction
 * requests NEVER block punching — this only surfaces PAST records for correction.
 *
 * Reminder cadence here is DAILY (the scan re-notifies unresolved exceptions each
 * run and stops once a correction request exists). Sub-day cadence (2h/6h) and a
 * full audit table are the documented Phase-2 additions (need hr_attendanceexceptions).
 */
const d365 = require('./d365.service');
const attnCfg = require('./attendance.config');
const time = require('./time.util');
const { computeSession, punchesFromRecord, LATE_ENTRY_GRACE_MIN } = require('./attendance.util');
const { detectExceptions } = require('./attendance-exception.util');
const templates = require('./email/templates');
const notification = require('./notification.service');
const requestNotify = require('./request-notify.service');
const ledger = require('./notification-ledger.service');
const ecfg = require('./email/config');

const ATT = d365.constructor.entities.attendance;
const EMP = d365.constructor.entities.employee;
const REQ = d365.constructor.entities.attendanceRequest;
const SHIFT_COLS = 'hr_shiftname,hr_shiftstarttime,hr_shiftendtime';
const PUNCH_SELECT = 'hr_hrattendanceid,hr_date,hr_allpunches,hr_intime,hr_outtime,hr_punchcount,_hr_hremployee_value';
const shiftOf = (e) => attnCfg.resolveEmployeeShift(e?.hr_shiftname, e?.hr_shiftstarttime, e?.hr_shiftendtime);
const appUrl = () => (process.env.FRONTEND_URL || process.env.APP_URL || 'https://hr.crmonce.com').replace(/\/$/, '');
const raiseUrl = () => `${appUrl()}/attendance-requests`;
const daysBetween = (a, b) => Math.round((new Date(`${b}T00:00:00Z`) - new Date(`${a}T00:00:00Z`)) / 86400000);

/** Dates (YYYY-MM-DD) that already have ANY correction request for this employee. */
async function requestedDates(employeeId, dates) {
  if (!dates.length) return new Set();
  try {
    const { data } = await d365.getList(REQ, {
      select: 'hr_attendancedate', filter: `hr_employeeid eq '${employeeId}'`, top: 500,
    });
    return new Set((data || []).map(r => String(r.hr_attendancedate || '').slice(0, 10)));
  } catch (_) { return new Set(); }   // table not provisioned yet → nothing requested
}

/** Exceptions for one employee over recent COMPLETED days (never today), minus any
 *  date that already has a correction request. Powers the dashboard Alerts card. */
async function openExceptionsForEmployee(employeeId, { days = 14 } = {}) {
  try {
    const today = time.istDateStr();
    const from = String(new Date(new Date(`${today}T00:00:00Z`).getTime() - days * 86400000).toISOString()).slice(0, 10);
    const [emp, recRes] = await Promise.all([
      d365.getByIdOptional(EMP, employeeId, { select: 'hr_hremployeeid', optionalSelect: SHIFT_COLS }).catch(() => ({})),
      d365.getList(ATT, { select: PUNCH_SELECT, filter: `_hr_hremployee_value eq '${employeeId}' and hr_date ge ${from} and hr_date lt ${today}`, orderby: 'hr_date desc', top: 60 }).catch(() => ({ data: [] })),
    ]);
    const shift = shiftOf(emp);
    const alerts = [];
    for (const r of (recRes.data || [])) {
      const c = computeSession(punchesFromRecord(r), shift);
      const [ex] = detectExceptions(c);
      if (ex) alerts.push({ date: String(r.hr_date).slice(0, 10), code: ex.code, label: ex.label, priority: ex.priority, punches: c.punches.map(p => p.t) });
    }
    const skip = await requestedDates(employeeId, alerts.map(a => a.date));
    return alerts.filter(a => !skip.has(a.date));
  } catch (_) { return []; }
}

/**
 * Missing-punch notification. The EMAIL is sent AT MOST ONCE per employee+date
 * (MISSING_PUNCH) via the ledger — so re-scans / recalc / dashboard refresh / payroll
 * never re-send it (§8). To = employee ONLY; a manager/HR CC is added only when the
 * company opted into escalation CC (default off — §7/§14). The in-app bell still
 * fires each scan (it is not an email and drives the dashboard alert).
 */
async function notifyException(emp, alert, { cc = [], shift, inTime, outTime } = {}) {
  const to = emp.hr_email;
  const dateLabel = time.fmtDate(alert.date);
  if (to && !requestNotify.isPlaceholderEmail(to)) {
    const { subject, html } = templates.missingPunch({
      employeeName: emp.hr_hremployee1, date: dateLabel, shift, inTime, outTime, raiseUrl: raiseUrl(),
    });
    const res = await ledger.sendOnce({
      employeeId: emp.hr_hremployeeid, date: alert.date, type: 'MISSING_PUNCH',
      to, cc: (cc || []).map(c => c.email).filter(Boolean), subject, html, entity: 'attendance',
    });   // `from` defaults to info@crmonce.com (GRAPH_SENDER)
    global.logger?.info?.(`[exception] missing-punch → ${to} (${alert.code} on ${alert.date}): ${res.sent ? 'sent' : (res.skipped ? `skipped(${res.reason})` : (res.error || 'failed'))}`);
  }
  // In-app bell.
  try {
    notification.notifyUser(emp.hr_hremployeeid, 'attendance:alert', {
      type: 'attendance_exception', title: 'Attendance Alert',
      message: `${alert.label} detected on ${dateLabel}. Action required.`, date: alert.date, code: alert.code,
    });
  } catch (_) {}
}

/** Late-login informational notice — ONE per employee+date (LATE_LOGIN), employee
 *  only. Opt-in via config.notify.lateLoginNotice. Deduped by the ledger. */
async function sendLateLoginNotice(emp, { date, shift, expectedTime, actualTime, lateBy, grace }) {
  const to = emp.hr_email;
  if (!to || requestNotify.isPlaceholderEmail(to)) return { skipped: true };
  const { subject, html } = templates.lateLoginNotice({
    employeeName: emp.hr_hremployee1, date: time.fmtDate(date), shift, expectedTime, actualTime, lateBy,
    grace: grace != null ? grace : LATE_ENTRY_GRACE_MIN,
  });
  // ONE email per employee + attendance date (LATE_LOGIN) — the ledger de-dupes so a
  // re-scan / real-time check-in / recalc never re-sends the same day's late entry.
  return ledger.sendOnce({ employeeId: emp.hr_hremployeeid, date, type: 'LATE_LOGIN', to, subject, html, entity: 'attendance' });
}

// ── SAME-DAY Late Login sweep ─────────────────────────────────────────────────
// The nightly/morning runScan only processes COMPLETED days (hr_date lt today) and
// only iterates existing records; and eTime device punches never fire the real-time
// web check-in notice. So a late entry (or a no-punch-by-deadline) was only caught
// the NEXT day. This sweep runs DURING the day and, once an employee's shift-start +
// the (5-min) late-entry grace has passed, sends TODAY's Late Login notice — for a
// late first punch (web OR eTime) OR for no valid first punch yet. All sends go
// through the same ledger-deduped sendLateLoginNotice, so re-runs / a later eTime
// punch / the nightly scan never produce a duplicate. Uses the company IST civil
// date throughout (no UTC date shift).
const LEAVE = d365.constructor.entities.leave;
const hhmmToMin = (s) => { const [h, m] = String(s || '0:0').split(':').map(Number); return (h || 0) * 60 + (m || 0); };
function istNowMin() { const [h, m] = String(time.istHHMM() || '00:00').split(':').map(Number); return (h || 0) * 60 + (m || 0); }
function isWorkingDayFor(dateStr) {
  try {
    const dow = new Date(`${dateStr}T00:00:00Z`).getUTCDay();
    return !attnCfg.weekOffDays.includes(dow) && !attnCfg.holidays.includes(dateStr);
  } catch { return true; }
}

/**
 * PURE decision for TODAY's Late Login notice (unit-testable, no I/O). The DEADLINE
 * is always the employee's own `shiftStartMin + grace` (never a fixed clock time).
 *   - Skip on night shift / weekly-off·holiday / approved leave / a Late Login
 *     request ALREADY submitted for the date (suppress both notices).
 *   - Has a late first punch (lateEntryMinutes > 0 — the SAME value computeSession
 *     produces with the grace) → "you logged in late".
 *   - No first punch and now strictly PAST shift-start + grace → "please apply for
 *     Late Login". Before the deadline (incl. a shift later today) → do nothing.
 *   - A first punch WITHIN grace → nothing.
 * @returns {{ notify:boolean, reason:string, lateBy?:number }}
 */
function shouldNotifyLateLogin({ isNight, isWorkingDay, onLeave, alreadySubmitted, nowMin, shiftStartMin, grace = LATE_ENTRY_GRACE_MIN, hasPunch, lateEntryMinutes = 0 }) {
  if (isNight || !isWorkingDay || onLeave || alreadySubmitted) return { notify: false, reason: 'skip' };
  if (hasPunch) {
    if ((lateEntryMinutes || 0) > 0) return { notify: true, reason: 'late_punch', lateBy: lateEntryMinutes };
    return { notify: false, reason: 'on_time' };                       // within grace (e.g. 09:04)
  }
  if (nowMin > shiftStartMin + grace) return { notify: true, reason: 'no_punch', lateBy: Math.max(0, nowMin - shiftStartMin) };
  return { notify: false, reason: 'before_deadline' };                 // future shift / grace not passed yet
}

const LATE = d365.constructor.entities.lateLogin;
/** Employees who ALREADY have a Late Login request for `date` (any non-rejected/
 *  cancelled status) → suppress BOTH automatic notices for them. */
async function submittedLateLoginEmployees(date) {
  const set = new Set();
  try {
    const { data } = await d365.getList(LATE, { select: 'hr_employeeid,hr_status', filter: `hr_date eq '${date}'`, top: 5000 });
    for (const r of data || []) if (!['rejected', 'cancelled'].includes(String(r.hr_status || ''))) set.add(r.hr_employeeid);
  } catch (_) { /* table not provisioned / read failure → treat as none submitted */ }
  return set;
}

/** "Please apply for Late Login" notice (no valid punch by the deadline). Deduped by
 *  the SAME ledger key as the late-entry notice, so an employee gets ONE per day. */
async function sendLateLoginApplyPrompt(emp, { date, shift, expectedTime, grace }) {
  const to = emp.hr_email;
  if (!to || requestNotify.isPlaceholderEmail(to)) return { skipped: true };
  const { subject, html } = templates.lateLoginApplyPrompt({
    employeeName: emp.hr_hremployee1, date: time.fmtDate(date), shift, expectedTime, actualTime: '',
    grace: grace != null ? grace : LATE_ENTRY_GRACE_MIN,
  });
  return ledger.sendOnce({ employeeId: emp.hr_hremployeeid, date, type: 'LATE_LOGIN', to, subject, html, entity: 'attendance' });
}

/** Employees on an APPROVED leave that covers `date` (skip — respect existing rules). */
async function approvedLeaveEmployees(date) {
  const set = new Set();
  try {
    const approved = require('./picklist').toValue('hr_leave_status', 'approved');
    const { data } = await d365.getList(LEAVE, { select: '_hr_hremployee_value,hr_fromdate,hr_todate,hr_status', filter: `hr_status eq ${approved}`, top: 5000 });
    for (const l of data || []) {
      const lf = String(l.hr_fromdate || '').slice(0, 10), lt = String(l.hr_todate || '').slice(0, 10) || lf;
      if (lf && lf <= date && lt >= date) set.add(l._hr_hremployee_value);
    }
  } catch (_) { /* best-effort — leave read failure never blocks the sweep */ }
  return set;
}

/**
 * Same-day Late Login sweep. Run frequently (cron every 15 min). For every active employee
 * whose late-entry deadline (shift start + grace) has passed TODAY, send today's
 * Late Login notice (deduped). Never touches attendance, never creates records — it
 * only sends the existing informational notice for the correct attendance date.
 */
async function sweepTodayLateLogins() {
  if (!ecfg.notify.lateLoginNotice) return { skipped: 'disabled' };
  const date = time.istDateStr();                 // company/IST civil date — never UTC
  if (!isWorkingDayFor(date)) return { skipped: 'non_working_day', date };
  const nowMin = istNowMin();
  let emps = [], recs = [], onLeave = new Set(), submitted = new Set();
  try {
    const activeVal = require('./picklist').toValue('hr_employee_status', 'active');
    const [e, r, lv, sub] = await Promise.all([
      d365.getListOptional(EMP, { select: 'hr_hremployeeid,hr_hremployee1,hr_email', optionalSelect: SHIFT_COLS, filter: `hr_status eq ${activeVal}`, top: 5000 }),
      d365.getList(ATT, { select: PUNCH_SELECT, filter: `hr_date eq ${date}`, top: 5000 }),   // TODAY only
      approvedLeaveEmployees(date),
      submittedLateLoginEmployees(date),
    ]);
    emps = e.data || []; recs = r.data || []; onLeave = lv; submitted = sub;
  } catch (err) { global.logger?.error(`[late-login-sweep] read failed: ${err.message}`); return { scanned: 0, notified: 0, date }; }

  const recByEmp = new Map();
  for (const rec of recs) recByEmp.set(rec._hr_hremployee_value, rec);   // one attendance row per employee/day

  let scanned = 0, notified = 0;
  for (const emp of emps) {
    scanned++;
    const shift = shiftOf(emp);
    const rec = recByEmp.get(emp.hr_hremployeeid);
    const c = rec ? computeSession(punchesFromRecord(rec), shift) : null;
    // Deadline = the employee's OWN shift start + grace (never a fixed clock time).
    const decision = shouldNotifyLateLogin({
      isNight: !!shift.isNight, isWorkingDay: true,
      onLeave: onLeave.has(emp.hr_hremployeeid), alreadySubmitted: submitted.has(emp.hr_hremployeeid),
      nowMin, shiftStartMin: hhmmToMin(shift.start), grace: LATE_ENTRY_GRACE_MIN,
      hasPunch: !!(c && c.count > 0), lateEntryMinutes: c ? c.lateEntryMinutes : 0,
    });
    if (!decision.notify) continue;
    const shiftLabel = emp.hr_shiftname || `${shift.start}–${shift.end}`;
    // No punch by the deadline → "Please apply for Late Login"; a late punch → "You
    // logged in late". Both share ONE ledger key → exactly one email per employee/day.
    const res = decision.reason === 'no_punch'
      ? await sendLateLoginApplyPrompt(emp, { date, shift: shiftLabel, expectedTime: shift.start, grace: LATE_ENTRY_GRACE_MIN })
      : await sendLateLoginNotice(emp, {
          date, shift: shiftLabel, expectedTime: shift.start,
          actualTime: c && c.firstPunch ? time.to12h(c.firstPunch) : '',
          lateBy: decision.lateBy, grace: LATE_ENTRY_GRACE_MIN,
        });
    if (!res?.skipped) notified++;
  }
  global.logger?.info?.(`[late-login-sweep] ${date}: scanned ${scanned}, notified ${notified}`);
  return { scanned, notified, date };
}

/** Reporting manager + HR emails for escalation CC. */
async function escalationCc(emp, ageDays) {
  const cc = [];
  if (ageDays >= 2 && emp._hr_manager_value) {
    try {
      const mgr = await d365.getById(EMP, emp._hr_manager_value, { select: 'hr_email' });
      if (mgr?.hr_email && !requestNotify.isPlaceholderEmail(mgr.hr_email)) cc.push({ email: mgr.hr_email, role: 'your reporting manager' });
    } catch (_) {}
  }
  if (ageDays >= 3) {
    try {
      const hr = (await requestNotify.getApprovers())[0];
      if (hr?.hr_email && !requestNotify.isPlaceholderEmail(hr.hr_email)) cc.push({ email: hr.hr_email, role: 'HR' });
    } catch (_) {}
  }
  return cc;
}

/**
 * Nightly / morning scan: over the last few completed days, notify every employee
 * whose day has an exception and no correction request yet. Age drives escalation:
 * ≥48h → CC reporting manager, ≥72h → CC HR.
 */
async function runScan({ days = 3, reminder = false } = {}) {
  const today = time.istDateStr();
  const from = String(new Date(new Date(`${today}T00:00:00Z`).getTime() - days * 86400000).toISOString()).slice(0, 10);
  let emps = [], recs = [];
  try {
    const [e, r] = await Promise.all([
      d365.getListOptional(EMP, { select: 'hr_hremployeeid,hr_hremployee1,hr_email,_hr_manager_value', optionalSelect: SHIFT_COLS, filter: `hr_status eq ${require('./picklist').toValue('hr_employee_status', 'active')}`, top: 5000 }),
      d365.getAll(ATT, { select: PUNCH_SELECT, filter: `hr_date ge ${from} and hr_date lt ${today}`, orderby: 'hr_date desc' }, 10000),
    ]);
    emps = e.data || []; recs = r.data || [];
  } catch (err) { global.logger?.error(`[exception-scan] read failed: ${err.message}`); return { scanned: 0, notified: 0 }; }

  const empMap = new Map(emps.map(e => [e.hr_hremployeeid, e]));
  const seen = new Set();
  let notified = 0;
  for (const rec of recs) {
    const emp = empMap.get(rec._hr_hremployee_value);
    if (!emp) continue;
    const shift = shiftOf(emp);
    const c = computeSession(punchesFromRecord(rec), shift);
    const date = String(rec.hr_date).slice(0, 10);
    const shiftLabel = emp.hr_shiftname || `${shift.start}–${shift.end}`;

    // Late-login informational notice (opt-in) — ONE per employee/day via the
    // ledger, so recalc / dashboard / payroll never re-send it (§9).
    if (ecfg.notify.lateLoginNotice && (c.lateEntryMinutes || 0) > 0) {
      await sendLateLoginNotice(emp, { date, shift: shiftLabel, expectedTime: shift.start, actualTime: c.firstPunch ? time.to12h(c.firstPunch) : '', lateBy: c.lateEntryMinutes, grace: LATE_ENTRY_GRACE_MIN });
    }

    const [ex] = detectExceptions(c);
    if (!ex) continue;
    const key = `${emp.hr_hremployeeid}|${date}`;
    if (seen.has(key)) continue; seen.add(key);
    const skip = await requestedDates(emp.hr_hremployeeid, [date]);
    if (skip.has(date)) continue;                    // correction already raised → nothing to notify
    // CC manager (≥48h) / HR (≥72h) ONLY if the company opted in; default = employee only.
    const cc = ecfg.notify.exceptionEscalationCc ? await escalationCc(emp, daysBetween(date, today)) : [];
    await notifyException(emp, { ...ex, date, punches: c.punches.map(p => p.t) }, {
      cc, shift: shiftLabel,
      inTime: c.firstPunch ? time.to12h(c.firstPunch) : '',
      outTime: c.lastPunch ? time.to12h(c.lastPunch) : '',
    });
    notified++;
  }
  global.logger?.info(`[exception-scan] ${from}..${today}: scanned ${recs.length} records, notified ${notified}`);
  return { scanned: recs.length, notified };
}

module.exports = { openExceptionsForEmployee, runScan, notifyException, sendLateLoginNotice, sweepTodayLateLogins, shouldNotifyLateLogin };
