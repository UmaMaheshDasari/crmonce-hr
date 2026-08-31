/**
 * Missing-punch detection + correction — pure, testable, no I/O.
 *
 * Punches are stored as an ordered array of "HH:MM" strings and paired by position
 * (even index = IN, odd = OUT). A forgotten punch therefore shifts the pairing and
 * corrupts Break / Effective hours. This module (1) DETECTS a likely missing punch
 * and (2) INSERTS an approved correction back into the ordered array, after which
 * computeSession recalculates everything from the corrected punches.
 */
const { normalizePunches } = require('./attendance.util');

const toMin = (hhmm) => { const [h, m] = String(hhmm || '').split(':').map(Number); return (h || 0) * 60 + (m || 0); };

// Attendance Correction types. The "Correct Time" is inserted into the day's
// punches on approval; the type is descriptive (drives the request label/reason).
const PUNCH_TYPES = {
  missing_check_in: 'Missing Check In',
  missing_check_out: 'Missing Check Out',
  missed_break_out: 'Missed Break Out',
  missed_break_in: 'Missed Break In',
  device_failure: 'Device Failure',
  web_checkin_issue: 'Web Check-in Issue',
  other: 'Other',
  // DELETE PUNCH: remove an existing (accidental/extra) punch from the day. The punch to
  // delete is carried in hr_requestedtime; on approval it is removed and the day recomputed.
  delete_punch: 'Delete Punch',
  // Approved HOUR ADJUSTMENT: HR grants N hours that reduce THAT day's required
  // working hours (not a punch correction — no attendance record is changed).
  hour_adjustment: 'Hour Adjustment',
  // Approved EARLY LOGOUT: employee is permitted to leave before shift end; the
  // granted hours (shift end − requested logout) reduce THAT day's required hours.
  // Same effect as an hour adjustment; no punch/attendance record is changed.
  early_logout: 'Early Logout',
  // legacy values kept for backward compatibility with existing records:
  lunch_out: 'Missed Break Out',
  lunch_in: 'Missed Break In',
};

// Request types that DON'T insert a punch / touch the attendance record on approval —
// they only grant hours that reduce the day's required working hours.
const NON_PUNCH_TYPES = new Set(['hour_adjustment', 'early_logout']);

/**
 * Analyse a set of punches and report likely missing punches. Signals:
 *  - an ODD number of punches → a check-in or check-out is missing;
 *  - two CONSECUTIVE punches in the same direction → a punch is missing between
 *    them (e.g. two INs with no OUT = a forgotten lunch-out).
 * Returns { hasIssue, issues:[{code,label}], count }.
 */
function detectMissingPunches(rawPunches) {
  const punches = normalizePunches(rawPunches);
  const count = punches.length;
  const issues = [];
  if (count === 0) return { hasIssue: false, issues, count };

  if (count % 2 === 1) {
    issues.push(punches[0].d === 'out'
      ? { code: 'missing_check_in', label: 'Missing Check In' }
      : { code: 'missing_check_out', label: 'Missing Check Out' });
  }
  for (let i = 1; i < count; i++) {
    if (punches[i].d === punches[i - 1].d) {
      issues.push(punches[i].d === 'in'
        ? { code: 'lunch_out', label: 'Consecutive IN — a check-out (e.g. Lunch Out) is missing' }
        : { code: 'lunch_in', label: 'Consecutive OUT — a check-in (e.g. Lunch In) is missing' });
    }
  }
  return { hasIssue: issues.length > 0, issues, count };
}

/**
 * Insert a corrected punch time into an ordered list of "HH:MM" strings, keeping
 * the list chronological (day-shift). Because pairing is positional, dropping the
 * time into the right slot restores correct IN/OUT pairing. Returns a NEW array.
 */
function insertPunchTime(times, newTime) {
  const t = String(newTime || '').slice(0, 5);
  if (!/^\d{1,2}:\d{2}$/.test(t)) return Array.isArray(times) ? [...times] : [];
  const list = (Array.isArray(times) ? times : []).map(x => (x && typeof x === 'object') ? x.t : x).filter(Boolean);
  const nm = toMin(t);
  let idx = list.findIndex(x => toMin(x) > nm);
  if (idx === -1) idx = list.length;
  return [...list.slice(0, idx), t, ...list.slice(idx)];
}

/**
 * Remove ONE punch (the first whose time matches `target`) from an ordered list of "HH:MM"
 * strings — used when an approved DELETE-punch correction removes an accidental/extra punch.
 * All other punches are preserved and pairing is restored positionally on recompute. If no
 * punch matches, the list is returned UNCHANGED (never deletes an unrelated punch). New array.
 */
function deletePunchTime(times, target) {
  const t = String(target || '').slice(0, 5);
  const list = (Array.isArray(times) ? times : []).map(x => (x && typeof x === 'object') ? x.t : x).filter(Boolean);
  if (!/^\d{1,2}:\d{2}$/.test(t)) return list;
  const idx = list.findIndex(x => String(x).slice(0, 5) === t);
  if (idx === -1) return list;                       // not found → no unrelated punch removed
  return [...list.slice(0, idx), ...list.slice(idx + 1)];
}

module.exports = { detectMissingPunches, insertPunchTime, deletePunchTime, PUNCH_TYPES, NON_PUNCH_TYPES };
