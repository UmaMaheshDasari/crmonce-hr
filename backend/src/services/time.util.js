/**
 * Timezone-aware time helpers — the SINGLE place that knows the display zone.
 *
 * The app operates in India. All punch times, activity feed timestamps and
 * report dates are produced/displayed in Asia/Kolkata regardless of the server
 * timezone (VPS runs UTC). We NEVER hardcode a +5:30 offset — Intl with a named
 * timeZone is DST/offset-correct and future-proof (change APP_TIMEZONE to move).
 */
const TZ = process.env.APP_TIMEZONE || 'Asia/Kolkata';
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const pad = (n) => String(n).padStart(2, '0');

/** Civil (wall-clock) parts of an instant in the app timezone. */
function civil(date = new Date()) {
  const d = date instanceof Date ? date : new Date(date);
  if (isNaN(d)) return null;
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(d);
  const g = (t) => parts.find(p => p.type === t)?.value;
  let h = g('hour'); if (h === '24') h = '00';          // some engines emit 24 at midnight
  return { y: +g('year'), mo: +g('month'), d: +g('day'), h: +h, mi: +g('minute') };
}

/** "YYYY-MM-DD" for the given instant in the app timezone (default: now). */
function istDateStr(date = new Date()) {
  const c = civil(date); if (!c) return '';
  return `${c.y}-${pad(c.mo)}-${pad(c.d)}`;
}

/** "HH:MM" (24h) for the given instant in the app timezone (default: now). */
function istHHMM(date = new Date()) {
  const c = civil(date); if (!c) return '';
  return `${pad(c.h)}:${pad(c.mi)}`;
}

/** "HH:MM" (24h) → "3:44 PM". Pure formatting, no timezone shift. */
function to12h(hhmm) {
  if (!hhmm) return '';
  const m = String(hhmm).match(/(\d{1,2}):(\d{2})/);
  if (!m) return String(hhmm);
  const h = +m[1], mi = +m[2];
  const ap = h >= 12 ? 'PM' : 'AM';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${pad(mi)} ${ap}`;
}

/** "2026-07-10" (or an ISO instant) → "10 Jul 2026" in the app timezone. */
function fmtDate(v) {
  const s = String(v || '');
  const ymd = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (ymd) return `${ymd[3]} ${MONTHS[(+ymd[2]) - 1] || ''} ${ymd[1]}`;
  const c = civil(v); if (!c) return s;
  return `${pad(c.d)} ${MONTHS[c.mo - 1] || ''} ${c.y}`;
}

/** Full instant → "3:44 PM" in the app timezone. */
function fmtTime(v) {
  const c = civil(v); if (!c) return '';
  return to12h(`${pad(c.h)}:${pad(c.mi)}`);
}

/** Whole-day number in the app timezone (for calendar-day differences). */
function dayNumber(date) {
  const c = civil(date); if (!c) return NaN;
  return Math.floor(Date.UTC(c.y, c.mo - 1, c.d) / 86400000);
}

/**
 * Relative, human time for the right-hand column:
 *   Just now · 2 minutes ago · 1 hour ago · Yesterday · 3 days ago · 10 Jul 2026
 * Day boundaries are evaluated in the app timezone.
 */
function relative(iso, now = new Date()) {
  const then = new Date(iso);
  if (isNaN(then)) return '';
  const diffMs = now.getTime() - then.getTime();
  if (diffMs < 45000) return 'Just now';
  const mins = Math.floor(diffMs / 60000);
  if (mins < 60) return `${mins} minute${mins === 1 ? '' : 's'} ago`;
  const dayDiff = dayNumber(now) - dayNumber(then);
  if (dayDiff === 0) { const h = Math.floor(mins / 60); return `${h} hour${h === 1 ? '' : 's'} ago`; }
  if (dayDiff === 1) return 'Yesterday';
  if (dayDiff < 7) return `${dayDiff} days ago`;
  return fmtDate(then.toISOString());
}

/** "Today 11:25 AM" · "Yesterday 2:45 PM" · "10 Jul 2026 3:15 PM" (app timezone). */
function dayTime(iso, now = new Date()) {
  const then = new Date(iso);
  if (isNaN(then)) return '';
  const t = fmtTime(then);
  const dayDiff = dayNumber(now) - dayNumber(then);
  if (dayDiff === 0) return `Today ${t}`;
  if (dayDiff === 1) return `Yesterday ${t}`;
  return `${fmtDate(then.toISOString())} ${t}`;
}

module.exports = { TZ, civil, istDateStr, istHHMM, to12h, fmtDate, fmtTime, dayNumber, relative, dayTime };
