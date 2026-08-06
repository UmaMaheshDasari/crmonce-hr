/**
 * Opening balance folds into the leave engine: Current Used = Opening + in-system.
 * Pure computeBalance / computeMonthSplit — no network.
 */
process.env.NODE_ENV = 'test';
process.env.AZURE_CLIENT_ID = process.env.AZURE_CLIENT_ID || 'test-client';
process.env.AZURE_CLIENT_SECRET = process.env.AZURE_CLIENT_SECRET || 'test-secret';
process.env.AZURE_TENANT_ID = process.env.AZURE_TENANT_ID || 'test-tenant';
process.env.D365_BASE_URL = process.env.D365_BASE_URL || 'https://example.crm.dynamics.com';

const { test } = require('node:test');
const assert = require('node:assert');
const eng = require('../src/services/leave-engine.service');

const policy = { paidPerYear: 18, casual: 12, sick: 6 };

test('opening used reduces remaining (CL used 5 → remaining 7)', () => {
  const b = eng.computeBalance({ leaves: [], ledger: [], policy, opening: { casualUsed: 5, sickUsed: 2, lopUsed: 1, compOff: 2 } });
  assert.strictEqual(b.casual.used, 5);
  assert.strictEqual(b.casual.remaining, 7);
  assert.strictEqual(b.sick.used, 2);
  assert.strictEqual(b.sick.remaining, 4);
});

test('opening + in-system leaves add up (opening CL 5 + 2 taken = 7 used, 5 left)', () => {
  const leaves = [
    { category: 'casual', days: 2, month: 3, date: '2026-03-10' },
  ];
  const b = eng.computeBalance({ leaves, ledger: [], policy, opening: { casualUsed: 5 } });
  assert.strictEqual(b.casual.used, 7);
  assert.strictEqual(b.casual.remaining, 5);
});

test('opening comp-off seeds the comp-off balance', () => {
  const b = eng.computeBalance({ leaves: [], ledger: [], policy, opening: { compOff: 3 } });
  assert.strictEqual(b.compOff.earned, 3);
  assert.strictEqual(b.compOff.balance, 3);
});

test('opening LOP counts toward LOP-from-leave', () => {
  const b = eng.computeBalance({ leaves: [], ledger: [], policy, opening: { lopUsed: 4 } });
  assert.strictEqual(b.lop.fromLeave, 4);
});

test('no opening balance behaves exactly as before (backward compatible)', () => {
  const b = eng.computeBalance({ leaves: [{ category: 'casual', days: 3, month: 1, date: '2026-01-05' }], ledger: [], policy });
  assert.strictEqual(b.casual.used, 3);
  assert.strictEqual(b.casual.remaining, 9);
  assert.strictEqual(b.opening.casualUsed, 0);
});

test('month split pre-consumes the paid cap by opening used (drives LOP correctly)', () => {
  // Opening CL+SL used = 17 (of 18). A 3-day casual leave this month → 1 paid, 2 LOP.
  const leaves = [{ category: 'casual', days: 3, month: 5, date: '2026-05-10' }];
  const split = eng.computeMonthSplit({ leaves, policy, adjustments: {}, month: 5, opening: { casualUsed: 12, sickUsed: 5 } });
  assert.strictEqual(split.paidLeaveDays, 1);
  assert.strictEqual(split.lopLeaveDays, 2);
});

test('comp-off leave (category other) stays fully paid, never LOP', () => {
  const leaves = [{ category: 'other', days: 2, month: 6, date: '2026-06-10' }];
  const split = eng.computeMonthSplit({ leaves, policy, adjustments: {}, month: 6 });
  assert.strictEqual(split.paidLeaveDays, 2);
  assert.strictEqual(split.lopLeaveDays, 0);
});
