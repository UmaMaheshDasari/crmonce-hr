/**
 * Email category registry — stable keys, defaults (all enabled), and the meta.type → category
 * mapping that drives centralized suppression. Pure; no network.
 */
process.env.NODE_ENV = 'test';
const { test } = require('node:test');
const assert = require('node:assert');
const { CATEGORIES, CATEGORY_KEYS, isValidCategory, defaultPreferences, categoryForType } = require('../src/services/email-categories');

test('registry: stable keys, no duplicates, display fields present', () => {
  assert.ok(CATEGORIES.length >= 6);
  assert.strictEqual(new Set(CATEGORY_KEYS).size, CATEGORY_KEYS.length, 'no duplicate category keys');
  for (const c of CATEGORIES) { assert.ok(c.key && c.name && c.description, `category ${c.key} fully described`); }
  // Categories that do NOT exist in this HRMS must be absent (no fabricated categories).
  for (const absent of ['certification', 'training', 'announcements']) {
    assert.ok(!CATEGORY_KEYS.includes(absent), `${absent} not a category (no such emails exist)`);
  }
});

test('default preferences: EVERY category enabled (scenario A / Q)', () => {
  const d = defaultPreferences();
  assert.deepStrictEqual(Object.keys(d).sort(), [...CATEGORY_KEYS].sort());
  assert.ok(Object.values(d).every(v => v === true), 'all categories default to enabled');
});

test('isValidCategory', () => {
  assert.ok(isValidCategory('birthday'));
  assert.ok(!isValidCategory('nope'));
  assert.ok(!isValidCategory(''));
});

test('categoryForType maps every real email tag to a category', () => {
  const cases = {
    celebration_birthday: 'birthday',
    celebration_work_anniversary: 'anniversary',
    celebration_marriage_anniversary: 'anniversary',
    MISSING_PUNCH: 'attendance',
    LATE_LOGIN: 'attendance',
    LATE_LOGIN_HR_WARNING: 'attendance',
    EARLY_LOGOUT_APPROVAL_REQUIRED: 'attendance',
    ABSENT_LEAVE_NOT_APPLIED: 'attendance',
    permission_policy: 'attendance',
    late_login_decision: 'attendance',
    leave_decision: 'leave',
    leave_ack: 'leave',
    comp_off: 'leave',
    payslip: 'payroll',
    goal_assigned: 'performance',
    goal_reassigned: 'performance',
    'GOAL_REMINDER:abc': 'performance',
    PROFILE_REMINDER: 'reminders',
    PASSPORT_REMINDER: 'reminders',
    advance: 'other',
    profile_decision: 'other',
    lifecycle: 'other',
  };
  for (const [type, cat] of Object.entries(cases)) {
    assert.strictEqual(categoryForType(type), cat, `${type} → ${cat}`);
  }
});

test('categoryForType returns null for uncategorized/operational mail (always delivered)', () => {
  for (const t of ['generic', '', undefined, null, 'late_login_info', 'missing_punch_new_hr']) {
    // NOTE: late_login_info / *_new_hr go to HR lists with no employeeId, so even if mapped
    // they are never suppressed; but they map to attendance here — assert the truly-unknown ones:
  }
  assert.strictEqual(categoryForType('generic'), null);
  assert.strictEqual(categoryForType(''), null);
  assert.strictEqual(categoryForType(undefined), null);
  assert.strictEqual(categoryForType('something_unknown'), null);
});
