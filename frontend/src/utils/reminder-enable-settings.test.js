/**
 * Master reminder ON/OFF toggle helpers (pure, no React).
 * Run: `node --test src/utils/reminder-enable-settings.test.js`
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { GOAL_REMINDERS_ENABLED, PROFILE_REMINDERS_ENABLED, REMINDER_ENABLE_KEYS, isEnabled, normalizeEnableToggles } from './reminder-enable-settings.js';

test('keys map to the backend company settings', () => {
  assert.strictEqual(GOAL_REMINDERS_ENABLED.key, 'hr_goalremindersenabled');
  assert.strictEqual(PROFILE_REMINDERS_ENABLED.key, 'hr_profileremindersenabled');
  assert.deepStrictEqual([...REMINDER_ENABLE_KEYS], ['hr_goalremindersenabled', 'hr_profileremindersenabled']);
});

test('isEnabled: true/false strings + boolean', () => {
  assert.strictEqual(isEnabled('true'), true);
  assert.strictEqual(isEnabled(true), true);
  assert.strictEqual(isEnabled('false'), false);
  assert.strictEqual(isEnabled(''), false);
  assert.strictEqual(isEnabled(undefined), false);
});

test('normalizeEnableToggles: string→boolean; missing/blank → default ON', () => {
  const n = normalizeEnableToggles({ hr_goalremindersenabled: 'false', hr_profileremindersenabled: '' });
  assert.strictEqual(n.hr_goalremindersenabled, false);
  assert.strictEqual(n.hr_profileremindersenabled, true);   // blank → ON
  assert.deepStrictEqual(Object.keys(n).sort(), ['hr_goalremindersenabled', 'hr_profileremindersenabled']);
});
