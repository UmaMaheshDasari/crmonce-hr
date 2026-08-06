/**
 * Payroll Settings service — pure defaults/merge/resolve logic (no network).
 */
process.env.NODE_ENV = 'test';
process.env.AZURE_CLIENT_ID = process.env.AZURE_CLIENT_ID || 'test-client';
process.env.AZURE_CLIENT_SECRET = process.env.AZURE_CLIENT_SECRET || 'test-secret';
process.env.AZURE_TENANT_ID = process.env.AZURE_TENANT_ID || 'test-tenant';

const { test } = require('node:test');
const assert = require('node:assert');
const svc = require('../src/services/payroll-settings.service');

test('defaults: leave policy is 18 combined (12 CL + 6 SL)', () => {
  const r = svc.resolve(null);
  assert.strictEqual(r.leavePolicy.paidPerYear, 18);
  assert.strictEqual(r.leavePolicy.casual, 12);
  assert.strictEqual(r.leavePolicy.sick, 6);
});

test('resolve: PF/PT/IT typed + applicability booleans', () => {
  const r = svc.resolve(null);
  assert.strictEqual(r.pf.employeePercent, 12);
  assert.strictEqual(r.pf.employerPercent, 12);
  assert.strictEqual(r.pf.wageCeiling, 15000);
  assert.strictEqual(r.pf.applicable, true);
  assert.strictEqual(r.professionalTax.amount, 200);
  assert.strictEqual(r.professionalTax.applicable, true);
  assert.strictEqual(r.incomeTax.applicable, false);
});

test('resolve: overtime, working hours, LOP basis, weekly off list', () => {
  const r = svc.resolve(null);
  assert.strictEqual(r.workingHoursPerDay, 8);
  assert.strictEqual(r.overtimeMultiplier, 2);
  assert.strictEqual(r.lopBasis, 'salary_working_days');
  assert.deepStrictEqual(r.weeklyOff, ['Sunday']);
});

test('merge: a DB row overrides defaults; blanks fall back', () => {
  const merged = svc.merge({ hr_pfemployeepercent: '10', hr_ptamount: '', hr_weeklyoff: 'Saturday,Sunday' });
  assert.strictEqual(merged.hr_pfemployeepercent, '10');       // overridden
  assert.strictEqual(merged.hr_ptamount, '200');              // blank → default
  const r = svc.resolve(merged);
  assert.strictEqual(r.pf.employeePercent, 10);
  assert.deepStrictEqual(r.weeklyOff, ['Saturday', 'Sunday']);
});

test('resolve: applicability accepts true/false strings and toggles', () => {
  assert.strictEqual(svc.resolve({ hr_pfapplicable: 'false' }).pf.applicable, false);
  assert.strictEqual(svc.resolve({ hr_itapplicable: 'true' }).incomeTax.applicable, true);
  assert.strictEqual(svc.resolve({ hr_ptapplicable: '1' }).professionalTax.applicable, true);
});

test('resolve: default allowances parse as an array of components', () => {
  const r = svc.resolve(null);
  assert.ok(Array.isArray(r.defaultAllowances));
  const hra = r.defaultAllowances.find(a => /HRA/.test(a.name));
  assert.ok(hra, 'HRA component present');
  assert.strictEqual(hra.type, 'percent');
  assert.strictEqual(hra.value, 40);
});

test('resolve: broken JSON in a component column falls back to []', () => {
  const r = svc.resolve({ hr_defaultallowances: '{not json', hr_defaultdeductions: '' });
  assert.deepStrictEqual(r.defaultAllowances, []);
  assert.deepStrictEqual(r.defaultDeductions, []);
});

test('resolve: already-parsed array/object passes through', () => {
  const arr = [{ name: 'Loan EMI', type: 'fixed', value: 5000 }];
  assert.deepStrictEqual(svc.resolve({ hr_defaultdeductions: arr }).defaultDeductions, arr);
});

test('lopBasis override is preserved', () => {
  assert.strictEqual(svc.resolve({ hr_lopbasis: 'fixed_30' }).lopBasis, 'fixed_30');
});
