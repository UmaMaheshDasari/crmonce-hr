/**
 * Payroll LIST totals must equal the Payslip totals (List = Detail = Payslip).
 *
 * The list row's raw hr_allowances / hr_deductions are only the "Other" buckets, not
 * the totals. The list now enriches each row with computeFigures() — the SAME engine
 * the Detail + Payslip use — exactly as payroll.routes does:
 *   _allowances = gross − basic ; _deductions = computeFigures.deductions ; _net = net.
 */
process.env.NODE_ENV = 'test';
process.env.AZURE_CLIENT_ID = process.env.AZURE_CLIENT_ID || 'test-client';
process.env.AZURE_CLIENT_SECRET = process.env.AZURE_CLIENT_SECRET || 'test-secret';
process.env.AZURE_TENANT_ID = process.env.AZURE_TENANT_ID || 'test-tenant';

const { test } = require('node:test');
const assert = require('node:assert');
const { computeFigures, payslipModel } = require('../src/services/payslip.service');

// The exact enrichment payroll.routes.js GET / applies to each list row.
function listTotals(r) {
  const f = computeFigures(r);
  const basic = Number(r.hr_basic) || 0;
  return { basic, allowances: f.gross - basic, deductions: f.deductions, gross: f.gross, net: f.net };
}

// hr_professionaltax is the STORED, resolved PT (0 for a PT-exempt row). When absent,
// computeFigures falls back to the PT-slab — the same behaviour the payslip uses — so a
// "no deductions" scenario sets it to 0, exactly as a generated payroll row would.
test('1. allowances only (HRA + Special) → list allowances = sum, deductions 0', () => {
  const t = listTotals({ hr_basic: 10000, hr_hra: 4000, hr_special: 2000, hr_professionaltax: 0 });
  assert.deepStrictEqual(t, { basic: 10000, allowances: 6000, deductions: 0, gross: 16000, net: 16000 });
});

test('2. deductions only (PF + PT + TDS) → allowances 0, deductions = sum', () => {
  const t = listTotals({ hr_basic: 20000, hr_pf: 1800, hr_professionaltax: 200, hr_incometax: 1000 });
  assert.strictEqual(t.allowances, 0);
  assert.strictEqual(t.deductions, 3000);
  assert.strictEqual(t.net, 17000);
});

test('3. both allowances + deductions', () => {
  const t = listTotals({ hr_basic: 30000, hr_hra: 12000, hr_special: 3000, hr_medical: 1000, hr_conveyance: 1000, hr_pf: 1800, hr_professionaltax: 200 });
  assert.strictEqual(t.allowances, 17000);
  assert.strictEqual(t.deductions, 2000);
  assert.strictEqual(t.gross, 47000);
  assert.strictEqual(t.net, 45000);
});

test('4. PF + PT → deductions = PF + PT (the reported ₹0 bug)', () => {
  const t = listTotals({ hr_basic: 16000, hr_pf: 1000, hr_professionaltax: 150, hr_deductions: 0 });
  assert.strictEqual(t.deductions, 1150);   // NOT 0 (which is only the hr_deductions "Other" bucket)
  assert.strictEqual(t.net, 14850);
});

test('5. LOP is part of deductions', () => {
  const t = listTotals({ hr_basic: 20000, hr_lop: 2000, hr_professionaltax: 0 });
  assert.strictEqual(t.deductions, 2000);
  assert.strictEqual(t.net, 18000);
});

test('advance recovery + other-deductions bucket both count', () => {
  assert.strictEqual(listTotals({ hr_basic: 20000, hr_advance: 1000, hr_deductions: 500, hr_professionaltax: 0 }).deductions, 1500);
});

test('6. no allowances / no deductions → 0 / 0, net = basic', () => {
  const t = listTotals({ hr_basic: 15000, hr_professionaltax: 0 });
  assert.deepStrictEqual(t, { basic: 15000, allowances: 0, deductions: 0, gross: 15000, net: 15000 });
});

test('7/8. the resolved component (percentage OR fixed) flows through unchanged', () => {
  // The engine stores the resolved amount; the list reads it — it never re-derives %.
  const t = listTotals({ hr_basic: 40000, hr_hra: 16000 /* e.g. 40% of basic, resolved upstream */, hr_special: 5000 });
  assert.strictEqual(t.allowances, 21000);
});

test('LIST totals EQUAL the PAYSLIP model totals (three screens agree)', async () => {
  const r = { hr_month: 8, hr_year: 2026, hr_basic: 30000, hr_hra: 12000, hr_special: 3000, hr_pf: 1800, hr_professionaltax: 200 };
  const model = await payslipModel({ payroll: r, employee: {}, company: { hr_name: 'C', hr_addressline: 'x' } });
  const t = listTotals(r);
  assert.strictEqual(t.deductions, model.totalDeductions, 'deductions match payslip');
  assert.strictEqual(t.gross, model.gross, 'gross matches payslip');
  assert.strictEqual(t.net, model.net, 'net matches payslip');
  const nonBasicEarnings = model.earnings.filter((e) => e.label !== 'Basic').reduce((s, e) => s + e.amount, 0);
  assert.strictEqual(t.allowances, nonBasicEarnings, 'allowances = sum of non-basic earnings on the payslip');
});
