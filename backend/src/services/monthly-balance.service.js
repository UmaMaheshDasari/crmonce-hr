/**
 * Monthly Cumulative Hour Balance (Phase 2).
 *
 * Builds on the Phase-1 daily rule (attendance.util.computeSession → status +
 * expectedHours). For a month it accumulates:
 *
 *   Daily Balance  = Actual Effective Hours − Daily Expected Hours
 *   Running Balance = Previous Carry Forward + Σ Daily Balance
 *
 * Expected hours per day:
 *   - Full Day (present)      → 9h      (from computeSession.expectedHours)
 *   - Half Day (half_day)     → 5h      (from computeSession.expectedHours)
 *   - Approved leave day      → 0h      (requirement removed → never a shortage)
 *   - Holiday / Weekly-off    → 0h      (never a shortage)
 *   - Absent working day      → 9h      (full-day expectation → real shortage)
 *
 * Overtime is NOT added separately — extra hours already raise the balance through
 * (worked − expected), so counting the overtime column again would double-count.
 * The Overtime figure is reported for display only.
 *
 * Rejected/Cancelled leave: never reduces required hours. Pending leave: unchanged
 * system behaviour (NOT treated as approved here). Historical dates use the shift
 * effective on that date (shift history), never the current shift.
 *
 * Month-end LOP conversion is intentionally NOT implemented in this phase.
 */
const d365 = require('./d365.service');
const attnCfg = require('./attendance.config');
const policy = require('./company.policy');
const { toValue } = require('./picklist');
const time = require('./time.util');
const { computeSession, punchesFromRecord } = require('./attendance.util');
const { expandLeaveDays, gracePassedToday } = require('./attendance-summary.util');

const ATT = d365.constructor.entities.attendance;
const LEAVE = d365.constructor.entities.leave;
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const pad2 = (n) => String(n).padStart(2, '0');

const fullDayExpected = () => policy.attendance.fullDayExpectedHours();
const halfDayExpected = () => policy.attendance.halfDayExpectedHours();

// Month-end shortage → LOP tiers (hours). Fixed rules; overridable for tests.
const LOP_HALF_DAY_MIN_HOURS = 5;   // 5h <= shortage < 7h → 0.5 day LOP
const LOP_FULL_DAY_MIN_HOURS = 7;   // shortage >= 7h        → 1 day LOP

/**
 * Resolve a month's ending balance into month-end LOP + carry-forward. PURE.
 *   shortage < 5h        → 0 LOP, carry the exact (signed) balance to next month
 *   5h <= shortage < 7h  → 0.5 day LOP, carry 0 (shortage cleared by the LOP)
 *   shortage >= 7h       → 1 day LOP,   carry 0
 * A non-negative balance (surplus / exactly recovered) is never LOP and carries
 * forward as-is, so future months keep the credit. Month-end LOP is expressed in
 * DAYS (0 / 0.5 / 1) — the SAME unit the existing payroll engine already consumes.
 * @param {number} finalBalance signed running balance (negative = shortage)
 */
function resolveMonthEnd(finalBalance, opts = {}) {
  const fb = round2(finalBalance);
  const shortage = fb < 0 ? round2(-fb) : 0;
  const halfMin = Number.isFinite(opts.lopHalfDayMinHours) ? opts.lopHalfDayMinHours : LOP_HALF_DAY_MIN_HOURS;
  const fullMin = Number.isFinite(opts.lopFullDayMinHours) ? opts.lopFullDayMinHours : LOP_FULL_DAY_MIN_HOURS;
  let lopDays = 0, carryForward = fb;
  if (shortage >= fullMin) { lopDays = 1; carryForward = 0; }
  else if (shortage >= halfMin) { lopDays = 0.5; carryForward = 0; }
  else { lopDays = 0; carryForward = fb; }   // < 5h shortage, or a surplus → carry
  return { finalBalance: fb, finalShortage: shortage, lopDays, carryForward };
}

/**
 * PURE roll-up: accumulate per-day rows into the monthly balance. No I/O.
 * @param {Array<{date?:string,type?:string,worked:number,span?:number,expected:number,overtime?:number,leaveHours?:number}>} days
 *   worked     effective hours actually worked that day (0 if none)
 *   span       gross clocked hours (defaults to worked when omitted)
 *   expected   hours expected that day (0 for holiday/weekly-off/approved leave)
 *   overtime   overtime hours that day (display only — NOT re-added to the balance)
 *   leaveHours expected hours REMOVED by approved leave that day (reporting only)
 * @param {{previousCarryForward?:number}} opts
 */
