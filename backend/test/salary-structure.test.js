/**
 * Salary Structure service — pure compute/validate/shape (no network).
 */
process.env.NODE_ENV = 'test';
process.env.AZURE_CLIENT_ID = process.env.AZURE_CLIENT_ID || 'test-client';
process.env.AZURE_CLIENT_SECRET = process.env.AZURE_CLIENT_SECRET || 'test-secret';
process.env.AZURE_TENANT_ID = process.env.AZURE_TENANT_ID || 'test-tenant';

const { test } = require('node:test');
const assert = require('node:assert');
const svc = require('../src/services/salary-structure.service');

test('computeGross = Basic + HRA + Special + Medical + Conveyance + Other', () => {
  const g = svc.computeGross({ basic: 40000, hra: 16000, special: 4000, medical: 1250, conveyance: 1600, otherAllowance: 2150 });
  assert.strictEqual(g, 65000);
});

test('computeTotals: net = gross - (pf + pt + it + other)', () => {
  const t = svc.computeTotals({ basic: 40000, hra: 16000, pfApplicable: true, pfAmount: 1800, professionalTax: 200, incomeTax: 500, otherDeductions: 0 });
  assert.strictEqual(t.gross, 56000);
  assert.strictEqual(t.totalDeductions, 2500);
  assert.strictEqual(t.netSalary, 53500);
});

test('computeTotals: PF not applicable → PF excluded from deductions', () => {
  const t = svc.computeTotals({ basic: 30000, pfApplicable: false, pfAmount: 1800, professionalTax: 200 });
  assert.strictEqual(t.totalDeductions, 200);
  assert.strictEqual(t.netSalary, 29800);
});

test('validate: requires employee (POST), valid date, positive basic', () => {
  const r = svc.validate({}, { requireEmployee: true });
  assert.strictEqual(r.ok, false);
  assert.ok(r.errors.some(e => /select an employee/i.test(e)));
  assert.ok(r.errors.some(e => /Effective From/i.test(e)));
  assert.ok(r.errors.some(e => /Basic Salary/i.test(e)));
});

test('validate: rejects a non-GUID employee', () => {
  const r = svc.validate({ employeeId: 'Jaya Tharuja', effectiveFrom: '2026-04-01', basic: 100 }, { requireEmployee: true });
  assert.strictEqual(r.ok, false);
  assert.ok(r.errors.some(e => /pick one from the list/i.test(e)));
});

test('validate: computes gross and forces PF amount to 0 when not applicable', () => {
  const r = svc.validate({
    employeeId: '11111111-1111-1111-1111-111111111111', effectiveFrom: '2026-04-01',
    basic: 40000, hra: 16000, special: 4000, pfApplicable: false, pfAmount: 1800,
  }, { requireEmployee: true });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.value.gross, 60000);
  assert.strictEqual(r.value.pfApplicable, false);
  assert.strictEqual(r.value.pfAmount, 0);
});

test('validate: negative amounts rejected', () => {
  const r = svc.validate({ employeeId: '11111111-1111-1111-1111-111111111111', effectiveFrom: '2026-04-01', basic: 40000, hra: -100 }, { requireEmployee: true });
  assert.strictEqual(r.ok, false);
  assert.ok(r.errors.some(e => /hra cannot be negative/i.test(e)));
});

test('toDataverse: maps camelCase → hr_* with int amounts and boolean-as-string', () => {
  const { value } = svc.validate({ employeeId: '11111111-1111-1111-1111-111111111111', effectiveFrom: '2026-04-01', basic: 40000, hra: 16000.7, pfApplicable: true, pfAmount: 1800 }, { requireEmployee: true });
  const dv = svc.toDataverse({ ...value, employeeName: 'Jaya Tharuja' });
  assert.strictEqual(dv.hr_basic, 40000);
  assert.strictEqual(dv.hr_hra, 16001);        // rounded
  assert.strictEqual(dv.hr_pfapplicable, 'true');
  assert.strictEqual(dv.hr_employeename, 'Jaya Tharuja');
  assert.strictEqual(dv.hr_effectivefrom, '2026-04-01');
});

test('shape: raw row → clean API object with computed totals', () => {
  const s = svc.shape({
    hr_salarystructureid: 'abc', hr_employeeid: 'guid', hr_employeename: 'Jaya',
    hr_effectivefrom: '2026-04-01', hr_basic: 40000, hr_hra: 16000, hr_special: 4000,
    hr_pfapplicable: 'true', hr_pfamount: 1800, hr_professionaltax: 200, hr_incometax: 0, hr_otherdeductions: 0,
    hr_status: 'active',
  });
  assert.strictEqual(s.gross, 60000);
  assert.strictEqual(s.totalDeductions, 2000);
  assert.strictEqual(s.netSalary, 58000);
  assert.strictEqual(s.pfApplicable, true);
  assert.strictEqual(s.status, 'active');
});

test('shape: PF not applicable zeroes the PF amount on read', () => {
  const s = svc.shape({ hr_basic: 30000, hr_pfapplicable: 'false', hr_pfamount: 1800, hr_professionaltax: 200 });
  assert.strictEqual(s.pfAmount, 0);
  assert.strictEqual(s.totalDeductions, 200);
  assert.strictEqual(s.netSalary, 29800);
});
