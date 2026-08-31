/**
 * Monthly Attendance Hour Balance (independent per month — NO carry-forward).
 *
 * SIMPLE, transparent monthly calculation from ACTUAL attendance punches:
 *   Base Required Hours  = Working Days × 9h            (every scheduled working day = 9h)
 *   Approved Leave Hours = full leave × 9h + half leave × 5h   (reduces the requirement)
 *   Approved Adjustment  = Σ approved hour-adjustments + approved early-logouts (the days they apply to)
 *   Final Required Hours = Base Required − Approved Leave − Approved Adjustment − (Absent Days × 9h)
 *   Total Worked Hours   = Σ actual punch hours of Present days + Half days
 *   Monthly Difference   = Total Worked Hours − Final Required Hours
 *   Shortage Hours       = max(0, −Monthly Difference)
 *   Salary Deduction     = Shortage Hours × existing hourly rate
 *
 * NOTES:
 *  - "Actual punch hours" = computeSession.effectiveHours (span − breaks). Late arrival is
 *    NEVER subtracted again — the real worked duration is used as-is.
 *  - The Half Day LABEL never reduces required hours by itself (§7). A short day only
 *    shorts if worked < its ADJUSTED requirement (9h − any approved hour adjustment).
 *  - An APPROVED HOUR ADJUSTMENT (from the Attendance Request approval system) reduces
 *    ONLY that day's required hours (capped at a full day). It is NOT a deduction, NOT
 *    counted as worked hours, and never applied twice (§3, §20).
 *  - ABSENT (scheduled working day, no punch, no approved leave) is a SEPARATE day-based
 *    LOP category (existing payroll mechanism); its hours are removed from Final Required
 *    so an absent day is never double-counted (LOP + hourly shortage).
 *  - NO Effective-Hours line, NO Overtime, NO carry-forward feed this calculation. Overtime
 *    stays a separate payroll figure and does NOT affect the Monthly Difference.
 *  - Historical dates use the shift effective on that date (shift history).
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
 * PURE monthly summary from already-aggregated inputs. No I/O, no carry-forward.
 * This is the per-day balance model, aggregated:
 *   Base Required   = Working Days × fullDayExpected (9)
 *   Final Required  = Base − Approved Leave Hours − Approved Adjustment Hours − (Absent Days × 9)
 *   Total Worked    = Present punch hours + Half-day punch hours   (ACTUAL punch hours)
 *   Difference      = Total Worked − Final Required        (= Σ daily balances)
 *   Shortage        = max(0, −Difference)
 * An APPROVED HOUR ADJUSTMENT (HR-granted, per day) reduces ONLY that day's required
 * hours — it is NOT a deduction, NOT worked hours (never double-counted, §20). The
 * Half Day LABEL never reduces required hours by itself (§7): a short day only shorts
 * if worked < its adjusted requirement. ABSENT days are removed entirely (separate
 * day-based LOP). Overtime/late never enter this calc.
 * @param {{workingDays:number, approvedLeaveHours:number, approvedAdjustmentHours:number,
 *          absentDays:number, presentWorkedHours:number, halfWorkedHours:number, fullDayExpected?:number}} p
 */
