/**
 * Attendance punch-session math — SINGLE SOURCE OF TRUTH for web + device.
 *
 * Punch model: hr_allpunches is an array of {t:"HH:MM", d:"in"|"out"}.
 *  - Device direction (AttendStat) is used when present.
 *  - Legacy string arrays ["09:00","12:00"] and intime/outtime-only records are
 *    accepted and paired by order (backward compatible — no migration).
 *
 * All thresholds are SHIFT-AWARE (no fixed office timing):
 *  - halfDayThreshold = shiftDuration / 2
 *  - Present = effective >= halfDayThreshold ; Half Day = 0 < effective < threshold
 *  - Overtime = max(0, effective - shiftDuration)
 *  - Late = firstPunch - shiftStart ; Early = shiftEnd - lastPunch
 *  - Night shifts (end <= start) handled for span/overtime.
 */
const cfg = require('./attendance.config');
const policy = require('./company.policy');

const toMin = (hhmm) => { const [h, m] = String(hhmm || '').split(':').map(Number); return (h || 0) * 60 + (m || 0); };
const round2 = (n) => Math.round(n * 100) / 100;

// Late Entry grace: EXACTLY 5 minutes past shift start (fixed, not configurable).
const LATE_ENTRY_GRACE_MIN = 5;

/** Normalize raw punches (strings or {t,d}) → sorted [{t,d}] with a direction on each. */
function normalizePunches(raw) {
  let arr = Array.isArray(raw) ? raw : [];
  arr = arr
    .map(p => (p && typeof p === 'object') ? { t: p.t || p.time, d: p.d || p.dir || null } : { t: p, d: null })
    .filter(p => p.t);
  // Preserve chronological insertion order (punches arrive in time order).
  // Do NOT sort by HH:MM — that would misorder night shifts crossing midnight.
  return arr.map((p, i) => ({ t: p.t, d: p.d || (i % 2 === 0 ? 'in' : 'out') }));
}

/** Extract raw punches from a record (handles legacy hr_intime/hr_outtime rows). */
function punchesFromRecord(record) {
  let p = [];
  try { p = JSON.parse(record?.hr_allpunches || '[]'); } catch (_) { p = []; }
  if (!Array.isArray(p)) p = [];
  if (p.length === 0) {
    if (record?.hr_intime) p.push(record.hr_intime);
    if (record?.hr_outtime) p.push(record.hr_outtime);
  }
  return p;
}

/**
 * DAILY worked-hours classification (fixed rules). The employee shift still governs
 * late/early/overtime; these thresholds are worked-hour rules, not office timings.
 *   effective >= fullDayMinHours (7)  → 'present'  (Full Day)
 *   0 punches                         → 'absent'
 *   otherwise (punched, < full)       → 'half_day' (Half Day for 5–7h; below 5h uses
 *                                        the same below-half handling — never Absent
 *                                        when a punch exists; monthly LOP is a later phase)
 * 'incomplete' is intentionally NOT produced: a missing/odd punch is a data-quality
 * flag carried by `attendanceIssue`, not an attendance status.
 */
function classifyStatus(effectiveHours, punchCount, { fullDayMinHours = 7 } = {}) {
  if (!punchCount) return 'absent';
  if (effectiveHours >= fullDayMinHours) return 'present';
  return 'half_day';
}

/** Expected credited hours for a day's status (monthly-balance preparation). */
function expectedHoursFor(status, { fullDayExpectedHours = 9, halfDayExpectedHours = 5 } = {}) {
  if (status === 'present') return fullDayExpectedHours;
  if (status === 'half_day') return halfDayExpectedHours;
  return 0;   // absent → no expectation
}

/** Sum of break time: every OUT→IN gap. */
function breakHours(punches) {
  let total = 0;
  for (let i = 0; i < punches.length - 1; i++) {
    if (punches[i].d === 'out' && punches[i + 1].d === 'in') {
      total += (toMin(punches[i + 1].t) - toMin(punches[i].t)) / 60;
    }
  }
  return round2(total);
}

