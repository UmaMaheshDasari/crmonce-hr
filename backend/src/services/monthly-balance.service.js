/**
 * Monthly Attendance Hour Balance (independent per month — NO carry-forward).
 *
 * Each calendar month stands alone:
 *   Daily Balance   = Actual Effective Hours − Daily Expected Hours
 *   Monthly Balance = Σ Daily Balance  (= Effective Worked Hours − Required Hours)
 * There is NO carry-forward: a month never uses the previous or next month's balance,
 * and neither a positive surplus nor a negative shortage moves between months.
 *
 * Daily expected hours:
 *   - Full Day (present)   → 9h   (from computeSession.expectedHours)
 *   - Half Day (half_day)  → 5h
 *   - Approved leave day   → 0h   (requirement removed — approved leave never causes a shortage)
 *   - Holiday / Weekly-off → 0h
 *   - Absent working day   → 9h   (full-day expectation → a real shortage)
 *
 * Overtime is NOT added separately — extra hours already raise the balance through
 * (worked − expected); the Overtime figure is reporting only (never double-counted).
 * Late Login never reduces effective hours (attendance calc is unchanged).
 *
 * Salary: a NEGATIVE monthly balance is deducted as EXACT hours × the existing hourly
 * salary rate. There is NO half-day / full-day LOP conversion. A zero/positive balance
 * deducts nothing. Historical dates use the shift effective on that date (shift history).
 *
 * EFFECTIVE DATE: only attendance on/after company.policy.newRulesFrom (2026-08-01) is
 * counted; pre-cutoff days never enter this calc, so August 2026 starts fresh.
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

/**
 * PURE roll-up: accumulate per-day rows into the month's independent balance. No I/O,
 * no carry-forward — the month starts at 0.
 * @param {Array<{date?:string,type?:string,worked:number,span?:number,expected:number,overtime?:number,leaveHours?:number}>} days
 *   worked     effective hours actually worked that day (0 if none)
 *   span       gross clocked hours (defaults to worked when omitted)
 *   expected   hours expected that day (0 for holiday/weekly-off/approved leave)
 *   overtime   overtime hours that day (display only — NOT re-added to the balance)
 *   leaveHours expected hours REMOVED by approved leave that day (reporting only)
 */