function rollupMonthlyBalance(days = [], { previousCarryForward = 0 } = {}) {
  let worked = 0, span = 0, expected = 0, overtime = 0, leaveHours = 0;
  let running = round2(previousCarryForward);
  const series = [];
  for (const d of days) {
    const w = num(d.worked), e = num(d.expected);
    worked = round2(worked + w);
    span = round2(span + (d.span != null ? num(d.span) : w));
    expected = round2(expected + e);
    overtime = round2(overtime + num(d.overtime));
    leaveHours = round2(leaveHours + num(d.leaveHours));
    const dailyBalance = round2(w - e);
    running = round2(running + dailyBalance);
    series.push({ date: d.date || null, type: d.type || 'working', worked: w, expected: e, overtime: num(d.overtime), dailyBalance, runningBalance: running });
  }
  const currentBalance = running;
  return {
    previousCarryForward: round2(previousCarryForward),
    requiredHours: expected,           // adjusted: approved-leave days already contribute 0
    approvedLeaveHours: leaveHours,
    actualWorkedHours: span,           // gross clocked
    effectiveHours: worked,            // net — drives the balance
    overtime,
    currentBalance,
    finalShortage: currentBalance < 0 ? round2(-currentBalance) : 0,
    days: series,
  };
}

/** First-ever attendance date (min hr_date) — clamps the month so days before an
 *  employee's first punch never count as absent/shortage. Never throws. */
async function firstAttendanceDate(employeeId) {
  try {
    const { data } = await d365.getList(ATT, {
      select: 'hr_date', filter: `_hr_hremployee_value eq '${employeeId}'`, orderby: 'hr_date asc', top: 1,
    });
    return (data && data[0]) ? String(data[0].hr_date).slice(0, 10) : null;
  } catch { return null; }
}

async function resolveGraceMinutes() {
  try { return (await require('./payroll-settings.service').getResolved()).lateLogin.graceMinutes; }
  catch { return 15; }
}

/**
 * Build one employee's monthly hour balance. Reuses the Phase-1 daily engine, the
 * shift-history resolver (per-date shift), approved-leave expansion, and the shared
 * holiday/week-off config. Batched I/O (records + leaves), computed in memory.
 * @returns {Promise<object>} the monthly report (see rollupMonthlyBalance) + { year, month }
 */
