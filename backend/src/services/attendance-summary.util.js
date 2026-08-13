/**
 * Employee-wise attendance summary math — pure, testable, single source of truth.
 * Reads week-off / holidays from the Company/Attendance config (overridable for tests).
 */
const attnCfg = require('./attendance.config');
const round2 = (n) => Math.round(n * 100) / 100;
const pad2 = (n) => String(n).padStart(2, '0');

/**
 * Calendar / Holiday / Weekly-off / Working-day counts for a date range (inclusive).
 * Working Days = Calendar Days - Office Holidays - Weekly Off.
 * A day that is BOTH a holiday and a week-off is counted once (as a holiday).
 */
function rangeCounts(from, to, opts = {}) {
  const weekOffDays = opts.weekOffDays || attnCfg.weekOffDays;
  const holidays = opts.holidays || attnCfg.holidays;
  let calendar = 0, hol = 0, woff = 0;
  const end = new Date(`${to}T00:00:00Z`);
  for (let d = new Date(`${from}T00:00:00Z`); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
    calendar++;
    const ds = `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
    if (holidays.includes(ds)) hol++;
    else if (weekOffDays.includes(d.getUTCDay())) woff++;
  }
  return { calendar, holidays: hol, weeklyOff: woff, working: calendar - hol - woff };
}

/**
 * Aggregate one employee's computed sessions into summary figures.
 * @param sessions array of computeSession() results (or {count,status,effectiveHours,breakHours,overtimeHours})
 * Absent = Working Days - (days with a punch) - Approved Leave  (never counts a punch day or holiday/week-off as absent).
 */
// User-facing date = DD-MM-YYYY (global format), stored value untouched.
function fmtDate(dateStr) {
  const d = String(dateStr || '').slice(0, 10).split('-');
  if (d.length !== 3) return String(dateStr || '');
  return `${d[2]}-${d[1]}-${d[0]}`;
}

/**
 * @param sessions array of computeSession() results, optionally carrying { date, attendanceIssue }
 * Also returns missingPunchDetails: ["05 Jul 2026 – Missing Check Out", …] for incomplete days.
 */
function summarizeEmployee(sessions = [], { working = 0, leaveDays = 0 } = {}) {
  let present = 0, half = 0, incomplete = 0, attended = 0, eff = 0, brk = 0, ot = 0;
  const missingPunchDetails = [];
  for (const c of sessions) {
    if ((c.count || 0) > 0) attended++;                 // any punch → not absent (rule 8)
    if (c.status === 'present') present++;
    else if (c.status === 'half_day') half++;
    else if (c.status === 'incomplete') {
      incomplete++;
      if (c.date) missingPunchDetails.push(`${fmtDate(c.date)} – ${c.attendanceIssue || 'Missing Check Out'}`);
    }
    eff += c.effectiveHours || 0;
    brk += c.breakHours || 0;
    ot += c.overtimeHours || 0;
  }
  const absent = Math.max(0, working - attended - (leaveDays || 0));
  return {
    present, half, incomplete, attended, absent, missingPunchDetails,
    effectiveHours: round2(eff), breakHours: round2(brk), overtimeHours: round2(ot),
  };
}

/**
 * Monthly Attendance Summary rows — ONE row per employee, exactly the six columns
 * the HR summary export needs. Pure: no I/O and no Dataverse field names, so the
 * caller resolves identity and this stays unit-testable.
 *
 * Present Days = days with ANY attendance activity (`attended`). A day counts
 * ONCE whether it was Present, Late, Early Exit, Overtime, Incomplete or Half
 * Day — Late/Early Exit/Overtime are flags ON a punched day rather than separate
 * statuses, so `attended` already collapses all six into a single day. This is
 * why there is no separate Half Day or Incomplete column.
 *
 * Absent Days = summarizeEmployee()'s `absent`, i.e.
 *   Working − Attended − Approved Leave
 * where Working already excludes weekends, office holidays, dates before the
 * employee's first attendance, and future dates (the caller caps `to` at today).
 *
 * @param entries [{ employeeId, employeeName, working, summary }]
 * @param calendar total calendar days in the selected range
 */
function monthlySummaryRows(entries = [], { calendar = 0 } = {}) {
  return entries.map((e) => ({
    employeeId: e.employeeId || '',
    employeeName: e.employeeName || 'Employee',
    calendarDays: calendar,
    workingDays: e.working || 0,
    presentDays: (e.summary && e.summary.attended) || 0,
    absentDays: (e.summary && e.summary.absent) || 0,
  }));
}

/**
 * Working days for an employee within [from, capTo], starting at their FIRST
 * attendance date — never before their first punch. Returns 0 when the employee
 * has no attendance history (firstDate falsy) or their first date is after capTo.
 */
function effectiveWorking(from, capTo, firstDate, opts = {}) {
  if (!firstDate) return 0;
  const effFrom = firstDate > from ? firstDate : from;
  if (!capTo || capTo < effFrom) return 0;
  return rangeCounts(effFrom, capTo, opts).working;
}

/**
 * Approved-leave WORKING days for one employee within [from, capTo]. Counts each
 * distinct working date once (dedupes overlapping leaves), excluding holidays and
 * weekly-offs — so it matches the Absent math used by /absentees and /stats.
 * This is the single helper both the dashboard and the monthly summary must use
 * (previously they counted calendar-day spans, which diverged from /stats).
 * @param leaves array of approved leave rows carrying hr_fromdate / hr_todate
 */
function approvedLeaveWorkingDays(leaves = [], from, to, opts = {}) {
  const weekOffDays = opts.weekOffDays || attnCfg.weekOffDays;
  const holidays = opts.holidays || attnCfg.holidays;
  const start = String(from).slice(0, 10), end = String(to).slice(0, 10);
  if (!start || !end || end < start) return 0;
  const counted = new Set();
  for (const l of leaves || []) {
    const lf = String(l.hr_fromdate || '').slice(0, 10);
    const lt = String(l.hr_todate || '').slice(0, 10) || lf;
    if (!lf) continue;
    const s = lf < start ? start : lf;
    const e = lt > end ? end : lt;
    if (e < s) continue;
    let d = new Date(`${s}T00:00:00Z`); const stop = new Date(`${e}T00:00:00Z`);
    let guard = 0;
    while (d <= stop && guard++ < 500) {
      const ds = `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
      if (!holidays.includes(ds) && !weekOffDays.includes(d.getUTCDay())) counted.add(ds);
      d.setUTCDate(d.getUTCDate() + 1);
    }
  }
  return counted.size;
}

