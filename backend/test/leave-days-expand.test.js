/**
 * expandLeaveDays — the Attendance-page mapping of leave onto working dates.
 * Approved + Pending expand to every working date; rejected/cancelled are ignored;
 * multi-day spans cover each date; approved wins over pending; Comp Off keeps its type.
 */
process.env.NODE_ENV = 'test';
const { test } = require('node:test');
const assert = require('node:assert');
const { expandLeaveDays } = require('../src/services/attendance-summary.util');

// Deterministic calendar: weekly-offs = Sun+Sat, no holidays. Aug 2026:
//   Sat/Sun in Aug 2026 → 1,2,8,9,15,16,22,23,29,30. 10–14 Aug are Mon–Fri.
const OPTS = { weekOffDays: [0, 6], holidays: [] };
const EMP = 'g1';

test('multi-day approved CL covers every WORKING date (weekends excluded)', () => {
  const m = expandLeaveDays([{ employeeId: EMP, fromDate: '2026-08-10', toDate: '2026-08-14', type: 'Casual Leave', status: 'approved' }], '2026-08-01', '2026-08-31', OPTS);
  const dates = m.get(EMP);
  assert.deepStrictEqual([...dates.keys()].sort(), ['2026-08-10', '2026-08-11', '2026-08-12', '2026-08-13', '2026-08-14']);
  assert.deepStrictEqual(dates.get('2026-08-12'), { type: 'Casual Leave', status: 'approved' });
});

test('a leave spanning a weekend skips the weekend days', () => {
  const m = expandLeaveDays([{ employeeId: EMP, fromDate: '2026-08-07', toDate: '2026-08-11', type: 'Sick Leave', status: 'approved' }], '2026-08-01', '2026-08-31', OPTS);
  const keys = [...m.get(EMP).keys()].sort();
  assert.ok(!keys.includes('2026-08-08') && !keys.includes('2026-08-09'), 'Sat/Sun excluded');
  assert.deepStrictEqual(keys, ['2026-08-07', '2026-08-10', '2026-08-11']);
});

test('pending leave is included (held), rejected/cancelled are ignored', () => {
  const m = expandLeaveDays([
    { employeeId: EMP, fromDate: '2026-08-10', toDate: '2026-08-10', type: 'Casual Leave', status: 'pending' },
    { employeeId: EMP, fromDate: '2026-08-11', toDate: '2026-08-11', type: 'Casual Leave', status: 'rejected' },
    { employeeId: EMP, fromDate: '2026-08-12', toDate: '2026-08-12', type: 'Sick Leave', status: 'cancelled' },
  ], '2026-08-01', '2026-08-31', OPTS);
  const dates = m.get(EMP);
  assert.strictEqual(dates.get('2026-08-10').status, 'pending');
  assert.ok(!dates.has('2026-08-11'), 'rejected not mapped');
  assert.ok(!dates.has('2026-08-12'), 'cancelled not mapped');
});

test('Comp Off keeps its type label', () => {
  const m = expandLeaveDays([{ employeeId: EMP, fromDate: '2026-08-13', toDate: '2026-08-13', type: 'Comp Off', status: 'approved' }], '2026-08-01', '2026-08-31', OPTS);
  assert.deepStrictEqual(m.get(EMP).get('2026-08-13'), { type: 'Comp Off', status: 'approved' });
});

test('approved wins over pending on the same date', () => {
  const m = expandLeaveDays([
    { employeeId: EMP, fromDate: '2026-08-10', toDate: '2026-08-10', type: 'Casual Leave', status: 'pending' },
    { employeeId: EMP, fromDate: '2026-08-10', toDate: '2026-08-10', type: 'Casual Leave', status: 'approved' },
  ], '2026-08-01', '2026-08-31', OPTS);
  assert.strictEqual(m.get(EMP).get('2026-08-10').status, 'approved');
});

test('leave is clamped to the queried range', () => {
  const m = expandLeaveDays([{ employeeId: EMP, fromDate: '2026-07-30', toDate: '2026-08-04', type: 'Casual Leave', status: 'approved' }], '2026-08-01', '2026-08-31', OPTS);
  const keys = [...m.get(EMP).keys()].sort();
  assert.ok(keys.every(k => k >= '2026-08-01'), 'nothing before the range start');
  assert.deepStrictEqual(keys, ['2026-08-03', '2026-08-04']);   // Aug 1/2 are weekend
});
