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
 * SINGLE SOURCE OF TRUTH for the Absent calculation (and Present / Half Day /
 * Incomplete / Leave). Walks every WORKING day in [from, capTo] for ONE employee
 * and classifies it, so the Absent COUNT and the exact Absent ROWS come from the
 * same enumeration — they can never disagree.
 *
 * Business rules:
 *   3/4  Saturdays, Sundays & company holidays are excluded → never Absent.
 *   7/6/5 A day with ANY punch → Present / Half Day / Incomplete (never Absent).
 *   2    A day covered by an Approved Leave → Leave (never Absent).
 *   1    A working day with no punch and no approved leave → Absent.
 * Working days begin at the employee's FIRST attendance date — nothing before the
 * first punch is counted (no history → 0 working days → 0 Absent).
 *
 * @param {string} from   range start 'YYYY-MM-DD'
 * @param {string} capTo  range end, already capped to min(to, today) 'YYYY-MM-DD'
 * @param {string|null} firstDate employee's first attendance date (null = no history)
 * @param {Map<string,object>} sessionByDate 'YYYY-MM-DD' → computeSession() result
 * @param {Set<string>} leaveDates approved-leave dates (per day) for this employee
 * @param {{weekOffDays?:number[], holidays?:string[]}} [opts]
 * @returns per-day classification + tallies (present/half/incomplete/attended/leave/absent),
 *          absentDates[] (the exact Absent rows), and hour totals.
 */
function classifyEmployeeDays(from, capTo, firstDate, sessionByDate = new Map(), leaveDates = new Set(), opts = {}) {
  const weekOffDays = opts.weekOffDays || attnCfg.weekOffDays;
  const holidays = opts.holidays || attnCfg.holidays;
  const out = {
    perDay: [], absentDates: [], missingPunchDetails: [],
    working: 0, present: 0, half: 0, incomplete: 0, attended: 0, leave: 0, absent: 0,
    effectiveHours: 0, breakHours: 0, overtimeHours: 0,
  };
  if (!firstDate || !capTo) return out;                    // no history → never Absent
  const effFrom = firstDate > from ? firstDate : from;     // start at the first punch
  if (capTo < effFrom) return out;

  const end = new Date(`${capTo}T00:00:00Z`);
  for (let d = new Date(`${effFrom}T00:00:00Z`); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
    const ds = `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
    if (holidays.includes(ds)) continue;                   // rule 4 — holiday
    if (weekOffDays.includes(d.getUTCDay())) continue;     // rule 3 — Sat/Sun / week-off
    out.working++;

    const sess = sessionByDate.get(ds);
    if (sess && (sess.count || 0) > 0) {                   // rules 7/6/5 — any punch → attended
      out.attended++;
      if (sess.status === 'present') out.present++;
      else if (sess.status === 'half_day') out.half++;
      else if (sess.status === 'incomplete') {
        out.incomplete++;
        out.missingPunchDetails.push(`${fmtDate(ds)} – ${sess.attendanceIssue || 'Missing Check Out'}`);
      }
      out.effectiveHours += sess.effectiveHours || 0;
      out.breakHours += sess.breakHours || 0;
      out.overtimeHours += sess.overtimeHours || 0;
      out.perDay.push({ date: ds, status: sess.status });
    } else if (leaveDates.has(ds)) {                       // rule 2 — approved leave
      out.leave++;
      out.perDay.push({ date: ds, status: 'leave' });
    } else {                                               // rule 1 — Absent
      out.absent++;
      out.absentDates.push(ds);
      out.perDay.push({ date: ds, status: 'absent' });
    }
  }
  out.effectiveHours = round2(out.effectiveHours);
  out.breakHours = round2(out.breakHours);
  out.overtimeHours = round2(out.overtimeHours);
  return out;
}

module.exports = { rangeCounts, summarizeEmployee, fmtDate, effectiveWorking, classifyEmployeeDays };
