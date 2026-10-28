/**
 * Goal Reminder Settings UI helpers (pure, no React).
 * Run: `node --test src/utils/goal-reminder-settings.test.js`
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { GOAL_MILESTONES, GOAL_OVERDUE_INTERVAL, isEnabled, normalizeGoalToggles } from './goal-reminder-settings.js';

test('milestones: 9 toggles incl overdue; overdue interval key + 1–30 default 3', () => {
  assert.strictEqual(GOAL_MILESTONES.length, 9);
  assert.ok(GOAL_MILESTONES.some(m => m.key === 'hr_goalrem_m3'));
  assert.ok(GOAL_MILESTONES.some(m => m.key === 'hr_goalrem_d3'));
  assert.ok(GOAL_MILESTONES.some(m => m.key === 'hr_goalrem_overdue'));
  assert.strictEqual(GOAL_OVERDUE_INTERVAL.key, 'hr_goaloverdueintervaldays');
  assert.strictEqual(GOAL_OVERDUE_INTERVAL.default, 3);
  assert.strictEqual(GOAL_OVERDUE_INTERVAL.min, 1);
  assert.strictEqual(GOAL_OVERDUE_INTERVAL.max, 30);
});

test('isEnabled: true/false string + boolean parsing', () => {
  assert.strictEqual(isEnabled('true'), true);
  assert.strictEqual(isEnabled(true), true);
  assert.strictEqual(isEnabled('false'), false);
  assert.strictEqual(isEnabled(''), false);
  assert.strictEqual(isEnabled(undefined), false);
});

test('normalizeGoalToggles: strings→booleans; missing/blank → default ON; all 9 keys present', () => {
  const n = normalizeGoalToggles({ hr_goalrem_m3: 'false', hr_goalrem_d7: 'true', hr_goalrem_due: '' });
  assert.strictEqual(n.hr_goalrem_m3, false);
  assert.strictEqual(n.hr_goalrem_d7, true);
  assert.strictEqual(n.hr_goalrem_due, true);    // blank → default ON
  assert.strictEqual(n.hr_goalrem_overdue, true); // missing → default ON
  for (const m of GOAL_MILESTONES) assert.ok(m.key in n, `${m.key} present`);
});
