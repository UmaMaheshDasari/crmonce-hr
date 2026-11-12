/**
 * Leave duration helper — the shared source of truth used by the leave summary,
 * the approval card and leave history. Covers the regression cases for the
 * "1 day vs 0.5 day (half)" mismatch.
 * Run: `node --test src/utils/leave-duration.test.js`
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { leaveDuration, leaveDurationDays, isHalfDayLeave } from './leave-duration.js';

test('single-day full leave → 1 day', () => {
  const l = { hr_days: 1, hr_halfday: 'false' };
  assert.strictEqual(leaveDurationDays(l), 1);
  assert.strictEqual(leaveDuration(l).label, '1 day');
  assert.strictEqual(leaveDuration(l).value, 1);
  assert.strictEqual(isHalfDayLeave(l), false);
});

test('single-day half leave (hr_days stays Int 1) → 0.5 day (half)', () => {
  const l = { hr_days: 1, hr_halfday: 'true' };
  assert.strictEqual(leaveDurationDays(l), 0.5);
  assert.strictEqual(leaveDuration(l).value, 0.5);
  assert.strictEqual(leaveDuration(l).unit, 'day (half)');
  assert.strictEqual(leaveDuration(l).label, '0.5 day (half)');
  assert.strictEqual(isHalfDayLeave(l), true);
});

test('two-day full leave → 2 days', () => {
  const l = { hr_days: 2, hr_halfday: 'false' };
  assert.strictEqual(leaveDuration(l).label, '2 days');
  assert.strictEqual(leaveDuration(l).value, 2);
});

test('half-day flag wins even if hr_days reads 1 over a range field', () => {
  // hr_halfday is only set for a single working day; the flag is authoritative.
  const l = { hr_days: 1, hr_halfday: 'true' };
  assert.strictEqual(leaveDuration(l).label, '0.5 day (half)');
});

test('missing hr_halfday is treated as full day', () => {
  assert.strictEqual(leaveDuration({ hr_days: 3 }).label, '3 days');
  assert.strictEqual(isHalfDayLeave({ hr_days: 3 }), false);
});

test('absent hr_days defaults to 0 days (no crash)', () => {
  assert.strictEqual(leaveDurationDays({}), 0);
  assert.strictEqual(leaveDuration({}).label, '0 days');
});

test('boolean true (not string) is also treated as a half day', () => {
  assert.strictEqual(isHalfDayLeave({ hr_days: 1, hr_halfday: true }), true);
  assert.strictEqual(leaveDuration({ hr_days: 1, hr_halfday: true }).label, '0.5 day (half)');
});
