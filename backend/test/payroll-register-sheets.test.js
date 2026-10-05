/**
 * Payroll Register Excel export — one worksheet per unique Month+Year.
 *
 * The register must NOT mix months/years in one sheet. Each (Month, Year) present in the
 * data becomes its own sheet named "<Mon> <Year>" (e.g. "Aug 2026"), sheets ordered
 * chronologically (Year asc, then Month asc — never alphabetical), each containing ONLY its
 * own rows. Rows with a missing/invalid Month or Year go to a clearly-named "Unassigned"
 * sheet (never silently merged). Columns, formatting and payroll values are unchanged.
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

function row(id, name, m, y, extra = {}) {
  return { hr_hrpayrollid: id, _hr_hremployee_value: 'g' + name, [fv]: name, hr_month: m, hr_year: y, hr_basic: 30000, hr_netpay: 48000, ...extra };
}
function stub(payrollRows) {
  const orig = { gl: d365.getList, gc: companySvc.getCompany };
  companySvc.getCompany = async () => ({ hr_name: 'C' });
  d365.getList = async (entity) => {
    if (entity === E.payroll) return { data: payrollRows, count: payrollRows.length };
    return { data: [], count: 0 };   // employees + salary structures not needed here
  };
  return () => { d365.getList = orig.gl; companySvc.getCompany = orig.gc; };
}
async function build(rows, opts = {}) {
  const restore = stub(rows);
  try { return await reports.buildReport('payroll-register', opts); } finally { restore(); }
}
const names = (wb) => wb.worksheets.map((w) => w.name);
const colOf = (ws, c) => { const o = []; ws.eachRow((r, n) => { if (n > 1) o.push(r.getCell(c).value); }); return o; };
const months = (ws) => colOf(ws, 3), years = (ws) => colOf(ws, 4), emps = (ws) => colOf(ws, 2);

test('1 — one month → one worksheet named "<Mon> <Year>"', async () => {
  assert.deepEqual(names(await build([row('a', 'Alice', 8, 2026)])), ['Aug 2026']);
});

test('2 — two months, same year → two worksheets, chronological', async () => {
  const wb = await build([row('a', 'Alice', 9, 2026), row('b', 'Bob', 8, 2026)]);
  assert.deepEqual(names(wb), ['Aug 2026', 'Sep 2026']);   // Aug before Sep, not alphabetical
});

test('3 — same month across two years → two worksheets (years never combined)', async () => {
  const wb = await build([row('a', 'A', 8, 2026), row('b', 'B', 8, 2025)]);
  assert.deepEqual(names(wb), ['Aug 2025', 'Aug 2026']);
});

test('4/8 — Aug2026, Sep2026, Oct2026, Aug2025 → separate sheets, chronological order', async () => {
  const wb = await build([row('a', 'A', 8, 2026), row('b', 'B', 9, 2026), row('c', 'C', 10, 2026), row('d', 'D', 8, 2025)]);
  assert.deepEqual(names(wb), ['Aug 2025', 'Aug 2026', 'Sep 2026', 'Oct 2026']);
});

test('5 — no duplicate worksheet names', async () => {
  const n = names(await build([row('a', 'A', 8, 2026), row('b', 'B', 8, 2026), row('c', 'C', 9, 2026)]));
  assert.equal(new Set(n).size, n.length);
  assert.deepEqual(n, ['Aug 2026', 'Sep 2026']);
});

test('6/7 — each sheet contains ONLY its own month/year rows', async () => {
  const wb = await build([row('a', 'A', 8, 2026), row('b', 'B', 8, 2026), row('c', 'C', 9, 2026)]);
  const aug = wb.getWorksheet('Aug 2026'), sep = wb.getWorksheet('Sep 2026');
  assert.deepEqual([...new Set(months(aug))], ['Aug']);
  assert.deepEqual([...new Set(years(aug))], [2026]);
  assert.equal(months(aug).length, 2);
  assert.deepEqual([...new Set(months(sep))], ['Sep']);
  assert.equal(months(sep).length, 1);
});

test('5b — same employee in two months appears in BOTH month sheets', async () => {
  const wb = await build([row('a', 'Vishwesh', 8, 2026), row('b', 'Vishwesh', 9, 2026)]);
  assert.deepEqual(names(wb), ['Aug 2026', 'Sep 2026']);
  assert.deepEqual(emps(wb.getWorksheet('Aug 2026')), ['Vishwesh']);
  assert.deepEqual(emps(wb.getWorksheet('Sep 2026')), ['Vishwesh']);
});

test('9 — existing payroll columns are unchanged', async () => {
  const hdr = (await build([row('a', 'A', 8, 2026)])).getWorksheet('Aug 2026').getRow(1).values.slice(1);
  assert.deepEqual(hdr, ['Employee ID', 'Employee', 'Month', 'Year', 'Basic', 'Allowances', 'Overtime', 'Gross', 'Deductions', 'Net Pay', 'Status']);
});

test('10 — rows with missing/invalid Month or Year → "Unassigned" (never merged into a month)', async () => {
  const wb = await build([row('a', 'A', 8, 2026), row('b', 'B', null, 2026), row('c', 'C', 13, 2026), row('d', 'D', 8, null)]);
  assert.deepEqual(names(wb), ['Aug 2026', 'Unassigned']);
  assert.equal(months(wb.getWorksheet('Aug 2026')).length, 1, 'only the one valid Aug row');
  assert.equal(months(wb.getWorksheet('Unassigned')).length, 3, 'the three invalid rows');
});

test('11 — header formatting + freeze pane preserved on EVERY month sheet', async () => {
  const wb = await build([row('a', 'A', 8, 2026), row('b', 'B', 9, 2026)]);
  for (const nm of ['Aug 2026', 'Sep 2026']) {
    const ws = wb.getWorksheet(nm);
    assert.equal(ws.getRow(1).font.bold, true, `${nm} header bold`);
    assert.equal(ws.getCell('A1').fill.fgColor.argb, 'FFD9E8FB', `${nm} header fill`);
    assert.equal(ws.views[0].state, 'frozen', `${nm} freeze pane`);
  }
});

test('12 — payroll VALUES are unchanged (Gross / Deductions=Gross−Net / Net)', async () => {
  const wb = await build([row('a', 'Alice', 8, 2026, { hr_gross: 42000, hr_netpay: 40000, hr_allowances: 5000, hr_overtime: 1000 })]);
  const r = wb.getWorksheet('Aug 2026').getRow(2);   // cols: …Gross(8) Deductions(9) Net(10)
  assert.equal(r.getCell(8).value, 42000, 'Gross = hr_gross');
  assert.equal(r.getCell(9).value, 2000, 'Deductions = Gross − Net');
  assert.equal(r.getCell(10).value, 40000, 'Net = hr_netpay');
});

test('edge — no records → single empty "Payroll Register" sheet (existing behaviour kept)', async () => {
  const wb = await build([]);
  assert.deepEqual(names(wb), ['Payroll Register']);
  assert.equal(wb.getWorksheet('Payroll Register').rowCount, 1, 'header row only');
});

test('sheet names are valid Excel names (≤ 31 chars, no forbidden chars)', async () => {
  const wb = await build([row('a', 'A', 1, 2027), row('b', 'B', 12, 2026)]);
  for (const nm of names(wb)) {
    assert.ok(nm.length <= 31, `${nm} ≤ 31`);
    assert.ok(!/[:\\/?*\[\]]/.test(nm), `${nm} has no forbidden chars`);
  }
  assert.deepEqual(names(wb), ['Dec 2026', 'Jan 2027']);   // Dec 2026 before Jan 2027 (chronological across year)
});

// ── Attendance Register + Bank Transfer use the SAME shared month/year split helper ──
async function buildType(type, rows, opts = {}) {
  const restore = stub(rows);
  try { return await reports.buildReport(type, opts); } finally { restore(); }
}

for (const type of ['attendance-register', 'bank-transfer']) {
  test(`${type} — one month → one sheet "<Mon> <Year>"; two months → chronological split`, async () => {
    assert.deepEqual(names(await buildType(type, [row('a', 'A', 8, 2026)])), ['Aug 2026']);
    assert.deepEqual(names(await buildType(type, [row('a', 'A', 9, 2026), row('b', 'B', 8, 2026)])), ['Aug 2026', 'Sep 2026']);
  });
  test(`${type} — Aug 2026 rows never appear in the Sep 2026 sheet (and vice-versa)`, async () => {
    const wb = await buildType(type, [row('a', 'A', 8, 2026), row('b', 'B', 8, 2026), row('c', 'C', 9, 2026)]);
    assert.deepEqual([...new Set(months(wb.getWorksheet('Aug 2026')))], ['Aug']);
    assert.equal(months(wb.getWorksheet('Aug 2026')).length, 2);
    assert.deepEqual([...new Set(months(wb.getWorksheet('Sep 2026')))], ['Sep']);
    assert.equal(months(wb.getWorksheet('Sep 2026')).length, 1);
  });
  test(`${type} — same month across two years → two sheets, chronological`, async () => {
    assert.deepEqual(names(await buildType(type, [row('a', 'A', 8, 2026), row('b', 'B', 8, 2025)])), ['Aug 2025', 'Aug 2026']);
  });
  test(`${type} — missing/invalid Month or Year → "Unassigned" (never merged)`, async () => {
    const wb = await buildType(type, [row('a', 'A', 8, 2026), row('b', 'B', null, 2026), row('c', 'C', 13, 2026)]);
    assert.deepEqual(names(wb), ['Aug 2026', 'Unassigned']);
    assert.equal(months(wb.getWorksheet('Unassigned')).length, 2);
  });
  test(`${type} — no records → single empty sheet keeps its original name`, async () => {
    const wb = await buildType(type, []);
    assert.deepEqual(names(wb), [type === 'attendance-register' ? 'Attendance Register' : 'Bank Transfer']);
  });
}

test('attendance-register columns are unchanged', async () => {
  const hdr = (await buildType('attendance-register', [row('a', 'A', 8, 2026)])).getWorksheet('Aug 2026').getRow(1).values.slice(1);
  assert.deepEqual(hdr, ['Employee ID', 'Employee', 'Month', 'Year', 'Present', 'Absent', 'Salary Working Days', 'Payable Days', 'Absent LOP (₹)', 'Hourly Shortage Deduction (₹)', 'Total Deduction (₹)']);
});

test('bank-transfer columns are unchanged', async () => {
  const hdr = (await buildType('bank-transfer', [row('a', 'A', 8, 2026)])).getWorksheet('Aug 2026').getRow(1).values.slice(1);
  assert.deepEqual(hdr, ['Employee ID', 'Employee', 'Month', 'Year', 'Account Holder', 'Bank', 'Account No', 'IFSC', 'Net Pay']);
});
