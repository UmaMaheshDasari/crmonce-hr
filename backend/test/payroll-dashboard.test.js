/**
 * Payroll Dashboard aggregation — pure (no network).
 */
const { test } = require('node:test');
const assert = require('node:assert');
const { aggregate, stateOf } = require('../src/services/payroll-dashboard.service');

const employees = [
  { id: 'e1', department: 'IT' }, { id: 'e2', department: 'IT' }, { id: 'e3', department: 'Sales' },
];
// Aug (8) payroll for all three; e1 also has a Jul (7) row.
const rows = [
  { month: 8, gross: 60000, net: 52000, lop: 0, advance: 5000, status: 'processed', locked: false, employeeId: 'e1' },
  { month: 8, gross: 40000, net: 36000, lop: 2000, advance: 0, status: 'draft', locked: false, employeeId: 'e2' },
  { month: 8, gross: 50000, net: 47000, lop: 0, advance: 0, status: 'paid', locked: true, employeeId: 'e3' },
  { month: 7, gross: 60000, net: 55000, lop: 0, advance: 0, status: 'paid', locked: false, employeeId: 'e1' },
];
const leaves = [
  { month: 8, days: 2, employeeId: 'e2' }, { month: 7, days: 1, employeeId: 'e1' },
];

test('stateOf: locked precedence, then paid/approved/draft', () => {
  assert.strictEqual(stateOf({ status: 'paid', locked: true }), 'locked');
  assert.strictEqual(stateOf({ status: 'paid', locked: false }), 'paid');
  assert.strictEqual(stateOf({ status: 'processed', locked: false }), 'approved');
  assert.strictEqual(stateOf({ status: 'draft', locked: false }), 'draft');
});

test('cards for a month reflect that month only', () => {
  const r = aggregate({ rows, employees, leaves, filters: { month: 8 } });
  assert.strictEqual(r.cards.totalEmployees, 3);
  assert.strictEqual(r.cards.processedPayroll, 2);   // e1 processed + e3 locked/paid
  assert.strictEqual(r.cards.pendingPayroll, 1);     // e2 draft
  assert.strictEqual(r.cards.totalGross, 150000);
  assert.strictEqual(r.cards.totalNet, 135000);
  assert.strictEqual(r.cards.totalDeductions, 15000); // 150000 - 135000
});

test('status pipeline counts each row once (locked precedence)', () => {
  const r = aggregate({ rows, employees, leaves, filters: { month: 8 } });
  assert.deepStrictEqual(r.statusPipeline, { draft: 1, processing: 0, approved: 1, locked: 1, paid: 0 });
});

test('department salary groups by employee department (period)', () => {
  const r = aggregate({ rows, employees, leaves, filters: { month: 8 } });
  const it = r.departmentSalary.find(d => d.department === 'IT');
  const sales = r.departmentSalary.find(d => d.department === 'Sales');
  assert.strictEqual(it.gross, 100000);   // e1 60k + e2 40k
  assert.strictEqual(it.net, 88000);
  assert.strictEqual(sales.net, 47000);
  assert.strictEqual(r.departmentSalary[0].department, 'IT');  // sorted by net desc
});

test('monthly trend spans 12 months regardless of month filter', () => {
  const r = aggregate({ rows, employees, leaves, filters: { month: 8 } });
  assert.strictEqual(r.monthly.length, 12);
  assert.strictEqual(r.monthly[7].gross, 150000);   // Aug
  assert.strictEqual(r.monthly[6].gross, 60000);    // Jul (e1)
  assert.strictEqual(r.monthly[7].lop, 2000);       // Aug LOP
  assert.strictEqual(r.monthly[7].advance, 5000);   // Aug advance
  assert.strictEqual(r.monthly[7].leave, 2);        // Aug leave days
  assert.strictEqual(r.monthly[6].leave, 1);        // Jul leave days
});

test('department filter scopes cards, trends and status', () => {
  const r = aggregate({ rows, employees, leaves, filters: { department: 'Sales' } });
  assert.strictEqual(r.cards.totalEmployees, 1);
  assert.strictEqual(r.departmentSalary.length, 1);
  assert.strictEqual(r.monthly[7].net, 47000);      // only e3 (Sales) in Aug
  assert.strictEqual(r.statusPipeline.locked, 1);
});

test('employee filter narrows to one person across the year', () => {
  const r = aggregate({ rows, employees, leaves, filters: { employeeId: 'e1' } });
  assert.strictEqual(r.monthly[7].gross, 60000);    // Aug e1
  assert.strictEqual(r.monthly[6].gross, 60000);    // Jul e1
  assert.strictEqual(r.departmentSalary.every(d => d.department === 'IT'), true);
});