// ── Absent enumeration + before-grace rule (spec §7/§8) — the SINGLE definition of
// an employee's Absent working dates, reused by the attendance list, the stats
// cards, the dashboard, reports and payroll so every surface agrees. ─────────────
const hhmmToMin = (s) => { const [h, m] = String(s || '').split(':').map(Number); return (h || 0) * 60 + (m || 0); };

/** Has this employee's (shift start + grace) already passed today? Day shifts only;
 *  night/unknown shifts are treated as eligible so their absents are never hidden. */
function gracePassedToday(shift, graceMin, nowMin) {
  if (!shift || shift.isNight) return true;
  // Strictly AFTER the grace window: at exactly shift+grace (e.g. 09:15) the employee
  // is still on time / Pending; Absent only applies after it (09:16+), per spec §4/§7.
  return nowMin > (hhmmToMin(shift.start) + (Number(graceMin) || 0));
}

/**
 * Working dates in [from, capTo] (excl holiday / weekly-off), on/after `firstDate`,
 * with NO attendance record and NO approved leave → the employee's ABSENT days.
 * When opts.todayPending is true, opts.today is skipped (before shift+grace = Pending,
 * not Absent). `hasRecord(ds)` / `onLeave(ds)` are predicates for one employee.
 */
function absentDatesFor(from, capTo, firstDate, hasRecord, onLeave, opts = {}) {
  if (!firstDate) return [];
  const start = from < firstDate ? firstDate : from;
  if (!capTo || capTo < start) return [];
  const { today, todayPending = false } = opts;
  const out = [];
  const end = new Date(`${capTo}T00:00:00Z`);
  for (let d = new Date(`${start}T00:00:00Z`); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
    const ds = `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
    if (holidaysOf(opts).includes(ds) || weekOffsOf(opts).includes(d.getUTCDay())) continue;
    if (hasRecord(ds) || onLeave(ds)) continue;
    if (todayPending && ds === today) continue;
    out.push(ds);
  }
  return out;
}
const holidaysOf = (opts) => (opts && opts.holidays) || attnCfg.holidays;
const weekOffsOf = (opts) => (opts && opts.weekOffDays) || attnCfg.weekOffDays;

/**
 * Expand APPROVED + PENDING leaves into per-(employee, working-date) classification —
 * the single mapping the Attendance page uses to overlay leave onto dates and to keep
 * pending days OUT of Absent (mirroring the payroll rule: approved = paid, pending =
 * held, rejected/cancelled = not-a-leave → Absent/LOP). Multi-day leaves are expanded
 * to every applicable WORKING date (weekly-offs / holidays excluded). Approved wins
 * over pending on the same date.
 *
 * @param normLeaves array of { employeeId, fromDate, toDate, type, status } — status
 *        already normalised to 'approved' | 'pending' (others are ignored by the caller).
 * @returns Map(employeeId → Map(dateStr → { type, status }))
 */
function expandLeaveDays(normLeaves = [], from, capTo, opts = {}) {
  const weekOffDays = opts.weekOffDays || attnCfg.weekOffDays;
  const holidays = opts.holidays || attnCfg.holidays;
  const start = String(from || '').slice(0, 10), end = String(capTo || '').slice(0, 10);
  const byEmp = new Map();
  if (!start || !end || end < start) return byEmp;
  for (const l of normLeaves || []) {
    if (l.status !== 'approved' && l.status !== 'pending') continue;
    const lf = String(l.fromDate || '').slice(0, 10);
    const lt = String(l.toDate || '').slice(0, 10) || lf;
    if (!lf || !l.employeeId) continue;
    const s = lf < start ? start : lf;
    const e = lt > end ? end : lt;
    if (e < s) continue;
    let m = byEmp.get(l.employeeId); if (!m) byEmp.set(l.employeeId, m = new Map());
    let d = new Date(`${s}T00:00:00Z`); const stop = new Date(`${e}T00:00:00Z`);
    let guard = 0;
    while (d <= stop && guard++ < 500) {
      const ds = `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
      if (!holidays.includes(ds) && !weekOffDays.includes(d.getUTCDay())) {
        const prev = m.get(ds);
        if (!prev || (prev.status === 'pending' && l.status === 'approved')) m.set(ds, { type: l.type || '', status: l.status });
      }
      d.setUTCDate(d.getUTCDate() + 1);
    }
  }
  return byEmp;
}

module.exports = { rangeCounts, summarizeEmployee, fmtDate, effectiveWorking, approvedLeaveWorkingDays, absentDatesFor, gracePassedToday, expandLeaveDays };
