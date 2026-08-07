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

test('medCert: defaults require a certificate after 1 day (2+ day sick leave)', () => {
  const r = svc.resolve(null);
  assert.strictEqual(r.medCert.required, true);
  assert.strictEqual(r.medCert.afterDays, 1);
});

test('medCert: configurable — can be disabled and threshold raised', () => {
  const off = svc.resolve({ hr_medcertrequired: 'false' });
  assert.strictEqual(off.medCert.required, false);
  const raised = svc.resolve({ hr_medcertrequired: 'true', hr_medcertafterdays: '3' });
  assert.strictEqual(raised.medCert.required, true);
  assert.strictEqual(raised.medCert.afterDays, 3);
});

// ── mergeSaved priority: latest DB column > JSON blob > defaults ──────────────
test('mergeSaved: a live DB column WINS over a stale JSON blob (12→13.13 bug)', () => {
  const row = {
    hr_payrollsettingid: 'row-1',
    hr_pfemployeepercent: '13.13',                         // latest DB column
    hr_settingsjson: JSON.stringify({ hr_pfemployeepercent: '12' }),   // stale blob
  };
  const m = svc.mergeSaved(row);
  assert.strictEqual(m.hr_pfemployeepercent, '13.13');     // column wins, NOT the blob's 12
  assert.strictEqual(svc.resolve(m).pf.employeePercent, 13.13);
});

test('mergeSaved: blob only FILLS a missing/empty column', () => {
  // column absent (not provisioned) → blob fills it
  const m1 = svc.mergeSaved({ hr_settingsjson: JSON.stringify({ hr_ptamount: '250' }) });
  assert.strictEqual(m1.hr_ptamount, '250');
  // column present but EMPTY → blob still fills it
  const m2 = svc.mergeSaved({ hr_ptamount: '', hr_settingsjson: JSON.stringify({ hr_ptamount: '250' }) });
  assert.strictEqual(m2.hr_ptamount, '250');
  // neither column nor blob → default
  const m3 = svc.mergeSaved({});
  assert.strictEqual(m3.hr_ptamount, '200');
});

test('mergeSaved: every setting family honours column > blob (PT, allowances, deductions, late login, comp off, leave)', () => {
  const cols = {
    hr_ptapplicable: 'false',
    hr_defaultallowances: JSON.stringify([{ name: 'HRA', type: 'percent', value: 50 }]),
    hr_defaultdeductions: JSON.stringify([{ name: 'Loan', type: 'fixed', value: 1000 }]),
    hr_gracetime: '20',           // Late Login
    hr_compoffexpirydays: '30',   // Comp Off
    hr_casualleaves: '15',        // Leave
  };
  const stale = JSON.stringify({
    hr_ptapplicable: 'true', hr_defaultallowances: '[]', hr_defaultdeductions: '[]',
    hr_gracetime: '15', hr_compoffexpirydays: '45', hr_casualleaves: '12',
  });
  const r = svc.resolve(svc.mergeSaved({ ...cols, hr_settingsjson: stale }));
  assert.strictEqual(r.professionalTax.applicable, false);
  assert.strictEqual(r.defaultAllowances[0].value, 50);
  assert.strictEqual(r.defaultDeductions[0].value, 1000);
  assert.strictEqual(r.lateLogin.graceMinutes, 20);
  assert.strictEqual(r.compOff.expiryDays, 30);
  assert.strictEqual(r.leavePolicy.casual, 15);
});

test('mergeSaved: corrupt blob is ignored (columns/defaults still apply)', () => {
  const m = svc.mergeSaved({ hr_pfemployeepercent: '11', hr_settingsjson: '{not json' });
  assert.strictEqual(m.hr_pfemployeepercent, '11');
});
