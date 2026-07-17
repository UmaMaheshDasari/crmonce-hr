const { test } = require('node:test');
const assert = require('node:assert');
const cfg = require('../src/services/attendance.config');
const { computeSession } = require('../src/services/attendance.util');

const S = (name, start) => cfg.resolveEmployeeShift(name, start);

// Required shifts: name → { start, end, duration }
const SHIFTS = [
  { name: 'Morning Shift', start: '07:00', end: '17:00', dur: 10 },
  { name: 'Day Shift',     start: '08:00', end: '18:00', dur: 10 },
  { name: 'General Shift', start: '09:00', end: '18:00', dur: 9 },
  { name: 'Evening Shift', start: '11:30', end: '21:30', dur: 10 },
  { name: 'Noon Shift',    start: '13:30', end: '23:30', dur: 10 },
];

// ── resolveEmployeeShift ────────────────────────────────────────────────────
test('resolveEmployeeShift derives start/end/duration from the assigned start', () => {
  for (const s of SHIFTS) {
    const r = S(s.name, s.start);
    assert.strictEqual(r.start, s.start, `${s.name} start`);
    assert.strictEqual(r.end, s.end, `${s.name} end`);
    assert.strictEqual(r.durationHours, s.dur, `${s.name} duration`);
    assert.strictEqual(r.name, s.name);
  }
});

test('explicit Shift End Time drives duration + early-exit (OT is the 9h standard)', () => {
  const s = cfg.resolveEmployeeShift('Custom Shift', '10:00', '16:00');   // 6h
  assert.strictEqual(s.start, '10:00');
  assert.strictEqual(s.end, '16:00');
  assert.strictEqual(s.durationHours, 6);
  assert.strictEqual(computeSession(['10:00', '15:30'], s).earlyDepartureMin, 30);  // vs 16:00 end
  assert.strictEqual(computeSession(['10:00', '17:00'], s).overtimeHours, 0);        // 7h effective < 9h standard
  assert.strictEqual(computeSession(['10:00', '20:00'], s).overtimeHours, 1);        // 10h effective - 9h standard
});

test('overnight shift via explicit end (22:00 → 06:00 = 8h, isNight)', () => {
  const s = cfg.resolveEmployeeShift('Night Shift', '22:00', '06:00');
  assert.strictEqual(s.durationHours, 8);
  assert.strictEqual(s.isNight, true);
});

test('missing shift falls back to General 09:00 (legacy safety, no crash)', () => {
  assert.strictEqual(S(undefined, undefined).start, '09:00');
});

test('normalizeTime parses 24h and 12h AM/PM', () => {
  assert.strictEqual(cfg.normalizeTime('07:00'), '07:00');
  assert.strictEqual(cfg.normalizeTime('07:00 AM'), '07:00');
  assert.strictEqual(cfg.normalizeTime('01:30 PM'), '13:30');
  assert.strictEqual(cfg.normalizeTime('12:00 PM'), '12:00');
  assert.strictEqual(cfg.normalizeTime('12:00 AM'), '00:00');
});

// ── Late = firstPunch - (shiftStart + 5 grace) — the required examples ──────
test('late uses the employee shift start + 5-min grace', () => {
  assert.strictEqual(computeSession(['07:04', '17:00'], S('Morning', '07:00')).lateArrivalMin, 0);  // within grace
  assert.strictEqual(computeSession(['08:06', '18:00'], S('Day', '08:00')).lateArrivalMin, 1);
  assert.strictEqual(computeSession(['09:07', '18:00'], S('General', '09:00')).lateArrivalMin, 2);
  assert.strictEqual(computeSession(['11:34', '21:30'], S('Evening', '11:30')).lateArrivalMin, 0);  // within grace
  assert.strictEqual(computeSession(['13:36', '23:30'], S('Noon', '13:30')).lateArrivalMin, 1);
});

test('exactly on time and exactly at grace boundary → 0 late', () => {
  for (const s of SHIFTS) {
    const onTime = computeSession([s.start, s.end], S(s.name, s.start));
    assert.strictEqual(onTime.lateArrivalMin, 0, `${s.name} on time`);
    const grace = computeSession([addMin(s.start, 5), s.end], S(s.name, s.start));
    assert.strictEqual(grace.lateArrivalMin, 0, `${s.name} +5 grace`);
    const late = computeSession([addMin(s.start, 6), s.end], S(s.name, s.start));
    assert.strictEqual(late.lateArrivalMin, 1, `${s.name} +6 first late minute`);
  }
});

// ── Early exit = shiftEnd - lastPunch (measured against the employee's end) ──
test('early exit measured against the employee shift end', () => {
  assert.strictEqual(computeSession(['09:00', '17:00'], S('General', '09:00')).earlyDepartureMin, 60);
  assert.strictEqual(computeSession(['07:00', '17:00'], S('Morning', '07:00')).earlyDepartureMin, 0);
  assert.strictEqual(computeSession(['13:30', '23:00'], S('Noon', '13:30')).earlyDepartureMin, 30);
});

// ── Overtime = effective hours beyond the 9h company standard (not shift span) ─
test('overtime accrues on effective hours beyond 9h, regardless of shift length', () => {
  assert.strictEqual(computeSession(['09:00', '20:00'], S('General', '09:00')).overtimeHours, 2);  // 11h - 9h
  assert.strictEqual(computeSession(['07:00', '19:00'], S('Morning', '07:00')).overtimeHours, 3);  // 12h - 9h
  assert.strictEqual(computeSession(['11:30', '21:30'], S('Evening', '11:30')).overtimeHours, 1);  // 10h - 9h
  assert.strictEqual(computeSession(['09:00', '18:00'], S('General', '09:00')).overtimeHours, 0);  // 9h - 9h = none
});

// ── Export parity: the export computes each row with the employee's shift, so a
//    late punch under one shift is on-time under another. ─────────────────────
test('same punch, different shift → different late (drives Excel export)', () => {
  const punch = '09:04';
  assert.strictEqual(computeSession([punch, '18:00'], S('General', '09:00')).lateArrivalMin, 0);   // grace
  assert.strictEqual(computeSession([punch, '18:00'], S('Morning', '07:00')).lateArrivalMin > 0, true);
});

function addMin(hhmm, n) {
  const [h, m] = hhmm.split(':').map(Number);
  const t = h * 60 + m + n;
  return `${String(Math.floor(t / 60) % 24).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
}
