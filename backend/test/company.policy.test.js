const { test } = require('node:test');
const assert = require('node:assert');
const policy = require('../src/services/company.policy');

const stub = (over) => policy.setProvider({ load: () => over });

test('namespaced getters; nulls fall back to the shift', () => {
  stub({ monthlyPaidLeave: 2, compensationEnabled: false, lateDeductionEnabled: true });
  assert.strictEqual(policy.payroll.monthlyPaidLeave(), 2);
  assert.strictEqual(policy.payroll.compensationEnabled(), false);
  assert.strictEqual(policy.payroll.lateDeductionEnabled(), true);
  assert.strictEqual(policy.attendance.halfDayThreshold(9), 4.5);  // null → shift/2
  assert.strictEqual(policy.attendance.requiredShiftHours(9), 9);  // null → shift duration
});

test('threshold overrides honored', () => {
  stub({ requiredShiftHours: 6, halfDayThreshold: 3 });
  assert.strictEqual(policy.attendance.requiredShiftHours(9), 6);
  assert.strictEqual(policy.attendance.halfDayThreshold(9), 3);
});

test('provider swap (env→DB) with no reader changes', () => {
  stub({ monthlyPaidLeave: 1 });
  assert.strictEqual(policy.payroll.monthlyPaidLeave(), 1);
  stub({ monthlyPaidLeave: 3 });                                   // "database" says 3
  assert.strictEqual(policy.payroll.monthlyPaidLeave(), 3);
});

test('missing keys use defaults', () => {
  stub({});
  assert.strictEqual(policy.payroll.monthlyPaidLeave(), 1);
  assert.strictEqual(policy.payroll.lunchDeductionEnabled(), false);
});
