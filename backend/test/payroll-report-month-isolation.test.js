/**
 * Payroll Excel exports MUST be isolated to the selected month.
 *
 * The bug: fetchPayroll() filtered by hr_year only, and the payroll-register /
 * attendance-register builders emitted every row for the year — so an August export
 * contained July too. Fix: fetchPayroll(year, month) scopes hr_month at the QUERY, with an
 * in-memory guard. These tests feed a MIXED July+August dataset (the stub ignores the filter
 * on purpose) and prove the builder output contains ONLY the requested month, AND that the
 * month reaches the Dataverse query filter.
 *
 * No network — d365.getList and companySvc.getCompany are stubbed.
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

// A deliberately MIXED dataset: two July rows + two August rows, same year.
const PAYROLL_ROWS = [
  { hr_hrpayrollid: 'p1', _hr_hremployee_value: 'gA', [fv]: 'Alice', hr_month: 8, hr_year: 2026, hr_basic: 30000, hr_netpay: 50000, hr_presentdays: 22, hr_absentdays: 0, hr_workingdays: 22, hr_paydays: 22 },
  { hr_hrpayrollid: 'p2', _hr_hremployee_value: 'gB', [fv]: 'Bob',   hr_month: 8, hr_year: 2026, hr_basic: 20000, hr_netpay: 35000, hr_presentdays: 21, hr_absentdays: 1, hr_workingdays: 22, hr_paydays: 21 },
  { hr_hrpayrollid: 'p3', _hr_hremployee_value: 'gA', [fv]: 'Alice', hr_month: 7, hr_year: 2026, hr_basic: 30000, hr_netpay: 49000, hr_presentdays: 20, hr_absentdays: 2, hr_workingdays: 23, hr_paydays: 20 },
  { hr_hrpayrollid: 'p4', _hr_hremployee_value: 'gB', [fv]: 'Bob',   hr_month: 7, hr_year: 2026, hr_basic: 20000, hr_netpay: 34000, hr_presentdays: 22, hr_absentdays: 0, hr_workingdays: 23, hr_paydays: 22 },
];
const EMPLOYEES = [
  { hr_hremployeeid: 'gA', hr_employeeid: 'EMP1', hr_hremployee1: 'Alice' },
  { hr_hremployeeid: 'gB', hr_employeeid: 'EMP2', hr_hremployee1: 'Bob' },
];

// Returns { payrollFilter } captured from the PAYROLL query so we can assert month scoping.
function stub() {
  const orig = { getList: d365.getList, getCompany: companySvc.getCompany };
  const captured = { payrollFilter: undefined };
  companySvc.getCompany = async () => ({ hr_name: 'C' });
  d365.getList = async (entity, opts = {}) => {
    if (entity === E.payroll) { captured.payrollFilter = opts.filter; return { data: PAYROLL_ROWS, count: PAYROLL_ROWS.length }; }
    if (entity === E.employee) return { data: EMPLOYEES, count: EMPLOYEES.length };
    if (entity === E.salaryStructure) return { data: [], count: 0 };
    return { data: [], count: 0 };
  };
  const restore = () => { d365.getList = orig.getList; companySvc.getCompany = orig.getCompany; };
  return { captured, restore };
}

// Read the 'Month' column (Aug/Jul labels) of every data row of a report worksheet.
async function monthsInReport(type, opts, sheetName) {
  const { captured, restore } = stub();
  try {
    const wb = await reports.buildReport(type, opts);
    const ws = wb.getWorksheet(sheetName);
    const months = [];
    ws.eachRow((row, n) => { if (n > 1) months.push(row.getCell(3).value); });   // col 3 = Month
    return { months, filter: captured.payrollFilter };
  } finally { restore(); }
}

test('payroll-register August 2026 → ONLY August rows (never July)', async () => {
  const { months, filter } = await monthsInReport('payroll-register', { year: 2026, month: 8 }, 'Payroll Register');
  assert.deepEqual([...new Set(months)], ['Aug'], 'every row is August');
  assert.equal(months.length, 2, 'exactly the two August rows');
  assert.ok(!months.includes('Jul'), 'July must never appear in an August export');
  assert.match(filter, /hr_month eq 8/, 'month reached the Dataverse query');
  assert.match(filter, /hr_year eq 2026/, 'year reached the Dataverse query');
});

test('payroll-register July 2026 → ONLY July rows (never August)', async () => {
  const { months, filter } = await monthsInReport('payroll-register', { year: 2026, month: 7 }, 'Payroll Register');
  assert.deepEqual([...new Set(months)], ['Jul'], 'every row is July');
  assert.equal(months.length, 2);
  assert.ok(!months.includes('Aug'), 'August must never appear in a July export');
  assert.match(filter, /hr_month eq 7/);
});

test('attendance-register August 2026 → ONLY August rows', async () => {
  const { months, filter } = await monthsInReport('attendance-register', { year: 2026, month: 8 }, 'Attendance Register');
  assert.deepEqual([...new Set(months)], ['Aug']);
  assert.match(filter, /hr_month eq 8/);
});

test('bank-transfer + payslip-register are also month-isolated', async () => {
  const bt = await monthsInReport('bank-transfer', { year: 2026, month: 7 }, 'Bank Transfer');
  assert.deepEqual([...new Set(bt.months)], ['Jul']);
  const ps = await monthsInReport('payslip-register', { year: 2026, month: 8 }, 'Payslip Register');
  assert.deepEqual([...new Set(ps.months)], ['Aug']);
});

test('no month selected → year-wide (existing behaviour, both months present)', async () => {
  const { months, filter } = await monthsInReport('payroll-register', { year: 2026 }, 'Payroll Register');
  assert.equal(months.length, 4, 'all four rows for the year');
  assert.deepEqual([...new Set(months)].sort(), ['Aug', 'Jul']);
  assert.match(filter, /hr_year eq 2026/);
  assert.ok(!/hr_month/.test(filter), 'no month clause when none selected');
});
