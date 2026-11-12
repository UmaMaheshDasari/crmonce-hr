/**
 * Leave duration — the single source of truth for how a leave request's duration
 * is read and displayed across the app (summary lists, approval cards, history).
 *
 * A leave stores its day count in TWO fields:
 *   - hr_days    : Int32 working-day count. It is ALWAYS a whole number and is 1
 *                  for a single-day leave, even when that leave is a half day.
 *   - hr_halfday : the string 'true' when the leave is a single-working-day HALF
 *                  day. Because hr_days can never hold 0.5, this flag is the
 *                  AUTHORITATIVE source of a half day.
 *
 * (Mirrors the backend rule in backend/src/services/attendance-summary.util.js:
 *  "hr_days is an Int32 (never 0.5), so the flag is the authoritative 0.5 source".)
 *
 * Any screen that shows a leave's duration must go through these helpers so the
 * summary, the approval card and the history can never disagree.
 */

export function isHalfDayLeave(leave) {
  return String(leave?.hr_halfday) === 'true';
}

/** Numeric duration in days: 0.5 for a half day, else the whole-day hr_days (0 if absent). */
export function leaveDurationDays(leave) {
  if (isHalfDayLeave(leave)) return 0.5;
  const n = Number(leave?.hr_days);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Full breakdown for rendering.
 * @returns {{ value: number, isHalf: boolean, unit: string, label: string }}
 *   value : 0.5 | n          — the number to show (e.g. in a badge circle)
 *   isHalf: boolean          — true for a half-day leave
 *   unit  : 'day (half)' | 'day' | 'days'
 *   label : '0.5 day (half)' | '1 day' | 'N days'
 */
export function leaveDuration(leave) {
  const isHalf = isHalfDayLeave(leave);
  const value = leaveDurationDays(leave);
  const unit = isHalf ? 'day (half)' : (value === 1 ? 'day' : 'days');
  return { value, isHalf, unit, label: `${value} ${unit}` };
}
