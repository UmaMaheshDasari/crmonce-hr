/**
 * Punch-based Late Login event detection + request/punch reconciliation (spec §3).
 *
 * PURE helpers (no network, no writes). These realise the detection rules so a future
 * scheduled scanner can reuse them — but they do NOT themselves scan, count toward the tier,
 * or deduct anything. Wiring them to automatic counting/CL deduction for employees who never
 * filed a permission is a separate, higher-risk step (see the reported blocker).
 *
 * Rules implemented here:
 *   • A qualifying LATE event = the authoritative attendance record for a working day has a
 *     check-in PAST the fixed 5-minute grace (computeSession.lateEntryMinutes > 0). 09:05 on a
 *     09:00 shift is NOT late; 09:06 is. (Uses the SAME authoritative attendance engine, so an
 *     Attendance-Correction-corrected punch within grace is automatically treated as on-time.)
 *   • Incomplete / no-check-in days are NOT counted (no defensible "late" without a check-in).
 *   • Not retroactive: only dates on/after the effective date count.
 *   • EARLY LOGOUT is NEVER punch-based — these helpers are Late Login only.
 *   • Reconciliation: a date covered by BOTH a permission record and a late punch is the SAME
 *     event and is counted ONCE (dedup by date).
 */
const { computeSession } = require('./attendance.util');

// Normalise an attendance record's punches into the time-string array computeSession expects.
function punchTimes(record) {
  try {
    const { punchesFromRecord } = require('./attendance.util');
    return (punchesFromRecord(record) || []).map((p) => (p && p.t) || p).filter(Boolean);
  } catch { return []; }
}

/**
 * Evaluate ONE day's authoritative attendance record for a qualifying late Late-Login event.
 * `shift` is the shift EFFECTIVE on that date ({ start, end, grace? }); `date` is "YYYY-MM-DD".
 * Returns { date, hasCheckIn, status, lateEntryMinutes, qualifies }.
 *
 * A day qualifies ONLY when its authoritative attendance is a FINALISED worked day (present or
 * half_day) with a check-in past the grace. Incomplete / in_progress / absent days are never
 * auto-penalised (spec §2/§5) — a late check-in on a day with no check-out yet (in_progress) or
 * a missing-punch (incomplete) day does not trigger a count or a CL deduction.
 */
const FINALISED_WORKED = new Set(['present', 'half_day']);
function lateEventForDate(record, shift, date, { effectiveFrom } = {}) {
  const ds = String(date || record?.hr_date || '').slice(0, 10);
  const times = punchTimes(record);
  const hasCheckIn = times.length > 0;
  if (!hasCheckIn) return { date: ds, hasCheckIn: false, status: 'absent', lateEntryMinutes: 0, qualifies: false };
  const c = computeSession(times, shift, { graceMinutes: shift?.grace, date: ds });
  const lateEntryMinutes = Number(c?.lateEntryMinutes) || 0;
  const status = c?.status || '';
  const afterEffective = !effectiveFrom || (ds && ds >= String(effectiveFrom));
  const finalised = FINALISED_WORKED.has(status);
  return { date: ds, hasCheckIn: true, status, lateEntryMinutes, qualifies: afterEffective && finalised && lateEntryMinutes > 0 };
}

/**
 * Reconcile detected late-punch dates with the dates that ALREADY have a qualifying permission
 * record, into ONE deduped, sorted set of qualifying late-login dates (same date = one event).
 */
function reconcileQualifyingDates({ punchLateDates = [], permissionDates = [] } = {}) {
  const norm = (d) => String(d || '').slice(0, 10);
  const set = new Set([...(permissionDates || []), ...(punchLateDates || [])].map(norm).filter(Boolean));
  return [...set].sort();
}

module.exports = { lateEventForDate, reconcileQualifyingDates, punchTimes };
