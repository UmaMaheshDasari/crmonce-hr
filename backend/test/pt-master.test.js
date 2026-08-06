/**
 * Professional Tax Master — the pure slab resolver (state + gross + date).
 */
process.env.NODE_ENV = 'test';
process.env.AZURE_CLIENT_ID = process.env.AZURE_CLIENT_ID || 'test-client';
process.env.AZURE_CLIENT_SECRET = process.env.AZURE_CLIENT_SECRET || 'test-secret';
process.env.AZURE_TENANT_ID = process.env.AZURE_TENANT_ID || 'test-tenant';

const { test } = require('node:test');
const assert = require('node:assert');
const { resolveSlab } = require('../src/services/pt-master.service');

// Andhra Pradesh current slabs.
const AP = [
  { state: 'Andhra Pradesh', effectiveFrom: '2020-04-01', effectiveTo: '', salaryFrom: 0, salaryTo: 15000, amount: 0, status: 'active' },
  { state: 'Andhra Pradesh', effectiveFrom: '2020-04-01', effectiveTo: '', salaryFrom: 15001, salaryTo: 20000, amount: 150, status: 'active' },
  { state: 'Andhra Pradesh', effectiveFrom: '2020-04-01', effectiveTo: '', salaryFrom: 20001, salaryTo: 0, amount: 200, status: 'active' },
];

test('picks the right band by gross', () => {
  const d = '2026-08-01';
  assert.strictEqual(resolveSlab(AP, { state: 'Andhra Pradesh', gross: 12000, date: d }), 0);
  assert.strictEqual(resolveSlab(AP, { state: 'Andhra Pradesh', gross: 15000, date: d }), 0);
  assert.strictEqual(resolveSlab(AP, { state: 'Andhra Pradesh', gross: 15001, date: d }), 150);
  assert.strictEqual(resolveSlab(AP, { state: 'Andhra Pradesh', gross: 18000, date: d }), 150);
  assert.strictEqual(resolveSlab(AP, { state: 'Andhra Pradesh', gross: 20000, date: d }), 150);
  assert.strictEqual(resolveSlab(AP, { state: 'Andhra Pradesh', gross: 25000, date: d }), 200);   // salaryTo 0 = no upper bound
  assert.strictEqual(resolveSlab(AP, { state: 'Andhra Pradesh', gross: 45000, date: d }), 200);
});

test('state must match (case-insensitive); other states get no slab → null', () => {
  assert.strictEqual(resolveSlab(AP, { state: 'ANDHRA PRADESH', gross: 25000, date: '2026-08-01' }), 200);
  assert.strictEqual(resolveSlab(AP, { state: 'Karnataka', gross: 25000, date: '2026-08-01' }), null);
});

test('inactive slabs are ignored', () => {
  const slabs = [{ ...AP[2], status: 'inactive' }];
  assert.strictEqual(resolveSlab(slabs, { state: 'Andhra Pradesh', gross: 25000, date: '2026-08-01' }), null);
});

test('effective-dating: a date before the slab starts → no match', () => {
  assert.strictEqual(resolveSlab(AP, { state: 'Andhra Pradesh', gross: 25000, date: '2019-01-01' }), null);
});

test('historical vs future slabs: the slab effective on the payroll date wins', () => {
  const slabs = [
    { state: 'Andhra Pradesh', effectiveFrom: '2020-04-01', effectiveTo: '2026-03-31', salaryFrom: 20001, salaryTo: 0, amount: 200, status: 'active' },
    { state: 'Andhra Pradesh', effectiveFrom: '2026-04-01', effectiveTo: '', salaryFrom: 20001, salaryTo: 0, amount: 250, status: 'active' },   // new FY rate
  ];
  // A March 2026 payroll uses the OLD ₹200 slab (historical immutability).
  assert.strictEqual(resolveSlab(slabs, { state: 'Andhra Pradesh', gross: 30000, date: '2026-03-01' }), 200);
  // An April 2026 payroll uses the NEW ₹250 slab.
  assert.strictEqual(resolveSlab(slabs, { state: 'Andhra Pradesh', gross: 30000, date: '2026-04-01' }), 250);
});

test('a state-agnostic slab (blank state) applies to any state', () => {
  const slabs = [{ state: '', effectiveFrom: '2020-04-01', effectiveTo: '', salaryFrom: 0, salaryTo: 0, amount: 100, status: 'active' }];
  assert.strictEqual(resolveSlab(slabs, { state: 'Telangana', gross: 50000, date: '2026-08-01' }), 100);
});

test('no slabs → null (caller falls back to the built-in slab)', () => {
  assert.strictEqual(resolveSlab([], { state: 'Andhra Pradesh', gross: 25000, date: '2026-08-01' }), null);
});
