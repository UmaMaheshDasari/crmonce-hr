/**
 * Phase 1 — Daily attendance rules (fixed worked-hour thresholds).
 *
 *   effective >= 7h            → Full Day   (present), expected 9h
 *   effective 5h..<7h          → Half Day   (half_day), expected 5h
 *   effective < 5h (punched)   → below-half handling → Half Day, expected 5h
 *   no punch                   → Absent
 * No 'incomplete' status is ever produced (missing punch → attendanceIssue only).
 * Daily balance = effective worked − expected. Shift still drives late/early/overtime.
 */
process.env.NODE_ENV = 'test';

const { test } = require('node:test');
const assert = require('node:assert');
const { computeSession, classifyStatus, expectedHoursFor } = require('../src/services/attendance.util');

// GENERAL shift 09:00–18:00. Build an even punch pair that yields a target number of
// EFFECTIVE hours (no breaks → effective === span).
const pair = (startHHMM, hours) => {
  const [h, m] = startHHMM.split(':').map(Number);
  const end = h * 60 + m + Math.round(hours * 60);
  const eh = Math.floor(end / 60) % 24, em = end % 60;
  return [startHHMM, `${String(eh).padStart(2, '0')}:${String(em).padStart(2, '0')}`];
};

// ── Pure classifier ───────────────────────────────────────────────────
test('classifyStatus: fixed 7h/5h rule, no incomplete', () => {
  assert.equal(classifyStatus(10, 2), 'present');
  assert.equal(classifyStatus(7, 2), 'present');    // boundary: 7 → Full Day
  assert.equal(classifyStatus(6.99, 2), 'half_day');
  assert.equal(classifyStatus(6, 2), 'half_day');
  assert.equal(classifyStatus(5, 2), 'half_day');
  assert.equal(classifyStatus(4, 2), 'half_day');   // < 5 → below-half handling → half_day
  assert.equal(classifyStatus(0, 1), 'half_day');   // single/odd punch, 0h → half_day (never 'incomplete')
  assert.equal(classifyStatus(8, 0), 'absent');     // no punch → absent
});

test('expectedHoursFor: 9 full / 5 half / 0 absent', () => {
  assert.equal(expectedHoursFor('present'), 9);
  assert.equal(expectedHoursFor('half_day'), 5);
  assert.equal(expectedHoursFor('absent'), 0);
});

// ── computeSession end-to-end (the requirement's worked examples) ──────
const cases = [
  { worked: 10, status: 'present', expected: 9, balance: 1 },   // 10h → Full Day → +1
  { worked: 7, status: 'present', expected: 9, balance: -2 },   //  7h → Full Day → -2
  { worked: 6, status: 'half_day', expected: 5, balance: 1 },   //  6h → Half Day → +1
  { worked: 5, status: 'half_day', expected: 5, balance: 0 },   //  5h → Half Day →  0
  { worked: 4, status: 'half_day', expected: 5, balance: -1 },  //  4h → existing handling → baseline 5
];
for (const c of cases) {
  test(`computeSession: ${c.worked}h worked → ${c.status} (expected ${c.expected}, balance ${c.balance})`, () => {
    const s = computeSession(pair('09:00', c.worked), 'GENERAL');
    assert.equal(s.effectiveHours, c.worked);
    assert.equal(s.status, c.status);
    assert.equal(s.expectedHours, c.expected);
    assert.equal(s.dailyBalanceHours, c.balance);
    assert.notEqual(s.status, 'incomplete');
  });
}

test('computeSession: no punch → absent, expected 0', () => {
  const s = computeSession([], 'GENERAL');
  assert.equal(s.status, 'absent');
  assert.equal(s.expectedHours, 0);
  assert.equal(s.dailyBalanceHours, 0);
});

test('computeSession: single (odd) punch → half_day + Missing Check Out flag, never incomplete', () => {
  const s = computeSession(['09:00'], 'GENERAL');
  assert.equal(s.status, 'half_day');
  assert.notEqual(s.status, 'incomplete');
  assert.equal(s.attendanceIssue, 'Missing Check Out');   // missing-punch info preserved
});

test('computeSession: fixed thresholds do NOT depend on shift duration', () => {
  // 6h effective is Half Day on a short shift AND a long shift (was shift/2 before).
  const short = computeSession(pair('09:00', 6), 'GENERAL');            // 9h shift
  const long = computeSession(pair('09:00', 6), { name: 'X', start: '09:00', end: '21:00', durationHours: 12, isNight: false });
  assert.equal(short.status, 'half_day');
  assert.equal(long.status, 'half_day');
  assert.equal(short.fullDayThreshold, 7);
  assert.equal(short.halfDayThreshold, 5);
});
