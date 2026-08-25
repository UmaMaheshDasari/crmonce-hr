/**
 * IN PROGRESS is a LIVE state for TODAY ONLY.
 *   - TODAY + open IN (missing OUT)      → 'in_progress'
 *   - TODAY + completed OUT              → finalized (present / half by hours)
 *   - PREVIOUS date + open/missing OUT   → FINALIZED by actual hours, NEVER 'in_progress'
 * A missing OUT on a past day is surfaced via attendanceIssue ('Missing Check Out'),
 * not by keeping the day 'in_progress'.
 */
process.env.NODE_ENV = 'test';
process.env.AZURE_CLIENT_ID = process.env.AZURE_CLIENT_ID || 'x';
process.env.AZURE_CLIENT_SECRET = process.env.AZURE_CLIENT_SECRET || 'x';
process.env.AZURE_TENANT_ID = process.env.AZURE_TENANT_ID || 'x';

const { test } = require('node:test');
const assert = require('node:assert');
const { computeSession } = require('../src/services/attendance.util');
const time = require('../src/services/time.util');

const TODAY = '2026-08-25';
const YDAY = '2026-08-24';
const GEN = { code: 'G', name: 'General', start: '09:00', end: '18:00', durationHours: 9, isNight: false, grace: 5 };

/** Run `fn` with time.istDateStr() pinned to TODAY (restored after). */
function withToday(fn) {
  const orig = time.istDateStr;
  time.istDateStr = () => TODAY;
  try { return fn(); } finally { time.istDateStr = orig; }
}

test('Test 1 — TODAY open IN → in_progress', () => {
  withToday(() => {
    const c = computeSession(['09:00'], GEN, { date: TODAY });
    assert.equal(c.status, 'in_progress');
    assert.deepStrictEqual(c.openSession, { inTime: '09:00' });
  });
});

test('Test 2 — TODAY completed 9h → present (not in_progress)', () => {
  withToday(() => {
    const c = computeSession(['09:00', '18:00'], GEN, { date: TODAY });
    assert.equal(c.status, 'present');
  });
});

test('TODAY completed sessions + open 2nd session → in_progress; completed hours counted', () => {
  withToday(() => {
    const c = computeSession(['09:00', '12:00', '13:00'], GEN, { date: TODAY });   // 3h done, then open
    assert.equal(c.status, 'in_progress');
    assert.equal(c.effectiveHours, 3);
    assert.deepStrictEqual(c.openSession, { inTime: '13:00' });
  });
});

test('Test 3 — YESTERDAY 6h30m closed → half_day (NOT in_progress)', () => {
  withToday(() => {
    const c = computeSession(['09:00', '15:30'], GEN, { date: YDAY });
    assert.equal(c.status, 'half_day');
  });
});

test('Test 4 — YESTERDAY 9h → present (NOT in_progress)', () => {
  withToday(() => {
    assert.equal(computeSession(['09:00', '18:00'], GEN, { date: YDAY }).status, 'present');
  });
});

test('Test 5 — YESTERDAY 3h → half_day/below (existing handling, NOT in_progress)', () => {
  withToday(() => {
    const c = computeSession(['09:00', '12:00'], GEN, { date: YDAY });
    assert.equal(c.status, 'half_day');   // <7h → not Full; below-half handled by monthly LOP
    assert.notEqual(c.status, 'in_progress');
  });
});

test('Test 6 — YESTERDAY multi-session 8h → present (NOT in_progress)', () => {
  withToday(() => {
    assert.equal(computeSession(['09:00', '12:00', '13:00', '18:00'], GEN, { date: YDAY }).status, 'present');
  });
});

test('Test 7 — YESTERDAY missing OUT (lone IN) → FINALIZED, NEVER in_progress', () => {
  withToday(() => {
    const c = computeSession(['09:00'], GEN, { date: YDAY });
    assert.notEqual(c.status, 'in_progress');       // the whole point of this change
    assert.equal(c.status, 'half_day');             // 0 effective → below full; finalized
    assert.equal(c.attendanceIssue, 'Missing Check Out');   // missing punch surfaced separately
  });
});

test('YESTERDAY open 2nd session (IN,OUT,IN) → finalized by completed hours, NOT in_progress', () => {
  withToday(() => {
    const c = computeSession(['09:00', '14:00', '15:00'], GEN, { date: YDAY });   // session1 = 5h; open 3rd
    assert.notEqual(c.status, 'in_progress');
    assert.equal(c.effectiveHours, 5);
    assert.equal(c.status, 'half_day');             // 5h < 7h → Half Day
  });
});

test('No date supplied → treated as live/today → open IN is in_progress', () => {
  const c = computeSession(['09:00'], GEN);   // web check-in path passes no date
  assert.equal(c.status, 'in_progress');
});
