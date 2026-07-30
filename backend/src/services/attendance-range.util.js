/**
 * Dynamic Attendance Start Date helpers — pure, testable, no I/O and NO hardcoded
 * dates. An employee's Attendance Start Date is the earliest attendance record of
 * ANY source (device punch / web check-in / approved manual attendance); every
 * date range is clamped so it can never begin before it.
 */

/**
 * Earliest attendance date (min hr_date) across a set of records. Reads hr_date
 * (raw D365 record) or date (already-computed session). Returns 'YYYY-MM-DD' or
 * null when there are no records.
 */
function earliestAttendanceDate(records = []) {
  let min = null;
  for (const r of records) {
    const d = String((r && (r.hr_date ?? r.date)) || '').slice(0, 10);
    if (!d) continue;
    if (!min || d < min) min = d;
  }
  return min;
}

/**
 * Clamp a [from, to] range so it never starts before the Attendance Start Date.
 * Returns { from, to, clamped }. When startDate is falsy (no attendance history)
 * the range is returned unchanged. `from` is pulled up to startDate whenever it
 * falls earlier — this is what makes "This Year" become "firstDate → today".
 */
function clampRangeToStart(from, to, startDate) {
  if (!startDate) return { from, to, clamped: false };
  if (from && from < startDate) return { from: startDate, to, clamped: true };
  return { from, to, clamped: false };
}

module.exports = { earliestAttendanceDate, clampRangeToStart };
