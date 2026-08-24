/**
 * Phase 3 — Month-end shortage → LOP + carry-forward.
 *
 *   shortage < 5h        → 0 LOP,   carry the exact shortage forward
 *   5h <= shortage < 7h  → 0.5 LOP, carry 0
 *   shortage >= 7h       → 1 LOP,   carry 0
 * Surplus/exactly-recovered → 0 LOP, carry forward. LOP is in DAYS (payroll's unit).
 * Attendance produces lopDays; payroll owns the salary deduction (not modified here).
 */
process.env.NODE_ENV = 'test';
process.env.AZURE_CLIENT_ID = process.env.AZURE_CLIENT_ID || 'x';
process.env.AZURE_CLIENT_SECRET = process.env.AZURE_CLIENT_SECRET || 'x';
process.env.AZURE_TENANT_ID = process.env.AZURE_TENANT_ID || 'x';

const { test } = require('node:test');
const assert = require('node:assert');
const { resolveMonthEnd, rollupMonthlyBalance } = require('../src/services/monthly-balance.service');

// Convenience: month-end from a signed final balance.
const R = (bal) => resolveMonthEnd(bal);

// ── LOP tiers (spec examples) ─────────────────────────────────────────
test('1. 4h shortage → 0 LOP, carry 4h', () => {
  const r = R(-4);
  assert.equal(r.lopDays, 0);
  assert.equal(r.finalShortage, 4);
  assert.equal(r.carryForward, -4);   // signed: a 4h shortage carried forward
});

test('4h 30m shortage → 0 LOP, carry 4.5h', () => {
  const r = R(-4.5);
  assert.equal(r.lopDays, 0);
  assert.equal(r.carryForward, -4.5);
});

test('2. 5h shortage → 0.5 LOP, carry 0', () => {
  const r = R(-5);
  assert.equal(r.lopDays, 0.5);
  assert.equal(r.carryForward, 0);
});

test('3. 6h shortage → 0.5 LOP, carry 0', () => {
  assert.equal(R(-6).lopDays, 0.5);
  assert.equal(R(-6).carryForward, 0);
});

test('6h 59m shortage → 0.5 LOP', () => {
  assert.equal(R(-6.98).lopDays, 0.5);
});

test('4. 7h shortage → 1 LOP, carry 0', () => {
  const r = R(-7);
  assert.equal(r.lopDays, 1);
  assert.equal(r.carryForward, 0);
});

test('5. 8h shortage → 1 LOP', () => {
  assert.equal(R(-8).lopDays, 1);
  assert.equal(R(-8).carryForward, 0);
});

test('surplus (or exactly recovered) → 0 LOP, carries forward', () => {
  assert.deepEqual(R(0), { finalBalance: 0, finalShortage: 0, lopDays: 0, carryForward: 0 });
  assert.deepEqual(R(2), { finalBalance: 2, finalShortage: 0, lopDays: 0, carryForward: 2 });
});

// ── Carry-forward chain across months (via rollup + resolveMonthEnd) ──
test('6. previous 3h carry + current requirement, worked 182 of 180 → carry 1h', () => {
  // Jan: required 200, worked 197 → -3 → carry -3
  const jan = R(rollupMonthlyBalance([{ worked: 197, expected: 200 }]).currentBalance);
  assert.equal(jan.lopDays, 0);
  assert.equal(jan.carryForward, -3);
  // Feb: carry -3 in, required 180, worked 182 → -1 → carry -1
  const feb = R(rollupMonthlyBalance([{ worked: 182, expected: 180 }], { previousCarryForward: jan.carryForward }).currentBalance);
  assert.equal(feb.lopDays, 0);
  assert.equal(feb.finalShortage, 1);
  assert.equal(feb.carryForward, -1);
});

test('7. previous 3h carry + approved leave reduces ONLY current requirement', () => {
  // Current requirement 180, approved leave 9h → adjusted 171 (leave day expected 0).
  // Worked 174, prev carry -3 → 171 + 3 = 174 to cover → balance 0.
  const roll = rollupMonthlyBalance([
    { worked: 174, expected: 171 },
    { type: 'leave', worked: 0, expected: 0, leaveHours: 9 },
  ], { previousCarryForward: -3 });
  assert.equal(roll.approvedLeaveHours, 9);
  assert.equal(roll.requiredHours, 171);   // leave removed from CURRENT requirement only
  const me = R(roll.currentBalance);
  assert.equal(me.finalBalance, 0);
  assert.equal(me.lopDays, 0);
  assert.equal(me.carryForward, 0);
});

test('8. previous 3h carry + current 3h surplus → balance 0, LOP 0', () => {
  const roll = rollupMonthlyBalance([{ worked: 12, expected: 9 }], { previousCarryForward: -3 });   // +3 surplus
  const me = R(roll.currentBalance);
  assert.equal(me.finalBalance, 0);
  assert.equal(me.lopDays, 0);
  assert.equal(me.carryForward, 0);
});

test('9. overtime clears a shortage → no LOP', () => {
  // prev -3, a 14h day (expected 9) → +5 → +2 → no LOP, carry +2
  const roll = rollupMonthlyBalance([{ worked: 14, expected: 9, overtime: 5 }], { previousCarryForward: -3 });
  const me = R(roll.currentBalance);
  assert.equal(me.lopDays, 0);
  assert.equal(me.finalShortage, 0);
  assert.equal(me.carryForward, 2);
});

test('10. approved leave creates no shortage on its own', () => {
  const roll = rollupMonthlyBalance([{ type: 'leave', worked: 0, expected: 0, leaveHours: 9 }]);
  const me = R(roll.currentBalance);
  assert.equal(me.finalShortage, 0);
  assert.equal(me.lopDays, 0);
});

test('11. estimated LOP deduction reuses the EXISTING payroll per-day rate', async () => {
  const mbSvc = require('../src/services/monthly-balance.service');
  const salaryStructure = require('../src/services/salary-structure.service');
  const payrollSettings = require('../src/services/payroll-settings.service');
  const { perDaySalary } = require('../src/services/payroll-engine.calc');
  const { rangeCounts } = require('../src/services/attendance-summary.util');
  const orig = { gs: salaryStructure.getActiveStructure, ps: payrollSettings.getResolved };
  salaryStructure.getActiveStructure = async () => ({ gross: 26000 });
  payrollSettings.getResolved = async () => ({ lopBasis: 'salary_working_days' });
  try {
    const wd = rangeCounts('2020-01-01', '2020-01-31').working;
    const perDay = perDaySalary(26000, { lopBasis: 'salary_working_days', salaryWorkingDays: wd, calendarDays: 31 });
    const r2 = (n) => Math.round(n * 100) / 100;
    // 0 LOP → no deduction
    assert.equal(await mbSvc.estimateLopDeduction({ employeeId: 'e', year: 2020, month: 1, lopDays: 0 }), 0);
    // 0.5 LOP → existing HALF-day deduction (via perDaySalary)
    assert.equal(await mbSvc.estimateLopDeduction({ employeeId: 'e', year: 2020, month: 1, lopDays: 0.5 }), r2(perDay * 0.5));
    // 1 LOP → existing FULL-day deduction
    assert.equal(await mbSvc.estimateLopDeduction({ employeeId: 'e', year: 2020, month: 1, lopDays: 1 }), r2(perDay * 1));
  } finally { salaryStructure.getActiveStructure = orig.gs; payrollSettings.getResolved = orig.ps; }
});
