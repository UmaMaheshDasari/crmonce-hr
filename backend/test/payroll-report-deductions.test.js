/**
 * Payroll Excel "Deductions" column MUST be the TOTAL deduction (Gross − Net), not the stored
 * hr_deductions field (which holds ONLY the "Other" bucket and is ₹0 for anyone whose deductions
 * are PF/PT/TDS/LOP). The bug showed Deductions = 0 for employees who actually had PT deducted.
 *
 * These rows mirror real July 2026 production: a 35000-gross employee with ₹200 PT (net 34800),
 * and a 12000-gross employee with no deductions (net 12000 — where 0 is genuinely correct).
 * No network — d365.getList / companySvc.getCompany stubbed.
 */
process.env.NODE_ENV = 'test';
process.env.AZURE_CLIENT_ID = process.env.AZURE_CLIENT_ID || 'x';
process.env.AZURE_CLIENT_SECRET = process.env.AZURE_CLIENT_SECRET || 'x';
process.env.AZURE_TENANT_ID = process.env.AZURE_TENANT_ID || 'x';

const { test } = require('node:test');
const assert = require('node:assert');
const reports = require('../src/services/payroll-reports.service');
const d365 = require('../src/services/d365.service');
const companySvc = require('../src/services/company.service');

const E = d365.constructor.entities;
const fv = '_hr_hremployee_value@OData.Community.Display.V1.FormattedValue';

// hr_deductions is deliberately 0 (the "Other" bucket) while real deductions live in Gross−Net.
const ROWS = [
  { hr_hrpayrollid: 'p1', _hr_hremployee_value: 'gU', [fv]: 'Uttej', hr_month: 7, hr_year: 2026, hr_basic: 35000, hr_gross: 35000, hr_netpay: 34800, hr_deductions: 0, hr_professionaltax: 200 },
  { hr_hrpayrollid: 'p2', _hr_hremployee_value: 'gV', [fv]: 'Vishwesh', hr_month: 7, hr_year: 2026, hr_basic: 12000, hr_gross: 12000, hr_netpay: 12000, hr_deductions: 0, hr_professionaltax: 0 },
];
const EMPLOYEES = [
  { hr_hremployeeid: 'gU', hr_employeeid: 'EMP1', hr_hremployee1: 'Uttej' },
  { hr_hremployeeid: 'gV', hr_employeeid: 'EMP2', hr_hremployee1: 'Vishwesh' },
];

function stub() {
  const orig = { getList: d365.getList, getCompany: companySvc.getCompany };
  companySvc.getCompany = async () => ({ hr_name: 'C' });
  d365.getList = async (entity) => {
    if (entity === E.payroll) return { data: ROWS, count: ROWS.length };
    if (entity === E.employee) return { data: EMPLOYEES, count: EMPLOYEES.length };
    return { data: [], count: 0 };
  };
  return () => { d365.getList = orig.getList; companySvc.getCompany = orig.getCompany; };
}

// payroll-register columns: 1 eid, 2 emp, 3 month, 4 year, 5 basic, 6 allow, 7 ot, 8 gross, 9 ded, 10 net, 11 status
test('payroll-register: Deductions = Gross − Net (PT included), Net = Gross − Deductions', async () => {
  const restore = stub();
  try {
    const ws = (await reports.buildReport('payroll-register', { year: 2026, month: 7 })).getWorksheet('Payroll Register');
    const uttej = ws.getRow(2), vish = ws.getRow(3);

    // Uttej: ₹200 PT was deducted → Deductions must be 200, NOT the hr_deductions 0.
    assert.strictEqual(uttej.getCell(8).value, 35000, 'gross');
    assert.strictEqual(uttej.getCell(9).value, 200, 'Deductions = Gross − Net (not hr_deductions=0)');
    assert.strictEqual(uttej.getCell(10).value, 34800, 'net');
    assert.strictEqual(uttej.getCell(8).value - uttej.getCell(9).value, uttej.getCell(10).value, 'Net = Gross − Deductions');

    // Vishwesh: genuinely no deductions → 0 is correct.
    assert.strictEqual(vish.getCell(9).value, 0, 'no deductions → 0 is correct');
    assert.strictEqual(vish.getCell(8).value - vish.getCell(9).value, vish.getCell(10).value, 'Net = Gross − Deductions');
  } finally { restore(); }
});

// payslip-register columns: 1 eid, 2 emp, 3 month, 4 year, 5 gross, 6 ded, 7 net, 8 status
test('payslip-register: Deductions = Gross − Net', async () => {
  const restore = stub();
  try {
    const ws = (await reports.buildReport('payslip-register', { year: 2026, month: 7 })).getWorksheet('Payslip Register');
    const uttej = ws.getRow(2);
    assert.strictEqual(uttej.getCell(6).value, 200, 'Deductions total');
    assert.strictEqual(uttej.getCell(5).value - uttej.getCell(6).value, uttej.getCell(7).value, 'Net = Gross − Deductions');
  } finally { restore(); }
});

// attendance-register Total Deduction column (11) must also be Gross − Net.
test('attendance-register: Total Deduction = Gross − Net', async () => {
  const restore = stub();
  try {
    const ws = (await reports.buildReport('attendance-register', { year: 2026, month: 7 })).getWorksheet('Attendance Register');
    assert.strictEqual(ws.getRow(2).getCell(11).value, 200, 'total deduction for Uttej');
  } finally { restore(); }
});
