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
  const overtimeHours = Math.max(0, round2(effectiveHours - shift.durationHours));
  // Thresholds come from the Company Policy layer (fall back to the shift).
  const halfDayThreshold = Number.isFinite(opts.halfDayThreshold) ? opts.halfDayThreshold : policy.attendance.halfDayThreshold(shift.durationHours);
  const requiredHours = Number.isFinite(opts.requiredHours) ? opts.requiredHours : policy.attendance.requiredShiftHours(shift.durationHours);

  // Late baseline = max(shift start, approved-leave end) — leave offsets late (#4).
  // Grace period (company policy, default 5 min) is subtracted: a punch within
  // the grace window is On Time (lateArrivalMin = 0); late is counted only AFTER
  // grace. Grace affects Late Minutes ONLY — never the Present/Half/Absent status.
  const graceMin = Number.isFinite(opts.graceMinutes) ? opts.graceMinutes : policy.attendance.graceMinutes();
  let lateArrivalMin = 0, earlyDepartureMin = 0;
  if (firstPunch) {
    const baseline = opts.leaveUntil ? Math.max(toMin(shift.start), toMin(opts.leaveUntil)) : toMin(shift.start);
    let d = toMin(firstPunch) - baseline;
    if (shift.isNight && d < -720) d += 1440;
    lateArrivalMin = Math.max(0, d - graceMin);
  }
  if (lastPunch && state === 'out') {
    const endMin = toMin(shift.end) + (shift.isNight ? 1440 : 0);
    const lastMin = toMin(lastPunch) + ((shift.isNight && toMin(lastPunch) < toMin(shift.start)) ? 1440 : 0);
    earlyDepartureMin = Math.max(0, (endMin - lastMin) - cfg.earlyGraceMinutes);
  }

  // Status — EFFECTIVE HOURS ONLY (late never reduces attendance; policy #1–3).
  // A day with ANY punch is NEVER Absent — only a punch-free day can be Absent.
  // An odd (unmatched) punch count means a punch is missing → Incomplete.
  const isOdd = count % 2 === 1;
  let status;
  if (count === 0) status = 'absent';
  else if (isOdd) status = 'incomplete';
  else if (effectiveHours < halfDayThreshold) status = 'half_day';
  else status = 'present';

  // Attendance issue / type (reporting only): which punch is missing, or Normal.
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
    halfDayThreshold, requiredHours, graceMinutes: graceMin, lateArrivalMin, earlyDepartureMin,
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

module.exports = { normalizePunches, punchesFromRecord, breakHours, computeSession, computeFromPunches };
