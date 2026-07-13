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
function summarizeEmployee(sessions = [], { working = 0, leaveDays = 0 } = {}) {
  let present = 0, half = 0, incomplete = 0, attended = 0, eff = 0, brk = 0, ot = 0;
  for (const c of sessions) {
    if ((c.count || 0) > 0) attended++;                 // any punch → not absent (rule 8)
    if (c.status === 'present') present++;
    else if (c.status === 'half_day') half++;
    else if (c.status === 'incomplete') incomplete++;
    eff += c.effectiveHours || 0;
    brk += c.breakHours || 0;
    ot += c.overtimeHours || 0;
  }
  const absent = Math.max(0, working - attended - (leaveDays || 0));
  return { present, half, incomplete, attended, absent, effectiveHours: round2(eff), breakHours: round2(brk), overtimeHours: round2(ot) };
}

module.exports = { rangeCounts, summarizeEmployee };
