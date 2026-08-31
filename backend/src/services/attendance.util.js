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
const time = require('./time.util');   // company-timezone (IST) "today" — IN PROGRESS is today-only

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
 *   0 punches                         → 'absent'
 *   TODAY's OPEN session (last=IN)    → 'in_progress'  (live; a first check-in must
 *                                        NEVER become Half Day)
 *   ODD/missing punch + 0 effective   → 'incomplete'  (a check-in with no matching
 *                                        check-out has no measurable worked time — it
 *                                        is a data-quality Incomplete, never Half Day;
 *                                        it still feeds LOP via the hours-based rules)
 *   effective >= fullDayMinHours (7)  → 'present'  (Full Day)
 *   otherwise (closed, < full)        → 'half_day' (Half Day for a completed session
 *                                        under a full day — never Absent when a punch exists)
 * Present/Half are decided ONLY on a COMPLETED session with real worked hours. A missing
 * punch is also surfaced separately via `attendanceIssue` (Missing Check In/Out).
 */
function classifyStatus(effectiveHours, punchCount, { fullDayMinHours = 7, openSession = false, oddPunch = false } = {}) {
  if (!punchCount) return 'absent';
  if (openSession) return 'in_progress';   // TODAY's open IN session → live, not yet finalized
  // A finalized day with an ODD / missing punch that produced NO completed work session
  // (effective hours = 0) is INCOMPLETE, never Half Day: with a check-in but no matching
  // check-out there is no measurable worked time, so it cannot be a valid half day. A day
  // that DID complete real hours (e.g. in→out→in = 8h, still odd) keeps its hour-based
  // status below, so genuine Present/Half days are never reclassified.
  if (oddPunch && effectiveHours <= 0) return 'incomplete';
  if (effectiveHours >= fullDayMinHours) return 'present';
  return 'half_day';
}

/**
 * A computed status → a Dataverse-storable choice. The hr_attendance_status choice
 * column has no 'in_progress' member (present/absent/half_day/incomplete/holiday), so
 * an open session persists as 'incomplete' (odd / not-finalized) and recomputes to
 * 'in_progress' on read via computeSession. No schema change; no write rejection.
 */
function statusForStorage(status) { return status === 'in_progress' ? 'incomplete' : status; }

/**
 * EARLY LOGOUT hours = scheduled shift end − requested logout time, under the given
 * shift. Returns a positive number of hours when the requested logout is BEFORE shift
 * end; 0 or negative means "not before shift end" (the caller rejects it — §5).
 * Night-shift aware (an end past midnight, or a logout past midnight, add 1440).
 * @param {object|string} shiftInput  shift object ({start,end,isNight}) or a shift code
 * @param {string} requestedLogout    "HH:MM"
 * @returns {number} hours (round2); <= 0 → invalid (not before shift end)
 */
function earlyLogoutHours(shiftInput, requestedLogout) {
  const shift = (shiftInput && shiftInput.durationHours) ? shiftInput : cfg.resolveShift(shiftInput);
  const startMin = toMin(shift.start);
  const endMin = toMin(shift.end) + ((shift.isNight && toMin(shift.end) <= startMin) ? 1440 : 0);
  let reqMin = toMin(requestedLogout);
  if (shift.isNight && reqMin < startMin) reqMin += 1440;   // logout after midnight on a night shift
  return round2((endMin - reqMin) / 60);
}

/** Expected credited hours for a day's status (monthly-balance preparation). */
function expectedHoursFor(status, { fullDayExpectedHours = 9, halfDayExpectedHours = 5 } = {}) {
  if (status === 'present') return fullDayExpectedHours;
  if (status === 'half_day') return halfDayExpectedHours;
  return 0;   // absent → no expectation
}

/**
 * LEGACY daily classification — used ONLY for attendance dates BEFORE the effective
 * date (company.policy newRulesFrom). Preserved EXACTLY as the system behaved before
 * the hour-based rules: shift-relative half-day threshold and an 'incomplete' status
 * for an odd / unmatched punch. Historical data must never change.
 */
