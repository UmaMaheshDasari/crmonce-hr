/**
 * Display formatting helpers — never render null / undefined / NaN / Invalid Date /
 * 00:00:00 / 00000. Empty values become an em dash (or a custom placeholder).
 */
const BAD = new Set(['', 'null', 'undefined', 'nan', 'invalid date', '00000']);

/** Any scalar → safe display string, or '—' when empty/invalid. */
export function fmtVal(v, placeholder = '—') {
  if (v === null || v === undefined) return placeholder;
  const s = String(v).trim();
  if (BAD.has(s.toLowerCase())) return placeholder;
  return s;
}

/** 'HH:MM' / 'HH:MM:SS' → 'hh:mm AM/PM'. Empty or 00:00 → placeholder. */
export function fmtTime(t, placeholder = '—') {
  if (!t) return placeholder;
  const m = String(t).trim().match(/^(\d{1,2}):(\d{2})(?::\d{2})?$/);
  if (!m) return placeholder;
  let h = Number(m[1]);
  const min = m[2];
  if (Number.isNaN(h) || h > 23) return placeholder;
  if (h === 0 && min === '00') return placeholder;   // 00:00[:00] placeholder
  const ap = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  return `${String(h).padStart(2, '0')}:${min} ${ap}`;
}

/**
 * GLOBAL user-facing date format = DD-MM-YYYY (e.g. 13-08-2026). THE central frontend
 * date formatter. A plain YYYY-MM-DD is formatted directly (no Date() → no timezone
 * shift); a full timestamp uses the local (app) timezone. Never renders a raw ISO.
 */
export function fmtDate(d, placeholder = '—') {
  if (!d) return placeholder;
  const ymd = String(d).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (ymd) return `${ymd[3]}-${ymd[2]}-${ymd[1]}`;
  const dt = new Date(d);
  if (Number.isNaN(dt.getTime())) return placeholder;
  const p = (n) => String(n).padStart(2, '0');
  return `${p(dt.getDate())}-${p(dt.getMonth() + 1)}-${dt.getFullYear()}`;
}

/** Date + time → 'DD-MM-YYYY hh:mm AM/PM' (date portion always DD-MM-YYYY). */
export function fmtDateTime(d, placeholder = '—') {
  if (!d) return placeholder;
  const dt = new Date(d);
  if (Number.isNaN(dt.getTime())) return fmtDate(d, placeholder);
  return `${fmtDate(d)} ${fmtTime(`${dt.getHours()}:${String(dt.getMinutes()).padStart(2, '0')}`)}`;
}

/** snake/enum → Title Case label (e.g. on_leave → On Leave). */
export function titleCase(s) {
  if (!s) return '—';
  return String(s).replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}
