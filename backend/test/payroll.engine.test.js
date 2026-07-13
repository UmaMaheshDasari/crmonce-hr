const { test } = require('node:test');
const assert = require('node:assert');
const policy = require('../src/services/company.policy');
const pe = require('../src/services/payroll.engine');

const setPolicy = (over) => policy.setProvider({ load: () => over });

test('monthly leave: first paid, rest LOP (derived, no counter)', () => {
  setPolicy({ monthlyPaidLeave: 1 });
  const c = pe.classifyMonthlyLeaves([
    { id: 'a', from: '2026-07-03', days: 1 },
    { id: 'b', from: '2026-07-10', days: 2 },
    { id: 'c', from: '2026-07-20', days: 1 },
  ]);
  assert.strictEqual(c.paidLeaves, 1);
  assert.strictEqual(c.lopLeaves, 2);
  assert.strictEqual(c.paidDays, 1);
  assert.strictEqual(c.lopDays, 3);
  assert.deepStrictEqual(c.items.map(x => x.kind), ['paid', 'lop', 'lop']);
});

test('ordered by date regardless of input order', () => {
  setPolicy({ monthlyPaidLeave: 1 });
  const c = pe.classifyMonthlyLeaves([
    { id: 'late', from: '2026-07-20', days: 1 },
    { id: 'early', from: '2026-07-02', days: 1 },
  ]);
  assert.strictEqual(c.items[0].id, 'early');
  assert.strictEqual(c.items[0].kind, 'paid');
});

test('configurable paid budget (2/month)', () => {
  setPolicy({ monthlyPaidLeave: 2 });
  const c = pe.classifyMonthlyLeaves([
    { id: 'a', from: '2026-07-01', days: 1 },
    { id: 'b', from: '2026-07-05', days: 1 },
    { id: 'c', from: '2026-07-09', days: 1 },
  ]);
  assert.strictEqual(c.paidLeaves, 2);
  assert.strictEqual(c.lopLeaves, 1);
});

test('monthly summary auto-resets (empty month = full budget remaining)', () => {
  setPolicy({ monthlyPaidLeave: 1 });
  const used = pe.monthlyLeaveSummary([{ id: 'a', from: '2026-07-03', days: 1 }]);
  assert.strictEqual(used.paidLeaveUsed, 1);
  assert.strictEqual(used.paidLeaveRemaining, 0);
  const fresh = pe.monthlyLeaveSummary([]);
  assert.strictEqual(fresh.paidLeaveRemaining, 1);
});

test('compensation: late but met required → compensated, no deduction', () => {
  setPolicy({ compensationEnabled: true });
  const r = pe.resolveCompensation({ lateArrivalMin: 30, earlyDepartureMin: 0, metRequiredHours: true });
  assert.strictEqual(r.status, 'compensated');
  assert.strictEqual(r.deductLate, false);
});

test('compensation: on time → on_time', () => {
  setPolicy({});
  const r = pe.resolveCompensation({ lateArrivalMin: 0, metRequiredHours: true });
  assert.strictEqual(r.status, 'on_time');
});

test('compensation disabled + late deduction on → shortfall + deduct', () => {
  setPolicy({ compensationEnabled: false, lateDeductionEnabled: true });
  const r = pe.resolveCompensation({ lateArrivalMin: 30, metRequiredHours: true });
  assert.strictEqual(r.status, 'shortfall');
  assert.strictEqual(r.deductLate, true);
});

test('late but short + late deduction OFF (default) → no salary deduction', () => {
  setPolicy({ compensationEnabled: true, lateDeductionEnabled: false });
  const r = pe.resolveCompensation({ lateArrivalMin: 30, metRequiredHours: false });
  assert.strictEqual(r.status, 'shortfall');
  assert.strictEqual(r.deductLate, false);
});

test('lunch/break deduction OFF by default (informational)', () => {
  setPolicy({});
  assert.strictEqual(pe.lunchDeductionApplies(), false);
});
