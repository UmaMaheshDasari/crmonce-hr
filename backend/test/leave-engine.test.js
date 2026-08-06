/**
 * Leave Engine — pure balance + paid-vs-LOP split logic (no network).
 */
process.env.NODE_ENV = 'test';
process.env.AZURE_CLIENT_ID = process.env.AZURE_CLIENT_ID || 'test-client';
process.env.AZURE_CLIENT_SECRET = process.env.AZURE_CLIENT_SECRET || 'test-secret';
process.env.AZURE_TENANT_ID = process.env.AZURE_TENANT_ID || 'test-tenant';

const { test } = require('node:test');
const assert = require('node:assert');
const eng = require('../src/services/leave-engine.service');

const POLICY = { paidPerYear: 18, casual: 12, sick: 6 };
const leave = (category, days, month, date) => ({ category, days, month, date });

test('computeBalance: default entitlements 12 CL / 6 SL / 18 paid, none used', () => {
  const b = eng.computeBalance({ leaves: [], ledger: [], policy: POLICY });
  assert.strictEqual(b.casual.entitled, 12);
  assert.strictEqual(b.sick.entitled, 6);
  assert.strictEqual(b.paid.entitled, 18);
  assert.strictEqual(b.paid.remaining, 18);
  assert.strictEqual(b.lop.fromLeave, 0);
});

test('computeBalance: approved leave reduces the right buckets', () => {
  const b = eng.computeBalance({
    leaves: [leave('casual', 3, 1, '2026-01-05'), leave('sick', 2, 2, '2026-02-10')],
    ledger: [], policy: POLICY,
  });
  assert.strictEqual(b.casual.used, 3);
  assert.strictEqual(b.casual.remaining, 9);
  assert.strictEqual(b.sick.used, 2);
  assert.strictEqual(b.sick.remaining, 4);
  assert.strictEqual(b.paid.remaining, 13);
});

test('computeBalance: leave beyond entitlement is reported as LOP', () => {
  const b = eng.computeBalance({
    leaves: [leave('casual', 14, 1, '2026-01-05')],   // 2 over the 12 casual cap
    ledger: [], policy: POLICY,
  });
  assert.strictEqual(b.casual.remaining, 0);
  assert.strictEqual(b.lop.fromLeave, 2);
});

test('computeBalance: comp-off earned/used and manual adjustment', () => {
  const b = eng.computeBalance({
    leaves: [],
    ledger: [
      { kind: 'comp_off_earned', category: 'compoff', days: 2 },
      { kind: 'comp_off_used', category: 'compoff', days: 1 },
      { kind: 'adjustment', category: 'casual', days: 3 },   // carry-forward
    ],
    policy: POLICY,
  });
  assert.strictEqual(b.compOff.earned, 2);
  assert.strictEqual(b.compOff.used, 1);
  assert.strictEqual(b.compOff.balance, 1);
  assert.strictEqual(b.casual.entitled, 15);   // 12 + 3 adjustment
  assert.strictEqual(b.paid.entitled, 21);
});

test('computeBalance: explicit LOP-type leave counts as LOP, not paid', () => {
  const b = eng.computeBalance({ leaves: [leave('lop', 2, 3, '2026-03-01')], ledger: [], policy: POLICY });
  assert.strictEqual(b.lop.fromLeave, 2);
  assert.strictEqual(b.paid.used, 0);
});

test('computeMonthSplit: within cap → all paid, no LOP', () => {
  const s = eng.computeMonthSplit({
    leaves: [leave('casual', 2, 3, '2026-03-04'), leave('sick', 1, 3, '2026-03-20')],
    policy: POLICY, adjustments: {}, month: 3,
  });
  assert.strictEqual(s.paidLeaveDays, 3);
  assert.strictEqual(s.lopLeaveDays, 0);
});

test('computeMonthSplit: prior months consume the cap → this month spills to LOP', () => {
  // 18 paid already used across Jan–Feb; March takes 4 more → all 4 are LOP.
  const s = eng.computeMonthSplit({
    leaves: [
      leave('casual', 12, 1, '2026-01-03'),
      leave('sick', 6, 2, '2026-02-03'),
      leave('casual', 4, 3, '2026-03-03'),
    ],
    policy: POLICY, adjustments: {}, month: 3,
  });
  assert.strictEqual(s.paidLeaveDays, 0);
  assert.strictEqual(s.lopLeaveDays, 4);
});

test('computeMonthSplit: partial spill — month straddles the cap boundary', () => {
  // Jan uses 16 paid; Feb takes 4 → 2 paid (to reach 18) + 2 LOP.
  const s = eng.computeMonthSplit({
    leaves: [leave('casual', 12, 1, '2026-01-03'), leave('sick', 4, 1, '2026-01-15'), leave('casual', 4, 2, '2026-02-03')],
    policy: POLICY, adjustments: {}, month: 2,
  });
  assert.strictEqual(s.paidLeaveDays, 2);
  assert.strictEqual(s.lopLeaveDays, 2);
});

test('computeMonthSplit: adjustments raise the cap', () => {
  const s = eng.computeMonthSplit({
    leaves: [leave('casual', 12, 1, '2026-01-03'), leave('sick', 6, 1, '2026-01-15'), leave('casual', 2, 2, '2026-02-03')],
    policy: POLICY, adjustments: { casual: 2 }, month: 2,   // cap now 20
  });
  assert.strictEqual(s.paidLeaveDays, 2);
  assert.strictEqual(s.lopLeaveDays, 0);
});

test('computeMonthSplit: earned/other leave is fully paid, not vs the 18', () => {
  const s = eng.computeMonthSplit({
    leaves: [leave('casual', 18, 1, '2026-01-03'), leave('other', 5, 2, '2026-02-03')],
    policy: POLICY, adjustments: {}, month: 2,
  });
  assert.strictEqual(s.paidLeaveDays, 5);   // earned leave paid
  assert.strictEqual(s.lopLeaveDays, 0);
});

test('computeMonthSplit: half-day support', () => {
  const s = eng.computeMonthSplit({ leaves: [leave('casual', 0.5, 4, '2026-04-10')], policy: POLICY, adjustments: {}, month: 4 });
  assert.strictEqual(s.paidLeaveDays, 0.5);
  assert.strictEqual(s.lopLeaveDays, 0);
});

test('categoryOfType maps leave-type labels', () => {
  assert.strictEqual(eng.categoryOfType('Casual Leave'), 'casual');
  assert.strictEqual(eng.categoryOfType('Sick Leave'), 'sick');
  assert.strictEqual(eng.categoryOfType('LOP'), 'lop');
  assert.strictEqual(eng.categoryOfType('Earned Leave'), 'other');
});
