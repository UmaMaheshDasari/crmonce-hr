/**
 * Attendance punch-session math — single source of truth for both web and
 * device punches. Pure functions, unit-testable.
 *
 * Model: hr_allpunches is a sorted array of "HH:MM" strings [IN, OUT, IN, OUT…].
 *   - odd count  → currently IN  (working)
 *   - even count → currently OUT (break / left, but re-openable)
 * The session NEVER locks: a new IN is always allowed after an OUT.
 */
function calcHours(a, b) {
  if (!a || !b) return 0;
  const [ah, am] = a.split(':').map(Number);
  const [bh, bm] = b.split(':').map(Number);
  return Math.round(((bh * 60 + bm) - (ah * 60 + am)) / 60 * 100) / 100;
}

/** Sum of every OUT→IN gap: punch[1]→[2], [3]→[4], … (break time). */
function calcBreakDuration(punches) {
  if (punches.length < 3) return 0;
  let total = 0;
  for (let i = 1; i < punches.length - 1; i += 2) {
    total += calcHours(punches[i], punches[i + 1]);
  }
  return Math.round(total * 100) / 100;
}

/** Reconstruct a punch array from a record (handles legacy intime/outtime-only rows). */
function punchesFromRecord(record) {
  let p = [];
  try { p = JSON.parse(record?.hr_allpunches || '[]'); } catch (_) { p = []; }
  if (!Array.isArray(p)) p = [];
  p = p.filter(Boolean);
  if (p.length === 0) {                       // legacy record without hr_allpunches
    if (record?.hr_intime) p.push(record.hr_intime);
    if (record?.hr_outtime) p.push(record.hr_outtime);
  }
  return p;
}

/** Compute all derived fields + session state from a punch list. */
function computeFromPunches(rawPunches) {
  const punches = (Array.isArray(rawPunches) ? rawPunches : []).filter(Boolean).slice().sort();
  const count = punches.length;
  const state = count === 0 ? 'none' : (count % 2 === 1 ? 'in' : 'out');
  const firstPunch = count ? punches[0] : null;
  const lastPunch = count ? punches[count - 1] : null;

  const workedHours = count >= 2 ? calcHours(firstPunch, lastPunch) : 0;       // total span
  const breakDuration = calcBreakDuration(punches);
  const effectiveHours = Math.max(0, Math.round((workedHours - breakDuration) * 100) / 100);
  const overtime = Math.max(0, Math.round((effectiveHours - 8) * 100) / 100);

  let status;                                  // never a locked/final state
  if (count === 0) status = 'absent';
  else if (state === 'in') status = 'incomplete';               // working, or forgot final checkout
  else status = effectiveHours < 4 ? 'half_day' : 'present';    // out, but re-openable

  return {
    punches, count, state, firstPunch, lastPunch,
    workedHours, breakDuration, effectiveHours, overtime, status,
  };
}

module.exports = { calcHours, calcBreakDuration, punchesFromRecord, computeFromPunches };
