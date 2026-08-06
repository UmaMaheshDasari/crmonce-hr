/**
 * Import/Export framework — pure parse/validate/dedupe (no network).
 */
const { test } = require('node:test');
const assert = require('node:assert');
const ExcelJS = require('exceljs');
const ie = require('../src/services/import-export.service');

async function xlsx(headers, rows) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Sheet1');
  ws.addRow(headers);
  for (const r of rows) ws.addRow(r);
  return wb.xlsx.writeBuffer();
}

test('typeList exposes all requested import types', () => {
  const ids = ie.typeList().map(t => t.id);
  for (const t of ['employees', 'salarystructure', 'attendance', 'leavebalance', 'compoff', 'holidays', 'payroll']) assert.ok(ids.includes(t), `${t} present`);
});

test('parseWorkbook maps headers to keys case-insensitively', async () => {
  const buf = await xlsx(['DATE', 'Holiday Name', 'Description'], [['2026-01-26', 'Republic Day', 'National']]);
  const rows = await ie.parseWorkbook(buf, 'holidays');
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].name, 'Republic Day');
  assert.strictEqual(rows[0].description, 'National');
});

test('validateRows flags missing required fields', () => {
  const v = ie.validateRows('holidays', [{ __row: 2, date: '2026-01-26' }]);   // no name
  assert.strictEqual(v.rows[0].status, 'error');
  assert.ok(v.rows[0].errors.some(e => /Holiday Name is required/.test(e)));
  assert.strictEqual(v.summary.errors, 1);
});

test('validateRows validates number, date and enum', () => {
  const v = ie.validateRows('payroll', [{ __row: 2, employeeCode: 'EMP1', month: 'abc', year: 2026, status: 'weird' }]);
  const errs = v.rows[0].errors.join(' | ');
  assert.match(errs, /Month must be a number/);
  assert.match(errs, /Status must be one of/);
});

test('validateRows: date coercion accepts DD/MM/YYYY and Excel dates', () => {
  const v = ie.validateRows('holidays', [{ __row: 2, date: '26/01/2026', name: 'RD' }]);
  assert.strictEqual(v.rows[0].data.date, '2026-01-26');
  assert.strictEqual(v.rows[0].status, 'valid');
});

test('validateRows: in-file duplicate is flagged (by natural key)', () => {
  const v = ie.validateRows('holidays', [
    { __row: 2, date: '2026-01-26', name: 'Republic Day' },
    { __row: 3, date: '2026-01-26', name: 'Republic Day (dup)' },
  ]);
  assert.strictEqual(v.rows[0].status, 'valid');
  assert.strictEqual(v.rows[1].status, 'duplicate');
  assert.strictEqual(v.summary.duplicates, 1);
});

test('applyExistingKeys: skip policy marks existing rows as duplicate', () => {
  const v = ie.validateRows('holidays', [{ __row: 2, date: '2026-01-26', name: 'RD' }]);
  ie.applyExistingKeys('holidays', v, new Set(['2026-01-26']));
  assert.strictEqual(v.rows[0].status, 'duplicate');
  assert.strictEqual(v.summary.valid, 0);
});

test('applyExistingKeys: update policy marks existing rows as update', () => {
  const v = ie.validateRows('employees', [{ __row: 2, employeeId: 'EMP1039', name: 'Jaya' }]);
  ie.applyExistingKeys('employees', v, new Set(['emp1039']));
  assert.strictEqual(v.rows[0].status, 'update');
  assert.strictEqual(v.summary.updates, 1);
});

test('salary structure: bool + number coercion and dedupe key', () => {
  const v = ie.validateRows('salarystructure', [{ __row: 2, employeeCode: 'EMP1', effectiveFrom: '2026-04-01', basic: '40000', pfApplicable: 'Yes' }]);
  assert.strictEqual(v.rows[0].data.basic, 40000);
  assert.strictEqual(v.rows[0].data.pfApplicable, true);
  assert.strictEqual(v.rows[0].key, 'emp1|2026-04-01');
  assert.strictEqual(v.rows[0].status, 'valid');
});

test('leave balance: category enum enforced', () => {
  const ok = ie.validateRows('leavebalance', [{ __row: 2, employeeCode: 'E1', category: 'casual', days: 2 }]);
  assert.strictEqual(ok.rows[0].status, 'valid');
  const bad = ie.validateRows('leavebalance', [{ __row: 2, employeeCode: 'E1', category: 'annual', days: 2 }]);
  assert.strictEqual(bad.rows[0].status, 'error');
});
