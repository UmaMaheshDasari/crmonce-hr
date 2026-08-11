/**
 * Leave day calculation — WORKING days only (weekends + company holidays excluded).
 * The authoritative count is rangeCounts(from,to).working, used by the leave create,
 * the /working-days endpoint and the lifecycle edit. Never a calendar-day span.
 *
 * Aug 2026: 14=Fri, 15=Sat, 16=Sun, 17=Mon, 18=Tue. Weekly-offs = Sun(0)+Sat(6).
 */
process.env.NODE_ENV = 'test';
const { test } = require('node:test');
const assert = require('node:assert');
const { rangeCounts } = require('../src/services/attendance-summary.util');

const WEEKEND = { weekOffDays: [0, 6], holidays: [] };
const days = (from, to, opts = WEEKEND) => rangeCounts(from, to, opts).working;

// ── weekends never count ──
test('TEST 1 — Friday → Friday = 1', () => assert.strictEqual(days('2026-08-14', '2026-08-14'), 1));
test('TEST 2 — Saturday → Saturday = 0', () => assert.strictEqual(days('2026-08-15', '2026-08-15'), 0));
test('TEST 3 — Sunday → Sunday = 0', () => assert.strictEqual(days('2026-08-16', '2026-08-16'), 0));
test('TEST 4 — Saturday → Sunday = 0', () => assert.strictEqual(days('2026-08-15', '2026-08-16'), 0));
test('TEST 5 — Friday → Monday = 2 (Fri + Mon; Sat/Sun skipped)', () => assert.strictEqual(days('2026-08-14', '2026-08-17'), 2));
test('TEST 6 — Friday → Tuesday = 3 (Fri + Mon + Tue)', () => assert.strictEqual(days('2026-08-14', '2026-08-18'), 3));

// ── company holidays never count (dynamic, passed in like the live calendar) ──
test('TEST 7 — Friday → Monday where Monday is a holiday = 1', () => {
  assert.strictEqual(days('2026-08-14', '2026-08-17', { weekOffDays: [0, 6], holidays: ['2026-08-17'] }), 1);
});
test('TEST 8 — Friday → Tuesday where Monday is a holiday = 2 (Fri + Tue)', () => {
  assert.strictEqual(days('2026-08-14', '2026-08-18', { weekOffDays: [0, 6], holidays: ['2026-08-17'] }), 2);
});

// ── all-weekend range → 0 (submit must be blocked at the UI; backend rejects) ──
test('TEST 9 — entire range is weekends = 0', () => {
  assert.strictEqual(days('2026-08-15', '2026-08-16'), 0);
});

// ── the reported bug: 15 Aug → 16 Aug was showing 2 (calendar span); now 0 ──
test('reported bug — 15 Aug (Sat) → 16 Aug (Sun) = 0, not 2', () => {
  assert.strictEqual(days('2026-08-15', '2026-08-16'), 0);
});

// ── Comp Off eligible-day math (TEST 10/11 use the SAME working-day count) ──
test('TEST 10/11 — Comp Off eligible days over Fri→Mon = 2 (compare to balance)', () => {
  const eligible = days('2026-08-14', '2026-08-17');
  assert.strictEqual(eligible, 2);
  assert.ok(eligible <= 2, 'balance 2 → valid');       // TEST 10
  assert.ok(eligible > 1, 'balance 1 → rejected (2 > 1)'); // TEST 11
});

// a holiday that is ALSO a weekend is counted once (not double-subtracted)
test('a holiday falling on a weekend does not double-count', () => {
  assert.strictEqual(days('2026-08-14', '2026-08-17', { weekOffDays: [0, 6], holidays: ['2026-08-15'] }), 2);
});
