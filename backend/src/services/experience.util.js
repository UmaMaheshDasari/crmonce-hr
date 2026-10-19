/**
 * Employee experience (tenure) — calendar-based Years / Months / Days from a Date of Joining
 * up to an "as of" date. Pure: no network, no timezone side-effects (the caller supplies the
 * "current date" already resolved in the app timezone via time.util.istDateStr).
 *
 * The calculation is a true calendar diff (borrow months/days from the real length of each
 * month), NEVER total-days ÷ 365 — so leap years and short/long months are exact. Missing or
 * invalid joining dates never produce a wrong (or negative) figure; a future joining date is
 * reported as "not joined yet" rather than a negative tenure.
 */

// "YYYY-MM-DD…" → { y, mo, d } civil tuple, or null when absent/not a real calendar date.
function parseCivil(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s || '').trim());
  if (!m) return null;
  const y = +m[1], mo = +m[2], d = +m[3];
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  // Reject impossible dates (e.g. 2026-02-30) by round-tripping through Date (UTC → no tz drift).
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  return { y, mo, d };
}

// Days in a given civil month (1–12). Day 0 of the next month = last day of this one.
function daysInMonth(y, mo) {
  return new Date(Date.UTC(y, mo, 0)).getUTCDate();
}

// Compare two civil tuples: <0 if a before b, 0 if equal, >0 if a after b.
function cmpCivil(a, b) {
  return a.y - b.y || a.mo - b.mo || a.d - b.d;
}

// Add `n` whole months to a civil date, clamping the day to the target month's length
// (so 31 Jan + 1 month = 28/29 Feb, never an invalid 31 Feb). n may be any non-negative integer.
function addMonths(from, n) {
  const total = (from.mo - 1) + n;
  const y = from.y + Math.floor(total / 12);
  const mo = (total % 12) + 1;
  return { y, mo, d: Math.min(from.d, daysInMonth(y, mo)) };
}

// Whole days between two civil dates (b − a), via UTC midnights (no timezone drift).
function dayCount(a, b) {
  return Math.round((Date.UTC(b.y, b.mo - 1, b.d) - Date.UTC(a.y, a.mo - 1, a.d)) / 86400000);
}

// Calendar Years/Months/Days from `from` to `to` (from ≤ to). Grows whole years, then whole
// months (each anchored to the ORIGINAL start so month-ends don't drift), then counts the
// leftover days from the clamped anchor — the relativedelta convention. Never negative.
function calendarDiff(from, to) {
  let years = 0;
  while (cmpCivil(addMonths(from, (years + 1) * 12), to) <= 0) years++;
  let months = 0;
  while (cmpCivil(addMonths(from, years * 12 + months + 1), to) <= 0) months++;
  const anchor = addMonths(from, years * 12 + months);
  return { years, months, days: dayCount(anchor, to) };
}

// "DD-MM-YYYY" (the HR app's display convention) from a civil tuple.
function fmtDMY(c) {
  return c ? `${String(c.d).padStart(2, '0')}-${String(c.mo).padStart(2, '0')}-${c.y}` : '';
}

const plural = (n, unit) => `${n} ${unit}${n === 1 ? '' : 's'}`;

/**
 * Calendar tenure from `dojStr` up to `asOfStr` (both "YYYY-MM-DD" in the app timezone).
 * Returns { valid, future, years, months, days, text, dojDisplay, asOfDisplay }.
 *   • valid  — false when the DOJ is missing/unparseable (years/months/days = 0).
 *   • future — true when the DOJ is after the as-of date (never a negative tenure).
 */
function calcExperience(dojStr, asOfStr) {
  const asOf = parseCivil(asOfStr) || parseCivil(new Date().toISOString());
  const doj = parseCivil(dojStr);
  const asOfDisplay = fmtDMY(asOf);

  if (!doj) {
    return { valid: false, future: false, years: 0, months: 0, days: 0, text: 'No Joining Date', dojDisplay: '—', asOfDisplay };
  }
  if (cmpCivil(doj, asOf) > 0) {
    // Joining date is in the future — clearly indicate, never a negative experience.
    return { valid: true, future: true, years: 0, months: 0, days: 0, text: `Not joined yet (joins ${fmtDMY(doj)})`, dojDisplay: fmtDMY(doj), asOfDisplay };
  }

  const { years, months, days } = calendarDiff(doj, asOf);
  const text = `${plural(years, 'Year')}, ${plural(months, 'Month')}, ${plural(days, 'Day')}`;
  return { valid: true, future: false, years, months, days, text, dojDisplay: fmtDMY(doj), asOfDisplay };
}

// ExcelJS column set for the Employee Experience report (shared by the service + tests).
const EXPERIENCE_COLUMNS = [
  { header: 'Employee ID', key: 'eid', width: 14 },
  { header: 'Employee Name', key: 'name', width: 26 },
  { header: 'Date of Joining', key: 'doj', width: 16 },
  { header: 'Current Date', key: 'current', width: 16 },
  { header: 'Total Experience', key: 'experience', width: 30 },
];

/**
 * Shape ONE export row from { eid, name, doj } plus the as-of (current) date string.
 * Pure — the single source of truth for what each exported cell contains.
 */
function experienceRow({ eid, name, doj }, asOfStr) {
  const exp = calcExperience(doj, asOfStr);
  return {
    eid: eid || '—',
    name: name || '—',
    doj: exp.dojDisplay,
    current: exp.asOfDisplay,
    experience: exp.text,
  };
}

module.exports = { calcExperience, experienceRow, EXPERIENCE_COLUMNS, parseCivil, fmtDMY };