async function buildMonthlyBalance({ employeeId, year, month, previousCarryForward = 0 } = {}) {
  const y = Number(year), m = Number(month);
  const mm = pad2(m);
  const from = `${y}-${mm}-01`;
  const lastDay = new Date(y, m, 0).getDate();
  const monthEnd = `${y}-${mm}-${pad2(lastDay)}`;
  const today = time.istDateStr();
  const capTo = today < monthEnd ? today : monthEnd;   // never count future days

  // Attendance records for the month → by date.
  const { data: recs } = await d365.getList(ATT, {
    select: 'hr_hrattendanceid,hr_date,hr_intime,hr_outtime,hr_allpunches,hr_punchcount',
    filter: `_hr_hremployee_value eq '${employeeId}' and hr_date ge ${from} and hr_date le ${capTo}`,
    orderby: 'hr_date asc',
  }).catch(() => ({ data: [] }));
  const recByDate = new Map((recs || []).map((r) => [String(r.hr_date).slice(0, 10), r]));

  // Per-date shift (history-aware) — one history load, reused for every day.
  const shiftResolver = await require('./shift-history.service').shiftResolverFor(employeeId);

  // Approved-leave working dates (holiday/week-off excluded, multi-day expanded).
  const { data: leaves } = await d365.getList(LEAVE, {
    select: 'hr_days,hr_fromdate,hr_todate,hr_status',
    filter: `_hr_hremployee_value eq '${employeeId}' and hr_status eq ${toValue('hr_leave_status', 'approved')}`,
  }).catch(() => ({ data: [] }));
  const leaveMap = expandLeaveDays(
    (leaves || []).map((l) => ({ employeeId, fromDate: l.hr_fromdate, toDate: l.hr_todate, status: 'approved' })),
    from, capTo,
  ).get(employeeId) || new Map();

  const firstDate = await firstAttendanceDate(employeeId);
  let effFrom = firstDate && firstDate > from ? firstDate : from;   // clamp to first punch
  // EFFECTIVE DATE: the new hour-based calc never looks at dates before the cutoff, so
  // pre-cutoff days never enter the balance and a pre-cutoff month yields an empty
  // (zero) result. This also guarantees July can never carry into August.
  const cutoff = policy.attendance.newRulesFrom();
  if (effFrom < cutoff) effFrom = cutoff;
  const graceMin = await resolveGraceMinutes();
  const nowMin = (() => { const [h, mi] = String(time.istHHMM() || '00:00').split(':').map(Number); return (h || 0) * 60 + (mi || 0); })();

  const days = [];
  const end = new Date(`${capTo}T00:00:00Z`);
  for (let d = new Date(`${effFrom}T00:00:00Z`); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
    const ds = `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
    const dow = d.getUTCDay();
    const shift = shiftResolver.forDate(ds);
    const rec = recByDate.get(ds);
    const worked = rec ? computeSession(punchesFromRecord(rec), shift, { graceMinutes: shift.grace, date: ds }) : null;

    // Holiday / Weekly-off → expected 0 (never a shortage). Any work done still counts.
    if (attnCfg.holidays.includes(ds) || attnCfg.weekOffDays.includes(dow)) {
      days.push({ date: ds, type: attnCfg.holidays.includes(ds) ? 'holiday' : 'weekoff', worked: worked ? worked.effectiveHours : 0, span: worked ? worked.totalSpanHours : 0, expected: 0, overtime: worked ? worked.overtimeHours : 0, leaveHours: 0 });
      continue;
    }
    // Approved leave → requirement removed (expected 0), full-day expected recorded as
    // Approved Leave Hours. (Half-day leave, if ever introduced, would remove halfDayExpected.)
    if (leaveMap.has(ds)) {
      days.push({ date: ds, type: 'leave', worked: worked ? worked.effectiveHours : 0, span: worked ? worked.totalSpanHours : 0, expected: 0, overtime: worked ? worked.overtimeHours : 0, leaveHours: fullDayExpected() });
      continue;
    }
    // A working day with a punch → the day's status expected (5 or 9); no punch → Absent
    // (full-day expectation = shortage). Today before shift+grace is Pending, not Absent.
    if (worked) {
      days.push({ date: ds, type: 'working', worked: worked.effectiveHours, span: worked.totalSpanHours, expected: worked.expectedHours, overtime: worked.overtimeHours, leaveHours: 0 });
    } else {
      if (ds === today && !gracePassedToday(shift, graceMin, nowMin)) continue;   // pending, not yet a shortage
      days.push({ date: ds, type: 'absent', worked: 0, span: 0, expected: fullDayExpected(), overtime: 0, leaveHours: 0 });
    }
  }

  const rolled = rollupMonthlyBalance(days, { previousCarryForward });
  const outcome = resolveMonthEnd(rolled.currentBalance);
  // lopDays (0 / 0.5 / 1) + carryForward are the month-end outcome. lopDays is in
  // the SAME unit payroll already uses; payroll owns the actual salary deduction.
  return { year: y, month: m, ...rolled, lopDays: outcome.lopDays, carryForward: outcome.carryForward };
}

/**
 * Estimated salary deduction for a month-end LOP — READ ONLY. Reuses the EXISTING
 * payroll rate `perDaySalary(gross, {lopBasis, salaryWorkingDays, calendarDays})`
 * and the active salary structure. This does NOT run or modify payroll; the actual
 * deduction is still owned and computed by the payroll engine during a run.
 * @returns {Promise<number|null>} estimate (₹), or null if salary/settings unavailable.
 */
async function estimateLopDeduction({ employeeId, year, month, lopDays } = {}) {
  if (!lopDays) return 0;
  try {
    const salaryStructure = require('./salary-structure.service');
    const { perDaySalary } = require('./payroll-engine.calc');
    const { rangeCounts } = require('./attendance-summary.util');
    const settings = await require('./payroll-settings.service').getResolved();
    const y = Number(year), m = Number(month);
    const lastDay = new Date(y, m, 0).getDate();
    const asOf = `${y}-${pad2(m)}-${pad2(lastDay)}`;
    const s = await salaryStructure.getActiveStructure(d365, employeeId, asOf);
    if (!s || !(Number(s.gross) > 0)) return null;
    const salaryWorkingDays = rangeCounts(`${y}-${pad2(m)}-01`, asOf).working;
    const perDay = perDaySalary(s.gross, { lopBasis: settings.lopBasis, salaryWorkingDays, calendarDays: lastDay });
    return round2(perDay * lopDays);
  } catch { return null; }   // estimate is optional; payroll owns the authoritative amount
}

module.exports = { rollupMonthlyBalance, resolveMonthEnd, buildMonthlyBalance, estimateLopDeduction, firstAttendanceDate };
