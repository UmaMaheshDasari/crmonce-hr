/**
 * Missing Punch Workflow — detection + correction + automatic recalculation.
 * The engine inserts the approved punch and computeSession recomputes Worked /
 * Break / Effective / Status / Late / Overtime from the corrected punches.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const { detectMissingPunches, insertPunchTime, PUNCH_TYPES } = require('../src/services/missing-punch.util');
const { computeSession } = require('../src/services/attendance.util');

// ── Attendance Correction types (redesigned form) ────────────────────────────
test('All redesigned Correction Types are recognised', () => {
  for (const t of ['missing_check_in', 'missing_check_out', 'missed_break_out', 'missed_break_in', 'device_failure', 'web_checkin_issue', 'other']) {
    assert.ok(PUNCH_TYPES[t], `correction type "${t}" is valid`);
  }
});

// ── Detection ────────────────────────────────────────────────────────────────
test('Missing Lunch OUT — 09:00 IN, 14:15 IN, 19:00 OUT → odd count flagged', () => {
  const r = detectMissingPunches(['09:00', '14:15', '19:00']);
  assert.strictEqual(r.hasIssue, true);
  assert.ok(r.issues.some(i => i.code === 'missing_check_out' || i.code === 'lunch_out'));
});

test('Missing Check Out — single IN punch is flagged', () => {
  const r = detectMissingPunches(['09:00']);
  assert.strictEqual(r.hasIssue, true);
  assert.strictEqual(r.issues[0].code, 'missing_check_out');
});

test('Missing Check In — a lone OUT punch is flagged', () => {
  const r = detectMissingPunches([{ t: '18:00', d: 'out' }]);
  assert.strictEqual(r.hasIssue, true);
  assert.strictEqual(r.issues[0].code, 'missing_check_in');
});

test('Consecutive OUT (missing Lunch IN) is flagged', () => {
  const r = detectMissingPunches([{ t: '09:00', d: 'in' }, { t: '13:30', d: 'out' }, { t: '19:00', d: 'out' }]);
  assert.strictEqual(r.hasIssue, true);
  assert.ok(r.issues.some(i => i.code === 'lunch_in'));
});

test('A complete, well-paired day has NO issue', () => {
  assert.strictEqual(detectMissingPunches(['09:00', '13:30', '14:15', '19:00']).hasIssue, false);
});

// ── Correction insertion (chronological, positional pairing restored) ─────────
test('insertPunchTime drops the punch into the right chronological slot', () => {
  assert.deepStrictEqual(insertPunchTime(['09:00', '14:15', '19:00'], '13:30'), ['09:00', '13:30', '14:15', '19:00']);
  assert.deepStrictEqual(insertPunchTime(['09:00'], '18:00'), ['09:00', '18:00']);
  assert.deepStrictEqual(insertPunchTime(['09:00', '18:00'], '19:30'), ['09:00', '18:00', '19:30']);
});

// ── Automatic recalculation after approval ───────────────────────────────────
test('Missing Lunch OUT approved → Break becomes 45m and Effective recalculates', () => {
  // Before: 09:00 IN, 14:15 IN, 19:00 OUT (forgot lunch-out) → 3 punches, wrong.
  const before = computeSession(['09:00', '14:15', '19:00']);
  assert.strictEqual(before.status, 'incomplete');

  // Admin approves inserting 13:30 (the missed Lunch OUT).
  const corrected = insertPunchTime(['09:00', '14:15', '19:00'], '13:30');
  assert.deepStrictEqual(corrected, ['09:00', '13:30', '14:15', '19:00']);

  const after = computeSession(corrected);
  assert.strictEqual(after.breakHours, 0.75, 'break = 14:15 − 13:30 = 45m');
  assert.strictEqual(after.status, 'present');
  // Span 09:00→19:00 = 10h, minus 45m break = 9.25h effective.
  assert.strictEqual(after.effectiveHours, 9.25);
  assert.ok(after.overtimeHours > 0, 'effective beyond the 9h standard → overtime');
});

test('Missing Check Out approved → Incomplete becomes Present with real hours', () => {
  const after = computeSession(insertPunchTime(['09:00'], '18:00'));
  assert.strictEqual(after.status, 'present');
  assert.strictEqual(after.breakHours, 0);
  assert.strictEqual(after.effectiveHours, 9);
});

test('Missing Lunch IN approved → pairing restored, break counted once', () => {
  // 09:00 IN, 13:30 OUT, 19:00 (forgot to punch back IN) → insert 14:15.
  const after = computeSession(insertPunchTime(['09:00', '13:30', '19:00'], '14:15'));
  assert.deepStrictEqual(after.punches.map(p => p.t), ['09:00', '13:30', '14:15', '19:00']);
  assert.strictEqual(after.breakHours, 0.75);
  assert.strictEqual(after.status, 'present');
});
