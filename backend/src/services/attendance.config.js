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

const DEFAULT_SHIFT_HOURS = num(process.env.DEFAULT_SHIFT_HOURS, 9);

/** Normalize a shift-start value → "HH:MM" (24h). Accepts "07:00", "7:00 AM", "01:30 PM". */
function normalizeTime(v) {
  if (v === 0) return '00:00';
  if (!v) return null;
  const m = String(v).trim().match(/(\d{1,2}):(\d{2})\s*(AM|PM)?/i);
  if (!m) return null;
  let h = parseInt(m[1], 10);
  const min = parseInt(m[2], 10);
  const ap = (m[3] || '').toUpperCase();
  if (ap === 'PM' && h < 12) h += 12;
  if (ap === 'AM' && h === 12) h = 0;
  if (h > 23 || min > 59) return null;
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}

/**
 * Build the shift for an EMPLOYEE from their assigned Shift Name + Start Time.
 * The employee's START TIME drives Late / Early Exit / Overtime — never a fixed
 * office timing. Duration is inherited from a named shift starting at the same
 * time (e.g. 07:00 → Morning's 10h), otherwise DEFAULT_SHIFT_HOURS.
 * Falls back to the default shift ONLY when no start time is stored (legacy).
 */
function resolveEmployeeShift(shiftName, shiftStart) {
  const start = normalizeTime(shiftStart);
  if (!start) return resolveShift();
  let durationHours = DEFAULT_SHIFT_HOURS;
  for (const s of Object.values(shifts)) {
    if (s.start === start) { durationHours = shiftDurationHours(s); break; }
  }
  const startMin = toMin(start);
  const endAbs = startMin + Math.round(durationHours * 60);
  const endMin = endAbs % 1440;
  const end = `${String(Math.floor(endMin / 60)).padStart(2, '0')}:${String(endMin % 60).padStart(2, '0')}`;
  return {
    code: 'EMP',
    name: shiftName || 'Shift',
    start, end, durationHours,
    isNight: endAbs > 1440 || endMin <= startMin,
  };
}

module.exports = {
  shifts,
  defaultShiftCode,
  resolveShift,
  resolveEmployeeShift,
  normalizeTime,
  shiftDurationHours,
  DEFAULT_SHIFT_HOURS,
  // Week-off days 0=Sun … 6=Sat (configurable, never hardcoded).
  weekOffDays: parseList(process.env.WEEK_OFF_DAYS || '0,6').map(Number).filter(n => n >= 0 && n <= 6),
  holidays: parseList(process.env.HOLIDAYS),                 // YYYY-MM-DD (optionally from hr_holiday later)
  lateGraceMinutes: num(process.env.LATE_GRACE_MINUTES, 0),
  earlyGraceMinutes: num(process.env.EARLY_GRACE_MINUTES, 0),
  _toMin: toMin,
};
