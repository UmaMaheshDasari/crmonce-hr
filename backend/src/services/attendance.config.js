/**
 * Attendance configuration — env-driven, no hardcoded office timings.
 * Shift-aware: all thresholds derive from the employee's assigned shift.
 */
const num = (v, d) => { const n = parseFloat(v); return Number.isFinite(n) ? n : d; };
const parseList = (v) => String(v || '').split(',').map(s => s.trim()).filter(Boolean);
const toMin = (hhmm) => { const [h, m] = String(hhmm || '0:0').split(':').map(Number); return (h || 0) * 60 + (m || 0); };

// Named shifts. Times are "HH:MM". A shift is a NIGHT shift when end <= start
// (it crosses midnight). Override the whole set via SHIFTS_JSON.
const DEFAULT_SHIFTS = {
  GENERAL:  { name: 'General',   start: '09:00', end: '18:00' },
  MORNING:  { name: 'Morning',   start: '07:00', end: '17:00' },
  DAY:      { name: 'Day',       start: '08:00', end: '18:00' },
  EVENING:  { name: 'Evening',   start: '11:30', end: '21:30' },
  NIGHT:    { name: 'Night',     start: '13:30', end: '23:30' },
};

let shifts = DEFAULT_SHIFTS;
try { if (process.env.SHIFTS_JSON) shifts = JSON.parse(process.env.SHIFTS_JSON); } catch (_) { /* keep defaults */ }

const defaultShiftCode = process.env.DEFAULT_SHIFT && shifts[process.env.DEFAULT_SHIFT]
  ? process.env.DEFAULT_SHIFT : 'GENERAL';

/** Duration in hours, handling overnight (end <= start → +24h). */
function shiftDurationHours(shift) {
  const dur = toMin(shift.end) - toMin(shift.start) + (toMin(shift.end) <= toMin(shift.start) ? 1440 : 0);
  return Math.round(dur / 60 * 100) / 100;
}

/** Resolve a shift code → { code, name, start, end, durationHours, isNight }. Falls back to default. */
function resolveShift(code) {
  const c = code && shifts[code] ? code : defaultShiftCode;
  const s = shifts[c] || DEFAULT_SHIFTS.GENERAL;
  return {
    code: c,
    name: s.name || c,
    start: s.start,
    end: s.end,
    durationHours: shiftDurationHours(s),
    isNight: toMin(s.end) <= toMin(s.start),
  };
}

module.exports = {
  shifts,
  defaultShiftCode,
  resolveShift,
  shiftDurationHours,
  // Week-off days 0=Sun … 6=Sat (configurable, never hardcoded).
  weekOffDays: parseList(process.env.WEEK_OFF_DAYS || '0,6').map(Number).filter(n => n >= 0 && n <= 6),
  holidays: parseList(process.env.HOLIDAYS),                 // YYYY-MM-DD (optionally from hr_holiday later)
  lateGraceMinutes: num(process.env.LATE_GRACE_MINUTES, 0),
  earlyGraceMinutes: num(process.env.EARLY_GRACE_MINUTES, 0),
  _toMin: toMin,
};
