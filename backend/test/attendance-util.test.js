const { test } = require('node:test');
const assert = require('node:assert');
const { computeFromPunches, punchesFromRecord } = require('../src/services/attendance.util');

test('single IN → currently in, incomplete', () => {
  const c = computeFromPunches(['09:00']);
  assert.strictEqual(c.state, 'in');
  assert.strictEqual(c.status, 'incomplete');
  assert.strictEqual(c.count, 1);
});

test('IN/OUT → out, present, worked span', () => {
  const c = computeFromPunches(['09:00', '18:00']);
  assert.strictEqual(c.state, 'out');
  assert.strictEqual(c.workedHours, 9);
  assert.strictEqual(c.breakDuration, 0);
  assert.strictEqual(c.effectiveHours, 9);
  assert.strictEqual(c.status, 'present');
});

test('multiple pairs: break = sum of OUT→IN gaps', () => {
  // 09:00 IN, 12:00 OUT, 13:00 IN, 18:00 OUT → span 9h, break 1h, effective 8h
  const c = computeFromPunches(['09:00', '12:00', '13:00', '18:00']);
  assert.strictEqual(c.workedHours, 9);
  assert.strictEqual(c.breakDuration, 1);
  assert.strictEqual(c.effectiveHours, 8);
  assert.strictEqual(c.state, 'out');
  assert.strictEqual(c.status, 'present');
});

test('odd count (forgot final checkout) → in + incomplete', () => {
  const c = computeFromPunches(['09:00', '12:00', '13:00']);
  assert.strictEqual(c.state, 'in');
  assert.strictEqual(c.status, 'incomplete');
});

test('after OUT, a new punch re-opens the session (check in again)', () => {
  let c = computeFromPunches(['09:00', '12:00']);
  assert.strictEqual(c.state, 'out');
  c = computeFromPunches([...c.punches, '13:00']);
  assert.strictEqual(c.state, 'in'); // never locked
});

test('legacy record (intime/outtime, no allpunches) reconstructs punches', () => {
  const p = punchesFromRecord({ hr_intime: '09:00', hr_outtime: '18:00', hr_allpunches: null });
  assert.deepStrictEqual(p, ['09:00', '18:00']);
});

test('no punches → none / absent', () => {
  const c = computeFromPunches([]);
  assert.strictEqual(c.state, 'none');
  assert.strictEqual(c.status, 'absent');
});
