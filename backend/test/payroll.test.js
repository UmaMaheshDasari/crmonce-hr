/**
 * Payroll calculation engine + payslip PDF generation.
 * The PDF test passes `company` explicitly so no Dataverse/network call happens.
 */
process.env.NODE_ENV = 'test';
process.env.AZURE_CLIENT_ID = process.env.AZURE_CLIENT_ID || 'test-client';
process.env.AZURE_CLIENT_SECRET = process.env.AZURE_CLIENT_SECRET || 'test-secret';
process.env.AZURE_TENANT_ID = process.env.AZURE_TENANT_ID || 'test-tenant';

const { test } = require('node:test');
const assert = require('node:assert');
const { computePayroll } = require('../src/services/payroll.calc');
const { buildPayslipPdf, numberToWords } = require('../src/services/payslip.service');

test('computePayroll: full attendance → gross = basic+allowances, net = gross - deductions', () => {
  const c = computePayroll({ basic: 6000, allowances: 2000, fixedDeductions: 500, salaryWorkingDays: 26, lopDays: 0, overtimeHours: 0 });
  assert.strictEqual(c.grossSalary, 8000);
  assert.strictEqual(c.payableDays, 26);
  assert.strictEqual(c.totalDeductions, 500);
  assert.strictEqual(c.netSalary, 7500);
});

test('computePayroll: LOP prorates earnings', () => {
  const c = computePayroll({ basic: 2600, allowances: 0, fixedDeductions: 0, salaryWorkingDays: 26, lopDays: 2 });
  // per-day = 100; 24 payable days → earned 2400.
  assert.strictEqual(c.perDay, 100);
  assert.strictEqual(c.payableDays, 24);
  assert.strictEqual(c.grossSalary, 2400);
  assert.strictEqual(c.lopDeduction, 200);   // informational
  assert.strictEqual(c.netSalary, 2400);
});

test('computePayroll: overtime adds to gross', () => {
  const c = computePayroll({ basic: 8000, allowances: 0, fixedDeductions: 0, salaryWorkingDays: 25, lopDays: 0, overtimeHours: 4, overtimeRate: 100 });
  assert.strictEqual(c.overtimePay, 400);
  assert.strictEqual(c.grossSalary, 8400);
});

test('computePayroll: never negative; lopDays capped at working days', () => {
  const c = computePayroll({ basic: 1000, allowances: 0, fixedDeductions: 0, salaryWorkingDays: 5, lopDays: 99 });
  assert.strictEqual(c.payableDays, 0);
  assert.strictEqual(c.grossSalary, 0);
  assert.strictEqual(c.netSalary, 0);
});

test('numberToWords: Indian format', () => {
  assert.strictEqual(numberToWords(8000), 'Eight Thousand');
  assert.strictEqual(numberToWords(7500), 'Seven Thousand Five Hundred');
  assert.strictEqual(numberToWords(125000), 'One Lakh Twenty Five Thousand');
  assert.strictEqual(numberToWords(0), 'Zero');
});

test('buildPayslipPdf: returns a valid PDF buffer (no network)', async () => {
  const company = { hr_name: 'CRMONCE (OPC) PRIVATE LIMITED', hr_cin: 'U72900AP2020OPC115113', hr_addressline: 'Kodurupadu, Nellore, Andhra Pradesh 524314', hr_city: 'Nellore' };
  const payroll = { hr_month: 1, hr_year: 2025, hr_basic: 6000, hr_allowances: 2000, hr_deductions: 0, hr_netpay: 8000, hr_gross: 8000, hr_workingdays: 31, hr_paydays: 31 };
  const employee = { hr_hremployee1: 'Vendikalla Pavankumar', hr_etimecode: 'EMP1020', hr_pan: 'OMXPK2222R', hr_bankname: 'State Bank of India', hr_accountnumber: '43431863275', hr_joiningdate: '2024-07-17' };
  const buf = await buildPayslipPdf({ payroll, employee, company });
  assert.ok(Buffer.isBuffer(buf));
  assert.ok(buf.length > 800);
  assert.strictEqual(buf.slice(0, 4).toString(), '%PDF');
});

