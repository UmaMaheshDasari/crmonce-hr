const { test } = require('node:test');
const assert = require('node:assert');
const { computeSession, computeFromPunches, punchesFromRecord, normalizePunches } = require('../src/services/attendance.util');

// Default shift = GENERAL 09:00–18:00 (9h) → halfDayThreshold 4.5h.
const S = (start, end, dur, night = false) => ({ code: 'X', name: 'X', start, end, durationHours: dur, isNight: night });

test('single punch → currently IN, incomplete', () => {
  const c = computeSession(['09:00']);
  assert.strictEqual(c.state, 'in');
  assert.strictEqual(c.status, 'incomplete');
  assert.strictEqual(c.count, 1);
});

test('IN / OUT → present, span & effective, no overtime', () => {
  const c = computeSession(['09:00', '18:00']);
  assert.strictEqual(c.totalSpanHours, 9);
  assert.strictEqual(c.effectiveHours, 9);
  assert.strictEqual(c.overtimeHours, 0);      // 9 - 9
  assert.strictEqual(c.status, 'present');
});

test('lunch break → break subtracted from effective', () => {
  const c = computeSession(['09:00', '13:00', '14:00', '18:00']);
  assert.strictEqual(c.totalSpanHours, 9);
  assert.strictEqual(c.breakHours, 1);
  assert.strictEqual(c.effectiveHours, 8);
  assert.strictEqual(c.status, 'present');
});

test('tea break (15 min) counted', () => {
  const c = computeSession(['09:00', '11:00', '11:15', '18:00']);
  assert.strictEqual(c.breakHours, 0.25);
  assert.strictEqual(c.effectiveHours, 8.75);
});

test('multiple breaks summed', () => {
  const c = computeSession(['09:00', '11:00', '11:15', '13:00', '14:00', '18:00']);
  assert.strictEqual(c.breakHours, 1.25);       // 0.25 + 1.00
  assert.strictEqual(c.effectiveHours, 7.75);
});

test('forgot checkout (odd punches) → in + incomplete, re-openable', () => {
  const c = computeSession(['09:00', '13:00', '14:00']);
  assert.strictEqual(c.state, 'in');
  assert.strictEqual(c.status, 'incomplete');
});

test('half day: effective < shift/2 (4.5h)', () => {
  const c = computeSession(['09:00', '13:00']);          // 4h < 4.5
  assert.strictEqual(c.effectiveHours, 4);
  assert.strictEqual(c.halfDayThreshold, 4.5);
  assert.strictEqual(c.status, 'half_day');
});

test('present exactly at shift/2 threshold', () => {
  const c = computeSession(['09:00', '13:30']);          // 4.5h >= 4.5
  assert.strictEqual(c.status, 'present');
});

test('absent: no punches', () => {
  const c = computeSession([]);
  assert.strictEqual(c.status, 'absent');
  assert.strictEqual(c.state, 'none');
});

test('overtime = effective - shift duration', () => {
  const c = computeSession(['09:00', '20:00']);          // 11h effective, 9h shift
  assert.strictEqual(c.effectiveHours, 11);
  assert.strictEqual(c.overtimeHours, 2);
});

test('night shift crossing midnight (22:00–06:00, 8h)', () => {
  const c = computeSession(['22:00', '06:00'], S('22:00', '06:00', 8, true));
  assert.strictEqual(c.totalSpanHours, 8);
  assert.strictEqual(c.effectiveHours, 8);
  assert.strictEqual(c.status, 'present');
  assert.strictEqual(c.overtimeHours, 0);
});

test('device direction honored ({t,d} objects)', () => {
  const c = computeSession([{ t: '09:00', d: 'in' }, { t: '12:00', d: 'out' }, { t: '13:00', d: 'in' }, { t: '18:00', d: 'out' }]);
  assert.strictEqual(c.breakHours, 1);
  assert.strictEqual(c.state, 'out');
});

test('late arrival & early departure vs shift', () => {
  const late = computeSession(['09:30', '18:00']);       // shift start 09:00
  assert.strictEqual(late.lateArrivalMin, 30);
  const early = computeSession(['09:00', '17:00']);      // shift end 18:00
  assert.strictEqual(early.earlyDepartureMin, 60);
});