/**
 * Compute the full attendance session for a set of punches under a shift.
 * opts:
 *   leaveUntil     "HH:MM" — approved leave end time; offsets the late-arrival
 *                  baseline (company policy #4: leave offsets late calculation).
 *   requiredHours  number  — hours needed to "complete the shift" for compensation
 *                  (default = shift duration).
 *
 * Company policy: STATUS is decided by EFFECTIVE HOURS only — late arrival never
 * reduces attendance. Late/early are recorded for reporting; if the employee
 * completes the required hours despite arriving late, compensation = compensated
 * (no payroll deduction).
 */
function computeSession(rawPunches, shiftInput, opts = {}) {
  const shift = (shiftInput && shiftInput.durationHours) ? shiftInput : cfg.resolveShift(shiftInput);
  const punches = normalizePunches(rawPunches);
  const count = punches.length;
  const state = count === 0 ? 'none' : (punches[count - 1].d === 'in' ? 'in' : 'out');
  const firstPunch = count ? punches[0].t : null;
  const lastPunch = count ? punches[count - 1].t : null;

  let totalSpanHours = 0;
  if (count >= 2) {
    let diff = toMin(lastPunch) - toMin(firstPunch);
    if (diff < 0) diff += 1440; // crossed midnight (night shift)
    totalSpanHours = round2(diff / 60);
  }
  const breakH = breakHours(punches);
  const effectiveHours = Math.max(0, round2(totalSpanHours - breakH));
  // Overtime = effective hours beyond the company standard (default 9h), NOT the
  // shift span — so working past 9h earns overtime regardless of a longer shift.
  const overtimeAfter = Number.isFinite(opts.overtimeAfterHours) ? opts.overtimeAfterHours : policy.attendance.overtimeAfterHours();
  const overtimeHours = Math.max(0, round2(effectiveHours - overtimeAfter));
  // Daily classification thresholds come from the Company Policy layer (fixed
  // worked-hour rules; overridable via opts for tests). requiredHours (shift-based)
  // stays as the compensation "completed the shift" baseline — unchanged.
  const fullDayMinHours = Number.isFinite(opts.fullDayMinHours) ? opts.fullDayMinHours : policy.attendance.fullDayMinHours();
  const halfDayMinHours = Number.isFinite(opts.halfDayMinHours) ? opts.halfDayMinHours : policy.attendance.halfDayMinHours();
  const requiredHours = Number.isFinite(opts.requiredHours) ? opts.requiredHours : policy.attendance.requiredShiftHours(shift.durationHours);

  // Late baseline = max(shift start, approved-leave end) — leave offsets late (#4).
  // LATE ENTRY grace is EXACTLY 5 minutes (fixed, not configurable): a punch within
  // Shift Start + 5 min is On Time; only a check-in AFTER that is a Late Entry. Grace
  // affects Late Minutes ONLY — never the Present/Half/Absent status (no salary impact).
  const graceMin = Number.isFinite(opts.graceMinutes) ? opts.graceMinutes : LATE_ENTRY_GRACE_MIN;
  let lateArrivalMin = 0, earlyDepartureMin = 0, lateEntryMinutes = 0;
  if (firstPunch) {
    const baseline = opts.leaveUntil ? Math.max(toMin(shift.start), toMin(opts.leaveUntil)) : toMin(shift.start);
    let d = toMin(firstPunch) - baseline;
    if (shift.isNight && d < -720) d += 1440;
    lateArrivalMin = Math.max(0, d - graceMin);
    // "Late By" is measured from the ACTUAL shift start (NOT the grace end): a 09:06
    // check-in on a 09:00 shift with a 5-min grace = Late By 6 (not 1). It is set only
    // once the check-in is past the grace window (09:05 → 0, 09:06 → 6, 09:30 → 30).
    lateEntryMinutes = d > graceMin ? Math.max(0, d) : 0;
  }
  if (lastPunch && state === 'out') {
    const endMin = toMin(shift.end) + (shift.isNight ? 1440 : 0);
    const lastMin = toMin(lastPunch) + ((shift.isNight && toMin(lastPunch) < toMin(shift.start)) ? 1440 : 0);
    earlyDepartureMin = Math.max(0, (endMin - lastMin) - cfg.earlyGraceMinutes);
  }

  // Status — DAILY worked-hours rule on EFFECTIVE HOURS (late never reduces
  // attendance; policy #1–3). A day with ANY punch is NEVER Absent. There is NO
  // 'incomplete' status — a missing/odd punch is reported via attendanceIssue below.
  //   effective >= 7 → present (Full Day) ; punched & < 7 → half_day ; no punch → absent.
  const isOdd = count % 2 === 1;
  const status = classifyStatus(effectiveHours, count, { fullDayMinHours });

  // Expected hours + daily balance — monthly-calculation preparation. COMPUTED only
  // (never stored): Full Day expects 9h, Half Day expects 5h; balance = worked − expected.
  const expectedHours = expectedHoursFor(status, {
    fullDayExpectedHours: Number.isFinite(opts.fullDayExpectedHours) ? opts.fullDayExpectedHours : policy.attendance.fullDayExpectedHours(),
    halfDayExpectedHours: Number.isFinite(opts.halfDayExpectedHours) ? opts.halfDayExpectedHours : policy.attendance.halfDayExpectedHours(),
  });
  const dailyBalanceHours = round2(effectiveHours - expectedHours);

  // Attendance issue / type (reporting only): which punch is missing, or Normal.
  // Missing-punch detection is punch-parity based (independent of status) so the
  // Missed Punch email + summary keep working without an 'incomplete' status.
  let attendanceIssue = '';
  if (count > 0) {
    if (isOdd) attendanceIssue = punches[0].d === 'out' ? 'Missing Check In' : 'Missing Check Out';
    else attendanceIssue = 'Normal';
  }

  // FACT only — did the employee complete the required hours? The Payroll Engine
  // (not attendance) decides any salary deduction from this fact.
  const metRequiredHours = effectiveHours >= requiredHours;

  // Compensation STATUS is a reporting label (no salary meaning): a late/early
  // employee who still completed the required hours is "compensated".
  const hadDeviation = lateArrivalMin > 0 || earlyDepartureMin > 0;
  const compensationStatus = !hadDeviation ? 'on_time' : (metRequiredHours ? 'compensated' : 'shortfall');

  return {
    punches, count, state, firstPunch, lastPunch,
    totalSpanHours, breakHours: breakH, effectiveHours, overtimeHours,
    fullDayThreshold: fullDayMinHours, halfDayThreshold: halfDayMinHours, requiredHours,
    expectedHours, dailyBalanceHours,
    graceMinutes: graceMin, lateArrivalMin, lateEntryMinutes, earlyDepartureMin,
    status, metRequiredHours, compensationStatus, attendanceIssue,
    shift: { code: shift.code, name: shift.name, start: shift.start, end: shift.end, durationHours: shift.durationHours },
  };
}

/** Backward-compatible wrapper (used by existing routes/tests). Default shift unless a code is passed. */
function computeFromPunches(rawPunches, shiftCode) {
  const c = computeSession(rawPunches, shiftCode);
  return {
    punches: c.punches, count: c.count, state: c.state,
    firstPunch: c.firstPunch, lastPunch: c.lastPunch,
    workedHours: c.totalSpanHours, breakDuration: c.breakHours,
    effectiveHours: c.effectiveHours, overtime: c.overtimeHours, status: c.status,
  };
}

module.exports = { normalizePunches, punchesFromRecord, breakHours, computeSession, computeFromPunches, classifyStatus, expectedHoursFor, LATE_ENTRY_GRACE_MIN };