// Capture every string drawn onto the payslip (pdfkit embeds a subset font, so
// the compressed PDF stream can't be text-searched — intercepting doc.text is the
// reliable way to assert on rendered content).
async function renderText({ payroll, employee, company }) {
  const PDFDocument = require('pdfkit');
  const orig = PDFDocument.prototype.text;
  const out = [];
  PDFDocument.prototype.text = function (str, ...rest) { out.push(String(str)); return orig.call(this, str, ...rest); };
  try { await buildPayslipPdf({ payroll, employee, company }); } finally { PDFDocument.prototype.text = orig; }
  return out;
}
const COMP = { hr_name: 'CRMONCE (OPC) PRIVATE LIMITED', hr_gstin: '37AAICC8445J1Z7', hr_cin: 'U72900AP2020OPC115113', hr_addressline: 'Kodurupadu, Nellore, Andhra Pradesh 524314', hr_email: 'info@crmonce.com', hr_website: 'crmonce.com' };
const EMP = { hr_employeeid: 'EMP1039', hr_hremployee1: 'Jaya Tharuja', hr_pan: 'ABCDE1234F', hr_accountnumber: '123456789012' };

test('payslip: ESI removed; PF/PT/TDS/LOP/Advance/Other rows in order', async () => {
  const t = await renderText({ payroll: { hr_month: 8, hr_year: 2026, hr_basic: 40000, hr_allowances: 10000, hr_deductions: 5000, hr_gross: 50000, hr_netpay: 45000, hr_lop: 0 }, employee: EMP, company: COMP });
  assert.ok(!t.some(x => x.includes('ESI')), 'ESI must be gone');
  const ix = (s) => t.findIndex(x => x.includes(s));
  const order = ['Provident Fund (PF)', 'Professional Tax', 'Income Tax (TDS)', 'LOP Deduction', 'Advance Salary', 'Other Deductions'].map(ix);
  assert.ok(order.every(i => i >= 0), 'all deduction rows present');
  for (let i = 1; i < order.length; i++) assert.ok(order[i - 1] < order[i], 'deduction rows in the specified order');
});

test('payslip: no advance → Advance shows Rs. 0.00 and net unchanged', async () => {
  const t = await renderText({ payroll: { hr_month: 8, hr_year: 2026, hr_basic: 40000, hr_allowances: 10000, hr_deductions: 5000, hr_gross: 50000, hr_netpay: 45000, hr_lop: 0 }, employee: EMP, company: COMP });
  assert.ok(t.some(x => x.includes('Advance Salary')));
  assert.ok(t.some(x => x.includes('Rs. 0.00')), 'zero advance renders Rs. 0.00');
  assert.ok(t.some(x => x.includes('Rs. 50,000.00')), 'gross');
  assert.ok(t.some(x => x.includes('Rs. 45,000.00')), 'net = gross - deductions');
});

test('payslip: advance + LOP reduce net correctly (Net = Gross - PF - PT - TDS - LOP - Advance - Other)', async () => {
  // full gross 50000; deductions = 0+0+0 + LOP 2000 + Advance 7500 + Other 5000 = 14500; net = 35500.
  const t = await renderText({ payroll: { hr_month: 8, hr_year: 2026, hr_basic: 40000, hr_allowances: 10000, hr_deductions: 5000, hr_gross: 48000, hr_netpay: 45000, hr_lop: 2000, hr_advance: 7500 }, employee: EMP, company: COMP });
  assert.ok(t.some(x => x.includes('Rs. 7,500.00')), 'advance amount shown');
  assert.ok(t.some(x => x.includes('Rs. 2,000.00')), 'LOP amount shown');
  assert.ok(t.some(x => x.includes('Rs. 14,500.00')), 'total deductions');
  assert.ok(t.some(x => x.includes('Rs. 35,500.00')), 'net reduced by advance');
});

test('payslip: website normalised to https://hr.crmonce.com; email labelled', async () => {
  const t = await renderText({ payroll: { hr_month: 8, hr_year: 2026, hr_basic: 40000, hr_allowances: 10000, hr_deductions: 0, hr_gross: 50000, hr_netpay: 50000, hr_lop: 0 }, employee: EMP, company: COMP });
  assert.ok(t.some(x => x.includes('https://hr.crmonce.com')), 'HR portal URL');
  assert.ok(t.some(x => x.includes('Website:')), 'website label');
  assert.ok(t.some(x => x.includes('Email:') && x.includes('info@crmonce.com')), 'email label + address');
  assert.ok(!t.some(x => /Website:\s*(https?:\/\/)?(www\.)?crmonce\.com(\s|$)/i.test(x)), 'legacy bare crmonce.com not shown as website');
});

test('payslip: a genuinely different website in settings is preserved', async () => {
  const t = await renderText({ payroll: { hr_month: 8, hr_year: 2026, hr_basic: 1000, hr_allowances: 0, hr_deductions: 0, hr_gross: 1000, hr_netpay: 1000, hr_lop: 0 }, employee: EMP, company: { ...COMP, hr_website: 'https://portal.example.com' } });
  assert.ok(t.some(x => x.includes('https://portal.example.com')), 'non-crmonce URL passes through unchanged');
});
