/**
 * Salary Register report MUST source Basic / Allowances / Deductions / Gross / Net
 * from the employee's active Salary Structure — NEVER from the Employee record's
 * hr_salary. An employee with no structure is flagged clearly (not a misleading ₹0).
 *
 * No network: d365.getList is stubbed per-entity and companySvc.getCompany is stubbed.
 */
process.env.NODE_ENV = 'test';
process.env.AZURE_CLIENT_ID = process.env.AZURE_CLIENT_ID || 'test-client';
process.env.AZURE_CLIENT_SECRET = process.env.AZURE_CLIENT_SECRET || 'test-secret';
process.env.AZURE_TENANT_ID = process.env.AZURE_TENANT_ID || 'test-tenant';

const { test } = require('node:test');
const assert = require('node:assert');
const reports = require('../src/services/payroll-reports.service');
const salaryStructure = require('../src/services/salary-structure.service');
const d365 = require('../src/services/d365.service');
const companySvc = require('../src/services/company.service');

const E = d365.constructor.entities;
const EMP_A = 'guid-alice', EMP_B = 'guid-bob';

// Alice's active structure (the ONLY authoritative pay source for her).
const aliceStructure = {
  hr_salarystructureid: 's1', hr_employeeid: EMP_A, hr_effectivefrom: '2026-01-01',
  hr_basic: 30000, hr_hra: 12000, hr_special: 3000, hr_medical: 1000, hr_conveyance: 1000,
  hr_pfapplicable: 'true', hr_pfamount: 1800, hr_incometax: 0, hr_otherdeductions: 0, hr_status: 'active',
};

// cols: 1 eid, 2 name, 3 dept, 4 desig, 5 basic, 6 allow, 7 ded, 8 gross, 9 net
async function runReport() {
  const employees = [
    // Alice HAS a structure; her employee-record hr_salary is a decoy that MUST be ignored.
    { hr_hremployeeid: EMP_A, hr_employeeid: 'EMP1', hr_hremployee1: 'Alice', hr_department: 'Eng', hr_designation: 'Dev', hr_salary: 99999, hr_allowances: 88888, hr_deductions: 77777 },
    // Bob has NO structure → must be flagged, not ₹0.
    { hr_hremployeeid: EMP_B, hr_employeeid: 'EMP2', hr_hremployee1: 'Bob', hr_department: 'Ops', hr_designation: 'Analyst', hr_salary: 55555 },
  ];
  const origGetList = d365.getList, origCompany = companySvc.getCompany;
  companySvc.getCompany = async () => ({ hr_name: 'C' });
  d365.getList = async (entity) => {
    if (entity === E.salaryStructure) return { data: [aliceStructure], count: 1 };
    return { data: employees, count: employees.length };   // employee entity
  };
  try {
    const wb = await reports.buildReport('salary-register', {});
    return wb.getWorksheet('Salary Register');
  } finally { d365.getList = origGetList; companySvc.getCompany = origCompany; }
}

test('Alice: every salary column comes from her Salary Structure, not her employee record', async () => {
  const ws = await runReport();
  const s = salaryStructure.shape(aliceStructure);
  const row = ws.getRow(2);   // row 1 = header
  assert.strictEqual(row.getCell(5).value, s.basic, 'Basic = structure basic');
  assert.strictEqual(row.getCell(6).value, s.hra + s.special + s.medical + s.conveyance + s.otherAllowance, 'Allowances = sum of structure allowances');
  assert.strictEqual(row.getCell(7).value, s.totalDeductions, 'Deductions = structure total deductions');
  assert.strictEqual(row.getCell(8).value, s.gross, 'Gross = structure gross');
  assert.strictEqual(row.getCell(9).value, s.netSalary, 'Net = structure net');
});

test('the Employee record hr_salary / hr_allowances / hr_deductions are NEVER used', async () => {
  const ws = await runReport();
  const row = ws.getRow(2);
  for (const col of [5, 6, 7, 8, 9]) {
    for (const decoy of [99999, 88888, 77777]) {
      assert.notStrictEqual(row.getCell(col).value, decoy, `col ${col} must not echo an employee-record value`);
    }
  }
});

test('Bob (no Salary Structure) is flagged clearly — no misleading ₹0', async () => {
  const ws = await runReport();
  const row = ws.getRow(3);
  assert.strictEqual(row.getCell(5).value, '—');       // Basic
  assert.strictEqual(row.getCell(9).value, 'No Salary Structure');
  assert.notStrictEqual(row.getCell(5).value, 0);       // NOT a silent zero
});
