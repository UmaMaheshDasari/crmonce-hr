/**
 * Automated Reminder Interval company-setting helpers (pure, no React).
 * Run: `node --test src/utils/reminder-settings.test.js`
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { REMINDER_INTERVAL, parseInterval, clampReminderInterval, validateReminderInterval } from './reminder-settings.js';

test('constants: key, default, and 1–30 bounds', () => {
  assert.strictEqual(REMINDER_INTERVAL.key, 'hr_reminderintervaldays');
  assert.strictEqual(REMINDER_INTERVAL.default, 3);
  assert.strictEqual(REMINDER_INTERVAL.min, 1);
  assert.strictEqual(REMINDER_INTERVAL.max, 30);
});

test('parseInterval: numeric → whole number; empty/invalid → null', () => {
  assert.strictEqual(parseInterval('7'), 7);
  assert.strictEqual(parseInterval(7.9), 7);
  assert.strictEqual(parseInterval(''), null);
  assert.strictEqual(parseInterval(null), null);
  assert.strictEqual(parseInterval(undefined), null);
  assert.strictEqual(parseInterval('abc'), null);
});

test('clampReminderInterval: empty/invalid → default; below min → 1; above max → 30; valid kept', () => {
  assert.strictEqual(clampReminderInterval(''), 3);       // loading a blank value → default
  assert.strictEqual(clampReminderInterval('abc'), 3);
  assert.strictEqual(clampReminderInterval(0), 1);
  assert.strictEqual(clampReminderInterval(-5), 1);
  assert.strictEqual(clampReminderInterval(31), 30);
  assert.strictEqual(clampReminderInterval('7'), 7);
  assert.strictEqual(clampReminderInterval(7.9), 7);
});

test('validateReminderInterval: in-range → true; out-of-range and non-numeric → messages', () => {
  assert.strictEqual(validateReminderInterval(3), true);
  assert.strictEqual(validateReminderInterval(1), true);
  assert.strictEqual(validateReminderInterval(30), true);
  assert.match(validateReminderInterval(0), /between 1 and 30/);
  assert.match(validateReminderInterval(31), /between 1 and 30/);
  assert.match(validateReminderInterval('abc'), /whole number/);
  assert.match(validateReminderInterval(''), /whole number/);
});
