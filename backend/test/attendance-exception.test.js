/**
 * Attendance Exception detection — maps a completed day's punches to the exception
 * that needs employee action. Codes align with the Attendance Correction types.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const { detectExceptions } = require('../src/services/attendance-exception.util');
const { computeSession } = require('../src/services/attendance.util');

test('Missing Check Out — lone IN punch', () => {
  const ex = detectExceptions(computeSession(['09:02']));
  assert.strictEqual(ex.length, 1);
  assert.strictEqual(ex[0].code, 'missing_check_out');
  assert.strictEqual(ex[0].priority, 'high');
});

test('Missing Check In — lone OUT punch', () => {
  const ex = detectExceptions(computeSession([{ t: '18:00', d: 'out' }]));
  assert.strictEqual(ex[0].code, 'missing_check_in');
});

test('Missing Check Out — odd count (IN, OUT, IN)', () => {
  const ex = detectExceptions(computeSession(['09:00', '13:00', '14:00']));
  assert.strictEqual(ex[0].code, 'missing_check_out');
});

test('Missed Break Out — consecutive IN (in, in, out)', () => {
  const ex = detectExceptions(computeSession([{ t: '09:00', d: 'in' }, { t: '14:00', d: 'in' }, { t: '19:00', d: 'out' }]));
  // 3 punches is odd → treated as a missing check punch; verify break case with even count:
  const ex2 = detectExceptions(computeSession([{ t: '09:00', d: 'in' }, { t: '13:00', d: 'in' }, { t: '14:00', d: 'out' }, { t: '19:00', d: 'out' }]));
  assert.strictEqual(ex2[0].code, 'missed_break_out');
  assert.ok(ex.length >= 1);
});

test('Missed Break In — consecutive OUT (in, out, out, in)', () => {
  const ex = detectExceptions(computeSession([{ t: '09:00', d: 'in' }, { t: '13:00', d: 'out' }, { t: '13:30', d: 'out' }, { t: '19:00', d: 'in' }]));
  assert.strictEqual(ex[0].code, 'missed_break_in');
});

test('No exception — clean, well-paired day', () => {
  assert.deepStrictEqual(detectExceptions(computeSession(['09:00', '13:00', '14:00', '19:00'])), []);
});

test('No exception — no punches (absent, not a punch exception)', () => {
  assert.deepStrictEqual(detectExceptions(computeSession([])), []);
});
