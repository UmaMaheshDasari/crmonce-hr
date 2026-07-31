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
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function fmtDate(dateStr) {
  const d = String(dateStr || '').slice(0, 10).split('-');
  if (d.length !== 3) return String(dateStr || '');
  return `${d[2]} ${MONTHS[Number(d[1]) - 1] || d[1]} ${d[0]}`;
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

module.exports = { rangeCounts, summarizeEmployee, fmtDate, effectiveWorking };