test('shift-based half-day threshold differs by shift', () => {
  const c = computeSession(['09:00', '13:00'], S('09:00', '19:00', 10)); // threshold 5h
  assert.strictEqual(c.halfDayThreshold, 5);
  assert.strictEqual(c.effectiveHours, 4);
  assert.strictEqual(c.status, 'half_day');
});

test('backward compat: legacy string array & intime/outtime record', () => {
  const c = computeFromPunches(['09:00', '18:00']);
  assert.strictEqual(c.effectiveHours, 9);
  assert.strictEqual(c.status, 'present');
  assert.deepStrictEqual(punchesFromRecord({ hr_intime: '09:00', hr_outtime: '18:00', hr_allpunches: null }), ['09:00', '18:00']);
});

test('after OUT a new punch re-opens the session', () => {
  let c = computeSession(['09:00', '12:00']);
  assert.strictEqual(c.state, 'out');
  c = computeSession([...c.punches, '13:00']);
  assert.strictEqual(c.state, 'in');
});

test('normalizePunches infers direction by pairing', () => {
  const p = normalizePunches(['09:00', '12:00', '13:00']);
  assert.deepStrictEqual(p.map(x => x.d), ['in', 'out', 'in']);
});

// ── Company policy (attendance emits FACTS only; compensation is Payroll's job) ──
test('policy: late but completes required hours → Present + compensated', () => {
  const c = computeSession(['07:30', '17:30'], S('07:00', '17:00', 10)); // 10h shift
  assert.strictEqual(c.effectiveHours, 10);
  assert.strictEqual(c.lateArrivalMin, 30);
  assert.strictEqual(c.status, 'present');               // status by effective hours only
  assert.strictEqual(c.metRequiredHours, true);
  assert.strictEqual(c.compensationStatus, 'compensated');
});

test('policy: late AND short of required → present-by-hours, shortfall', () => {
  const c = computeSession(['10:00', '17:00']);          // GENERAL 9h; effective 7
  assert.strictEqual(c.lateArrivalMin, 60);
  assert.strictEqual(c.effectiveHours, 7);
  assert.strictEqual(c.status, 'present');               // late does NOT reduce status
  assert.strictEqual(c.metRequiredHours, false);
  assert.strictEqual(c.compensationStatus, 'shortfall');
});

test('policy: on time → compensationStatus on_time', () => {
  assert.strictEqual(computeSession(['09:00', '18:00']).compensationStatus, 'on_time');
});

test('policy: approved leave offsets late calculation', () => {
  const c = computeSession(['11:05', '18:00'], undefined, { leaveUntil: '11:00' });
  assert.strictEqual(c.lateArrivalMin, 5);               // measured from 11:00, not 09:00
});

// ── Rule: any punch → never Absent; attendance issue ───────────────────────
test('single IN → Incomplete, never Absent, Missing Check Out', () => {
  const c = computeSession(['09:00']);
  assert.strictEqual(c.status, 'incomplete');
  assert.notStrictEqual(c.status, 'absent');
  assert.strictEqual(c.attendanceIssue, 'Missing Check Out');
});

test('IN + OUT → Normal issue, never Absent', () => {
  const c = computeSession(['09:00', '18:00']);
  assert.strictEqual(c.attendanceIssue, 'Normal');
  assert.notStrictEqual(c.status, 'absent');
});

test('device OUT-first single punch → Missing Check In (incomplete)', () => {
  const c = computeSession([{ t: '18:00', d: 'out' }]);
  assert.strictEqual(c.status, 'incomplete');
  assert.strictEqual(c.attendanceIssue, 'Missing Check In');
});

test('punch in+out same minute (0 effective) is NOT Absent', () => {
  const c = computeSession(['09:00', '09:00']);
  assert.notStrictEqual(c.status, 'absent');
  assert.strictEqual(c.attendanceIssue, 'Normal');
});

test('no punches → Absent, empty issue', () => {
  const c = computeSession([]);
  assert.strictEqual(c.status, 'absent');
  assert.strictEqual(c.attendanceIssue, '');
});
