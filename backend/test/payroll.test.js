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