function computeMonthlySummary({ workingDays = 0, approvedLeaveHours = 0, approvedAdjustmentHours = 0, absentDays = 0, presentWorkedHours = 0, halfWorkedHours = 0, incompleteDays = 0, incompleteSurplusHours = 0, incompleteFirmShortageHours = 0, fullDayExpected = 9 } = {}) {
  const fd = num(fullDayExpected) || 9;
  const baseRequiredHours = round2(num(workingDays) * fd);
  // INCOMPLETE (missing-punch) days are pulled OUT of the OT-poolable requirement (like absent
  // days), so OT / other days' surplus can NEVER cover a missing-punch shortfall (that shortfall
  // is FIRM — added below and only ever resolved by an approved correction). Their genuine
  // SURPLUS (worked beyond required) still flows into totalWorkedHours, so an employee who worked
  // a long/OT day with a missing punch is not broken — their extra hours still cover other days.
  const finalRequiredHours = Math.max(0, round2(baseRequiredHours - num(approvedLeaveHours) - num(approvedAdjustmentHours) - num(absentDays) * fd - num(incompleteDays) * fd));
  const totalWorkedHours = round2(num(presentWorkedHours) + num(halfWorkedHours) + num(incompleteSurplusHours));
  const monthlyDifference = round2(totalWorkedHours - finalRequiredHours);
  // Pool shortage = complete-day shortfall after OT/surplus. Firm incomplete shortage is added
  // on top and is never reducible by OT. Total = the employee-explainable LOP hours.
  const poolShortageHours = monthlyDifference < 0 ? round2(-monthlyDifference) : 0;
  const shortageHours = round2(poolShortageHours + num(incompleteFirmShortageHours));
  return { baseRequiredHours, approvedLeaveHours: round2(approvedLeaveHours), approvedAdjustmentHours: round2(approvedAdjustmentHours), finalRequiredHours, totalWorkedHours, monthlyDifference, poolShortageHours, incompleteFirmShortageHours: round2(incompleteFirmShortageHours), shortageHours };
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

  // Approved required-hour REDUCTIONS (from the Attendance Request approval system) →
  // date → { adj, el }. Two kinds both reduce ONLY that day's required working hours:
  //   • hour_adjustment — HR-granted hours (§2)
  //   • early_logout    — permitted early leave; granted hours = shift end − requested logout
  // Read-only; the hours column is optional so this degrades to "none" until one exists.
  const adjMap = new Map();
  try {
    const REQ = d365.constructor.entities.attendanceRequest;
    const { data: reqs } = await d365.getListOptional(REQ, {
      select: 'hr_attendancedate,hr_punchtype,hr_status', optionalSelect: 'hr_adjustmenthours',
      filter: `hr_employeeid eq '${employeeId}' and hr_status eq 'approved' and (hr_punchtype eq 'hour_adjustment' or hr_punchtype eq 'early_logout')`,
    });
    for (const a of (reqs || [])) {
      const ds = String(a.hr_attendancedate || '').slice(0, 10);
      const h = Number(a.hr_adjustmenthours) || 0;
      if (!ds || !(h > 0)) continue;
      const cur = adjMap.get(ds) || { adj: 0, el: 0 };
      if (a.hr_punchtype === 'early_logout') cur.el = round2(cur.el + h);
      else cur.adj = round2(cur.adj + h);
      adjMap.set(ds, cur);
    }
  } catch { /* table/column not provisioned yet → no adjustments */ }

  const firstDate = await firstAttendanceDate(employeeId);
  let effFrom = firstDate && firstDate > from ? firstDate : from;   // clamp to first punch
  // EFFECTIVE DATE: never look at dates before the cutoff, so pre-cutoff days never
  // enter the balance and a pre-cutoff month yields an empty (zero) result.
  const cutoff = policy.attendance.newRulesFrom();
  if (effFrom < cutoff) effFrom = cutoff;
  const graceMin = await resolveGraceMinutes();
  const nowMin = (() => { const [h, mi] = String(time.istHHMM() || '00:00').split(':').map(Number); return (h || 0) * 60 + (mi || 0); })();

  const fd = fullDayExpected();   // 9 (configurable via Company Settings)
  let workingDays = 0, presentDays = 0, presentWorkedHours = 0, halfDays = 0, halfWorkedHours = 0;
  let absentDays = 0, approvedLeaveDays = 0, approvedLeaveHours = 0, approvedAdjustmentHours = 0, adjustedDays = 0;
  // Missing-punch (incomplete) days: tracked SEPARATELY from the OT pool. Confirmed hours cover
  // only their own required (firm shortfall never OT-covered); surplus stays poolable.
  let incompleteDays = 0, incompleteConfirmedHours = 0, incompleteFirmShortageHours = 0, incompleteSurplusHours = 0;
  let approvedHourAdjustmentHours = 0, approvedEarlyLogoutHours = 0;   // breakdown of the reduction (display)
  const end = new Date(`${capTo}T00:00:00Z`);
  for (let d = new Date(`${effFrom}T00:00:00Z`); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
    const ds = `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
    const dow = d.getUTCDay();

    // Holiday / Weekly-off → NOT a scheduled working day (excluded from Working Days).
    if (attnCfg.holidays.includes(ds) || attnCfg.weekOffDays.includes(dow)) continue;

    const shift = shiftResolver.forDate(ds);
    const rec = recByDate.get(ds);
    const worked = rec ? computeSession(punchesFromRecord(rec), shift, { graceMinutes: shift.grace, date: ds }) : null;

    // Today, before shift-start + grace, is Pending — not yet a scheduled/countable day.
    if (!worked && ds === today && !gracePassedToday(shift, graceMin, nowMin)) continue;

    // TODAY with an OPEN session (checked in, not yet out) → NOT finalized. Treat it as
    // Pending — exactly like a no-punch today — so a day still in progress never inflates
    // Working Days / Required Hours and never creates a phantom mid-day shortage (§5, §14).
    if (worked && worked.status === 'in_progress' && ds === today) continue;

    workingDays++;   // a scheduled working day (present / half / approved-leave / absent)

    // Approved leave → reduces the required hours (full day 9h, half day 5h). Never worked,
    // never Absent, never LOP. (Half-day leave, if ever introduced, would remove 5h.)
    if (leaveMap.has(ds)) { approvedLeaveDays++; approvedLeaveHours += fd; continue; }

    if (worked) {
      // ATTENDED: credit ACTUAL punch hours (effective = span − breaks; open sessions
      // count only completed IN→OUT time). The Half Day LABEL never reduces required hours
      // by itself (§7) — a short day only shorts if worked < its ADJUSTED requirement.
      // An approved HOUR ADJUSTMENT reduces THIS day's required hours (capped at a full
      // day) — applied on attended days only, so it is never double-counted with leave
      // (already 0 required) or absent (separate LOP).
      const cur = adjMap.get(ds) || { adj: 0, el: 0 };
      const combined = Math.min(round2(cur.adj + cur.el), fd);   // total reduction for the day, capped
      const requiredForDay = Math.max(0, round2(fd - combined));  // this day's required hours after any approved reduction

      // MISSING-PUNCH (incomplete) day — handled OUTSIDE the OT pool. Its confirmed hours offset
      // only its OWN required; any unmet hours are a FIRM shortage (never covered by OT until an
      // Attendance Correction is approved, which makes the punches even → a normal day). Any
      // surplus (worked beyond required) is genuine OT and still helps the pool.
      if (worked.status === 'incomplete') {
        const confirmed = num(worked.effectiveHours);
        incompleteDays++;
        halfDays++;   // DISPLAY day-count unchanged (incomplete still shows as a 0.5 present day, like before)
        incompleteConfirmedHours = round2(incompleteConfirmedHours + confirmed);
        incompleteFirmShortageHours = round2(incompleteFirmShortageHours + Math.max(0, round2(requiredForDay - confirmed)));
        incompleteSurplusHours = round2(incompleteSurplusHours + Math.max(0, round2(confirmed - requiredForDay)));
        continue;   // never enters the poolable required/worked totals
      }

      if (combined > 0) {
        approvedAdjustmentHours = round2(approvedAdjustmentHours + combined);   // feeds Final Required
        approvedHourAdjustmentHours = round2(approvedHourAdjustmentHours + cur.adj);
        approvedEarlyLogoutHours = round2(approvedEarlyLogoutHours + cur.el);
        adjustedDays++;
      }
      if (worked.status === 'present') { presentDays++; presentWorkedHours += num(worked.effectiveHours); }
      else { halfDays++; halfWorkedHours += num(worked.effectiveHours); }   // half_day
    } else {
      absentDays++;   // scheduled working day, no punch, no approved leave → day-based LOP (separate)
    }
  }

  const summary = computeMonthlySummary({ workingDays, approvedLeaveHours, approvedAdjustmentHours, absentDays, presentWorkedHours, halfWorkedHours, incompleteDays, incompleteSurplusHours, incompleteFirmShortageHours, fullDayExpected: fd });
  return {
    year: y, month: m,
    workingDays,
    presentDays, presentWorkedHours: round2(presentWorkedHours),
    halfDays, halfWorkedHours: round2(halfWorkedHours),
    // Missing-punch days: confirmed hours + FIRM shortfall (not OT-covered) + poolable surplus.
    incompleteDays, incompleteConfirmedHours: round2(incompleteConfirmedHours),
    incompleteSurplusHours: round2(incompleteSurplusHours),
    absentDays, approvedLeaveDays, adjustedDays,
    approvedHourAdjustmentHours: round2(approvedHourAdjustmentHours),
    approvedEarlyLogoutHours: round2(approvedEarlyLogoutHours),
    ...summary,   // baseRequiredHours, approvedLeaveHours, approvedAdjustmentHours (total), finalRequiredHours, totalWorkedHours, monthlyDifference, shortageHours
  };
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

module.exports = { computeMonthlySummary, buildMonthlyBalance, estimateSalaryDeduction, firstAttendanceDate };
