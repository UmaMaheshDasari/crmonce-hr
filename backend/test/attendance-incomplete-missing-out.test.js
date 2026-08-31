/**
 * Missing OUT punch (In present, Out missing, 0 effective hours) must classify as INCOMPLETE,
 * never Half Day — for all employees and all PAST dates. A Half Day requires a completed
 * in→out session with real worked hours. A day with real hours (even with a trailing odd
 * punch) is NOT reclassified, so valid Present/Half days are protected.
 *
 * Pure classifier tests (computeSession) — no network. Uses an explicit past date so the
 * "today = in_progress" live rule does not apply.
 */
process.env.NODE_ENV = 'test';

const { test } = require('node:test');
const assert = require('node:assert');
const { computeSession, classifyStatus } = require('../src/services/attendance.util');

const PAST = '2026-08-27';   // a finalized past date (the Uma Alapaka case)
const GEN = 'GEN';

test('Case 1 — In present, Out missing, 0 effective → INCOMPLETE (not Half Day)', () => {
  const c = computeSession(['08:56'], GEN, { date: PAST });   // lone IN, no OUT
  assert.strictEqual(c.effectiveHours, 0);
  assert.strictEqual(c.status, 'incomplete');
  assert.notStrictEqual(c.status, 'half_day');
  assert.strictEqual(c.attendanceIssue, 'Missing Check Out');
});

test('Case 2 — In + valid Out with half-day duration → HALF DAY', () => {
  const c = computeSession(['09:00', '13:00'], GEN, { date: PAST });   // 4h closed session
  assert.strictEqual(c.effectiveHours, 4);
  assert.strictEqual(c.status, 'half_day');
});

test('Case 3 — In + valid Out with full-day duration → PRESENT', () => {
  const c = computeSession(['08:56', '21:57'], GEN, { date: PAST });   // long closed session
  assert.ok(c.effectiveHours >= 7);
  assert.strictEqual(c.status, 'present');
});

test('Case 4 — Missing In (lone Out) → INCOMPLETE', () => {
  const c = computeSession([{ t: '18:00', d: 'out' }], GEN, { date: PAST });
  assert.strictEqual(c.status, 'incomplete');
  assert.strictEqual(c.attendanceIssue, 'Missing Check In');
});

test('Case 5 — Both In and Out missing (no punches) → ABSENT', () => {
  const c = computeSession([], GEN, { date: PAST });
  assert.strictEqual(c.status, 'absent');
});

test('Case 6 — a real half-day (closed in→out, 5h) still HALF DAY (regression protected)', () => {
  const c = computeSession(['09:00', '14:00'], GEN, { date: PAST });   // 5h
  assert.strictEqual(c.effectiveHours, 5);
  assert.strictEqual(c.status, 'half_day');
});

test('Missing final punch WITH a completed first pair (in→out→in = 8h) → INCOMPLETE (confirmed hours kept)', () => {
  const c = computeSession(['09:00', '17:00', '18:00'], GEN, { date: PAST });   // 8h from first pair, trailing IN (missing final OUT)
  assert.strictEqual(c.effectiveHours, 8);       // confirmed completed-pair hours
  assert.strictEqual(c.status, 'incomplete');    // odd/missing final punch → Incomplete, never Present/Half
});

// Direct classifier unit checks (the exact rule).
test('classifyStatus — ANY odd/missing punch → incomplete; only EVEN completed sessions are Present/Half', () => {
  assert.strictEqual(classifyStatus(0, 1, { oddPunch: true }), 'incomplete');   // missing punch, 0h
  assert.strictEqual(classifyStatus(4, 3, { oddPunch: true }), 'incomplete');   // missing final punch, 4h confirmed
  assert.strictEqual(classifyStatus(8, 3, { oddPunch: true }), 'incomplete');   // missing final punch, 8h confirmed
  assert.strictEqual(classifyStatus(0, 0), 'absent');                            // no punch
  assert.strictEqual(classifyStatus(4, 2, { oddPunch: false }), 'half_day');     // valid (even) half day
  assert.strictEqual(classifyStatus(8, 2, { oddPunch: false }), 'present');      // valid (even) full day
  assert.strictEqual(classifyStatus(0, 1, { openSession: true }), 'in_progress'); // today's live open session
});