function classifyStatusLegacy(effectiveHours, punchCount, halfDayThreshold) {
  if (!punchCount) return 'absent';
  if (punchCount % 2 === 1) return 'incomplete';
  if (effectiveHours < halfDayThreshold) return 'half_day';
  return 'present';
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
 * Pair punches into completed IN→OUT work sessions + one trailing OPEN session.
 * ONLY IN→OUT counts as worked time; OUT→IN gaps are breaks (excluded). Night-shift
 * safe (a session crossing midnight adds 1440). This is the single source of truth
 * for the punch timeline (web + device) — §18 calculateDailyPunchSessions.
 *   Σ session.minutes === effectiveHours × 60 (the open session contributes 0 until it closes).
 * @returns {{sessions: Array<{inTime:string,outTime:string,minutes:number}>, openSession: {inTime:string}|null}}
 */
function buildSessions(punches) {
  const sessions = [];
  let open = null;
  for (const p of punches) {
    if (p.d === 'in') { open = { inTime: p.t }; }        // consecutive INs: the latest is the open one
    else if (open) {                                      // OUT closes the open session
      let mins = toMin(p.t) - toMin(open.inTime);
      if (mins < 0) mins += 1440;                         // crossed midnight
      sessions.push({ inTime: open.inTime, outTime: p.t, minutes: mins });
      open = null;
    }                                                      // lone OUT (no open IN) → ignored (Missing Check In)
  }
  return { sessions, openSession: open };
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
  const sess = buildSessions(punches);   // completed IN→OUT sessions + open session (§18 timeline)
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

  // Status — EFFECTIVE-DATE aware. Attendance dates BEFORE company.policy.newRulesFrom
  // use the LEGACY rule (shift/2 half-day threshold + 'incomplete'); on/after use the new
  // fixed 7/5 rule (no 'incomplete'). No date supplied → new rules (live punches are current).
  // Late never reduces attendance; a day with ANY punch is NEVER Absent.
  const isOdd = count % 2 === 1;
  const dateStr = opts.date ? String(opts.date).slice(0, 10) : null;
  const useNewRules = !dateStr || dateStr >= policy.attendance.newRulesFrom();
  const legacyHalfThreshold = Number.isFinite(opts.halfDayThreshold) ? opts.halfDayThreshold : policy.attendance.halfDayThreshold(shift.durationHours);
  // IN PROGRESS is a LIVE state for TODAY ONLY. An open session (last punch is a
  // check-IN) is 'in_progress' only when the attendance date is today (company IST) —
  // or when NO date is supplied (a live/current computation, e.g. web check-in). A
  // PREVIOUS date with an open / missing-OUT punch is FINALIZED by its actual worked
  // hours (present / half / below-half), never 'in_progress' (§3/§6); the missing OUT
  // is surfaced separately via attendanceIssue / Missed Punch. Legacy (pre-cutoff)
  // days keep the historical 'incomplete' for an odd punch.
  const isToday = !dateStr || dateStr === time.istDateStr();
  const openSession = state === 'in' && isToday;
  const status = useNewRules
    ? classifyStatus(effectiveHours, count, { fullDayMinHours, openSession, oddPunch: isOdd })
    : classifyStatusLegacy(effectiveHours, count, legacyHalfThreshold);

  // Expected hours + daily balance — monthly-calculation preparation. COMPUTED only
  // (never stored): Full Day expects 9h, Half Day expects 5h; balance = worked − expected.
  // Apply ONLY under the new rules; legacy (pre-cutoff) days contribute 0 to the new
  // monthly balance so historical data can never leak into the new calculation.
  const expectedHours = useNewRules ? expectedHoursFor(status, {
    fullDayExpectedHours: Number.isFinite(opts.fullDayExpectedHours) ? opts.fullDayExpectedHours : policy.attendance.fullDayExpectedHours(),
    halfDayExpectedHours: Number.isFinite(opts.halfDayExpectedHours) ? opts.halfDayExpectedHours : policy.attendance.halfDayExpectedHours(),
  }) : 0;
  const dailyBalanceHours = useNewRules ? round2(effectiveHours - expectedHours) : 0;

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
    sessions: sess.sessions, openSession: sess.openSession, totalWorkedMinutes: Math.round(effectiveHours * 60),
    totalSpanHours, breakHours: breakH, effectiveHours, overtimeHours,
    fullDayThreshold: useNewRules ? fullDayMinHours : null, halfDayThreshold: useNewRules ? halfDayMinHours : legacyHalfThreshold, requiredHours,
    newRules: useNewRules, expectedHours, dailyBalanceHours,
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

module.exports = { normalizePunches, punchesFromRecord, breakHours, buildSessions, computeSession, computeFromPunches, classifyStatus, classifyStatusLegacy, expectedHoursFor, statusForStorage, earlyLogoutHours, LATE_ENTRY_GRACE_MIN };
