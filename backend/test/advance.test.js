/**
 * Advance Salary — pure recovery logic (installment + idempotent period apply).
 */
process.env.NODE_ENV = 'test';
process.env.AZURE_CLIENT_ID = process.env.AZURE_CLIENT_ID || 'test-client';
process.env.AZURE_CLIENT_SECRET = process.env.AZURE_CLIENT_SECRET || 'test-secret';
process.env.AZURE_TENANT_ID = process.env.AZURE_TENANT_ID || 'test-tenant';

const { test } = require('node:test');
const assert = require('node:assert');
const adv = require('../src/services/advance.service');

test('computeInstallment: EMI capped at remaining; 0 EMI → one-shot', () => {
  assert.strictEqual(adv.computeInstallment({ amount: 30000, emi: 10000, recovered: 0 }), 10000);
  assert.strictEqual(adv.computeInstallment({ amount: 30000, emi: 10000, recovered: 25000 }), 5000); // only 5000 left
  assert.strictEqual(adv.computeInstallment({ amount: 30000, emi: 0, recovered: 0 }), 30000);        // one-shot
  assert.strictEqual(adv.computeInstallment({ amount: 30000, emi: 10000, recovered: 30000 }), 0);    // done
});

test('applyPeriod: first EMI installment recorded', () => {
  const r = adv.applyPeriod({ amount: 30000, emi: 10000, status: 'approved', recoverFrom: '2026-09', recoverySchedule: '[]' }, '2026-09');
  assert.strictEqual(r.installment, 10000);
  assert.strictEqual(r.recovered, 10000);
  assert.strictEqual(r.status, 'approved');
  assert.strictEqual(r.changed, true);
  assert.deepStrictEqual(r.schedule, [{ period: '2026-09', amount: 10000 }]);
});

test('applyPeriod: idempotent — re-applying the same period does not double-recover', () => {
  const schedule = [{ period: '2026-09', amount: 10000 }];
  const r = adv.applyPeriod({ amount: 30000, emi: 10000, status: 'approved', recoverFrom: '2026-09', recoverySchedule: JSON.stringify(schedule) }, '2026-09');
  assert.strictEqual(r.installment, 10000);   // returns the existing installment
  assert.strictEqual(r.changed, false);       // no write
  assert.strictEqual(r.recovered, 10000);
});

test('applyPeriod: final installment is capped and marks completed', () => {
  const schedule = [{ period: '2026-09', amount: 10000 }, { period: '2026-10', amount: 10000 }];
  const r = adv.applyPeriod({ amount: 25000, emi: 10000, status: 'approved', recoverFrom: '2026-09', recoverySchedule: JSON.stringify(schedule) }, '2026-11');
  assert.strictEqual(r.installment, 5000);    // only 5000 left, not a full 10000
  assert.strictEqual(r.recovered, 25000);
  assert.strictEqual(r.status, 'completed');
  assert.strictEqual(r.changed, true);
});

test('applyPeriod: does not recover before RecoverFrom', () => {
  const r = adv.applyPeriod({ amount: 30000, emi: 10000, status: 'approved', recoverFrom: '2026-09', recoverySchedule: '[]' }, '2026-08');
  assert.strictEqual(r.installment, 0);
  assert.strictEqual(r.changed, false);
});

test('applyPeriod: does not recover for non-approved advances', () => {
  const r = adv.applyPeriod({ amount: 30000, emi: 10000, status: 'pending', recoverFrom: '2026-09', recoverySchedule: '[]' }, '2026-09');
  assert.strictEqual(r.installment, 0);
  assert.strictEqual(r.changed, false);
});

test('applyPeriod: one-shot advance (EMI 0) recovers full amount in one period, completed', () => {
  const r = adv.applyPeriod({ amount: 15000, emi: 0, status: 'approved', recoverFrom: '2026-09', recoverySchedule: '[]' }, '2026-09');
  assert.strictEqual(r.installment, 15000);
  assert.strictEqual(r.status, 'completed');
});

test('full lifecycle: three EMIs recover the advance exactly, idempotent throughout', () => {
  let state = { amount: 30000, emi: 10000, status: 'approved', recoverFrom: '2026-09', recoverySchedule: '[]' };
  const periods = ['2026-09', '2026-10', '2026-11'];
  let totalDeducted = 0;
  for (const p of periods) {
    const r = adv.applyPeriod(state, p);
    totalDeducted += r.installment;
    state = { ...state, recoverySchedule: JSON.stringify(r.schedule), status: r.status };
    // re-apply same period → no change
    const again = adv.applyPeriod(state, p);
    assert.strictEqual(again.changed, false);
    assert.strictEqual(again.installment, r.installment);
  }
  assert.strictEqual(totalDeducted, 30000);
  assert.strictEqual(state.status, 'completed');
  // A period after completion recovers nothing.
  const after = adv.applyPeriod(state, '2026-12');
  assert.strictEqual(after.installment, 0);
});

test('shape: derives remaining and percent', () => {
  const s = adv.shape({ hr_advancesalaryid: 'x', hr_amount: 30000, hr_recovered: 12000, hr_emi: 10000, hr_status: 'approved', hr_recoveryschedule: JSON.stringify([{ period: '2026-09', amount: 10000 }, { period: '2026-10', amount: 2000 }]) });
  assert.strictEqual(s.remaining, 18000);
  assert.strictEqual(s.percent, 40);
  assert.strictEqual(s.schedule.length, 2);
});