function rollupMonthlyBalance(days = []) {
  let worked = 0, span = 0, expected = 0, overtime = 0, leaveHours = 0;
  const series = [];
  for (const d of days) {
    const w = num(d.worked), e = num(d.expected);
    worked = round2(worked + w);
    span = round2(span + (d.span != null ? num(d.span) : w));
    expected = round2(expected + e);
    overtime = round2(overtime + num(d.overtime));
    leaveHours = round2(leaveHours + num(d.leaveHours));
    series.push({ date: d.date || null, type: d.type || 'working', worked: w, expected: e, overtime: num(d.overtime), dailyBalance: round2(w - e) });
  }
  const monthlyBalance = round2(worked - expected);
  return {
    requiredHours: expected,           // adjusted: approved-leave days already contribute 0
    approvedLeaveHours: leaveHours,
    actualWorkedHours: span,           // gross clocked
    effectiveHours: worked,            // net — drives the balance
    overtime,
    monthlyBalance,                    // Effective − Required (this month only)
    shortageHours: monthlyBalance < 0 ? round2(-monthlyBalance) : 0,   // exact hours only; no LOP days
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
 * Build one employee's monthly hour balance for a single month (independent — no
 * carry). Reuses the daily engine (computeSession), the shift-history resolver
 * (per-date shift), approved-leave expansion, and the shared holiday/week-off config.
 * Batched I/O (records + leaves), computed in memory.
 * @returns {Promise<object>} the monthly report (see rollupMonthlyBalance) + { year, month }
 */
async function buildMonthlyBalance({ employeeId, year, month } = {}) {
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
  // EFFECTIVE DATE: never look at dates before the cutoff, so pre-cutoff days never
  // enter the balance and a pre-cutoff month yields an empty (zero) result.
  const cutoff = policy.attendance.newRulesFrom();
  if (effFrom < cutoff) effFrom = cutoff;
  const graceMin = await resolveGraceMinutes();
  const nowMin = (() => { const [h, mi] = String(time.istHHMM() || '00:00').split(':').map(Number); return (h || 0) * 60 + (mi || 0); })();

  const days = [];
  let presentDays = 0, halfDays = 0, absentDays = 0, approvedLeaveDays = 0;
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
    // Approved leave → requirement removed (expected 0). Never Absent, never a shortage.
    if (leaveMap.has(ds)) {
      approvedLeaveDays++;
      days.push({ date: ds, type: 'leave', worked: worked ? worked.effectiveHours : 0, span: worked ? worked.totalSpanHours : 0, expected: 0, overtime: worked ? worked.overtimeHours : 0, leaveHours: fullDayExpected() });
      continue;
    }
    // ATTENDED working day (has a punch) → the day's status expected (5 or 9); its shortfall
    // is handled by the monthly HOUR balance. ABSENT (no punch, no leave) → counted as an
    // Absent DAY only (day-based LOP downstream) and EXCLUDED from the hour balance, so an
    // absent day is never double-counted (day-LOP + hour-shortage). Today before shift+grace
    // is Pending (skipped).
    if (worked) {
      if (worked.status === 'half_day') halfDays++; else if (worked.status === 'present') presentDays++;
      days.push({ date: ds, type: 'working', worked: worked.effectiveHours, span: worked.totalSpanHours, expected: worked.expectedHours, overtime: worked.overtimeHours, leaveHours: 0 });
    } else {
      if (ds === today && !gracePassedToday(shift, graceMin, nowMin)) continue;   // pending, not yet Absent
      absentDays++;   // day-based LOP handles this; NOT part of the hour balance
    }
  }

  const rolled = rollupMonthlyBalance(days);
  return { year: y, month: m, ...rolled, presentDays, halfDays, absentDays, approvedLeaveDays };
}

/**
 * Salary deduction for a NEGATIVE monthly balance — EXACT hours × the existing hourly
 * salary rate. READ ONLY: reuses the existing per-day rate (perDaySalary, honouring
 * lopBasis) divided by the configured working-hours-per-day (the same hourly rate the
 * payroll engine uses for overtime). No LOP days; no half/full-day conversion. The
 * payroll engine is NOT modified here.
 * @returns {Promise<{shortageHours:number, hourlyRate:number|null, salaryDeduction:number|null}>}
 */
async function estimateSalaryDeduction({ employeeId, year, month, shortageHours } = {}) {
  const sh = round2(shortageHours);
  if (!(sh > 0)) return { shortageHours: Math.max(0, sh), hourlyRate: 0, salaryDeduction: 0 };
  try {
    const salaryStructure = require('./salary-structure.service');
    const { perDaySalary } = require('./payroll-engine.calc');
    const { rangeCounts } = require('./attendance-summary.util');
    const settings = await require('./payroll-settings.service').getResolved();
    const y = Number(year), m = Number(month);
    const lastDay = new Date(y, m, 0).getDate();
    const asOf = `${y}-${pad2(m)}-${pad2(lastDay)}`;
    const s = await salaryStructure.getActiveStructure(d365, employeeId, asOf);
    if (!s || !(Number(s.gross) > 0)) return { shortageHours: sh, hourlyRate: null, salaryDeduction: null };
    const salaryWorkingDays = rangeCounts(`${y}-${pad2(m)}-01`, asOf).working;
    const perDay = perDaySalary(s.gross, { lopBasis: settings.lopBasis, salaryWorkingDays, calendarDays: lastDay });
    const workingHoursPerDay = Number(settings.workingHoursPerDay) || 8;
    const hourlyRate = workingHoursPerDay > 0 ? round2(perDay / workingHoursPerDay) : 0;
    return { shortageHours: sh, hourlyRate, salaryDeduction: Math.round(sh * hourlyRate) };
  } catch { return { shortageHours: sh, hourlyRate: null, salaryDeduction: null }; }
}

module.exports = { rollupMonthlyBalance, buildMonthlyBalance, estimateSalaryDeduction, firstAttendanceDate };
