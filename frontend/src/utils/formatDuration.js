/**
 * Presentation helpers for durations — NEVER change stored/transmitted decimals.
 *
 * formatDuration(decimalHours): human-readable "Xh Ym"
 *   10.0 → "10h" · 9.6 → "9h 36m" · 9.5 → "9h 30m" · 0.6 → "36m" · 0 → "0m"
 * formatMinutes(minutes): same rules for minute values (e.g. late / early exit)
 *   24 → "24m" · 90 → "1h 30m" · 0 → "0m"
 */
export function formatDuration(decimalHours) {
  const v = Number(decimalHours);
  if (!Number.isFinite(v) || v <= 0) return '0m';
  let h = Math.floor(v);
  let m = Math.round((v - h) * 60);
  if (m === 60) { h += 1; m = 0; }      // rounding carry (e.g. 0.999h)
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}

export function formatMinutes(minutes) {
  const v = Number(minutes);
  if (!Number.isFinite(v) || v <= 0) return '0m';
  return formatDuration(v / 60);
}
