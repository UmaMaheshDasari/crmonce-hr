/**
 * Half-Day Leave (hr_halfday flag) — the 0.5-day semantics across the authoritative
 * leave/attendance day-count helpers. hr_days is Edm.Int32 (stored as 1 for a half-day);
 * hr_halfday === 'true' is the single source of truth for the 0.5 weight.
 *
 * Verifies the finalized business rules (daily required hours = 9):
 *   Approved half-day → Approved Leave 0.5, 0 LOP.
 *   Pending  half-day → Pending  Leave 0.5, LOP 4.5h (0.5 × 9).
 *   Full leave unaffected. No double counting. hr_days never 0.5.
 */
process.env.NODE_ENV = 'test';
const { test } = require('node:test');
const assert = require('node:assert');
const { resolveDays, isHalfDayLeave } = require('../src/services/leave-summary.util');
const { approvedLeaveDaysWeighted, expandLeaveDays } = require('../src/services/attendance-summary.util');
const { pendingLopDayCount } = require('../src/services/payroll-recon.util');

const FD = 9;   // daily required hours
const OPTS = { weekOffDays: [0, 6], holidays: [] };
const D = '2026-08-10';   // a Monday (working day)

test('resolveDays — hr_halfday "true" → 0.5 regardless of stored hr_days (Int 1)', () => {
  assert.strictEqual(resolveDays(1, D, D, 'true'), 0.5);   // stored Int 1 + flag → 0.5
  assert.strictEqual(resolveDays(1, D, D, 'false'), 1);    // full day
  assert.strictEqual(resolveDays(3, '2026-08-10', '2026-08-12'), 3);  // no flag → unchanged
  assert.strictEqual(isHalfDayLeave('true'), true);
  assert.strictEqual(isHalfDayLeave(undefined), false);    // legacy rows (no flag) → full day
});

test('approvedLeaveDaysWeighted — a half-day approved leave contributes 0.5', () => {
  const half = approvedLeaveDaysWeighted([{ hr_fromdate: D, hr_todate: D, hr_days: 1, hr_halfday: 'true' }], '2026-08-01', '2026-08-31', OPTS);
  assert.strictEqual(half, 0.5);
  const full = approvedLeaveDaysWeighted([{ hr_fromdate: D, hr_todate: D, hr_days: 1, hr_halfday: 'false' }], '2026-08-01', '2026-08-31', OPTS);
  assert.strictEqual(full, 1);
});

// Replicates buildRangeSummary's day-count loop + Sheet-4 pending LOP on the expandLeaveDays map.
function counts(norm) {
  const map = expandLeaveDays(norm, '2026-08-01', '2026-08-31', OPTS).get('E') || new Map();
  let approved = 0, pending = 0;
  for (const info of map.values()) { const w = Number(info.weight) || 1; if (info.status === 'approved') approved += w; else if (info.status === 'pending') pending += w; }
  const pendingLop = pendingLopDayCount(map, () => false);   // no attendance record on the date
  return { approved: Math.round(approved * 100) / 100, pending: Math.round(pending * 100) / 100, pendingLopHours: Math.round(pendingLop * FD * 100) / 100 };
}

test('APPROVED half-day → Approved Leave 0.5 and 0 LOP (9h day)', () => {
  const c = counts([{ employeeId: 'E', fromDate: D, toDate: D, type: 'Casual Leave', status: 'approved', halfDay: true }]);
  assert.strictEqual(c.approved, 0.5);
  assert.strictEqual(c.pending, 0);
  assert.strictEqual(c.pendingLopHours, 0);   // approved → never LOP
});

test('PENDING half-day → Pending Leave 0.5 and LOP 4.5h (0.5 × 9)', () => {
  const c = counts([{ employeeId: 'E', fromDate: D, toDate: D, type: 'Casual Leave', status: 'pending', halfDay: true }]);
  assert.strictEqual(c.pending, 0.5);
  assert.strictEqual(c.approved, 0);
  assert.strictEqual(c.pendingLopHours, 4.5);
});

test('FULL pending leave → Pending 1 and LOP 9h (unaffected by the half-day change)', () => {
  const c = counts([{ employeeId: 'E', fromDate: D, toDate: D, type: 'Casual Leave', status: 'pending' }]);
  assert.strictEqual(c.pending, 1);
  assert.strictEqual(c.pendingLopHours, 9);
});

test('FULL approved leave → Approved 1 and 0 LOP (unaffected)', () => {
  const c = counts([{ employeeId: 'E', fromDate: D, toDate: D, type: 'Casual Leave', status: 'approved' }]);
  assert.strictEqual(c.approved, 1);
  assert.strictEqual(c.pendingLopHours, 0);
});

test('no double counting — a half-day pending leave WITH a punch that day is not LOP', () => {
  const map = expandLeaveDays([{ employeeId: 'E', fromDate: D, toDate: D, type: 'Casual Leave', status: 'pending', halfDay: true }], '2026-08-01', '2026-08-31', OPTS).get('E');
  const lop = pendingLopDayCount(map, (d) => d === D);   // attendance record exists → precedence
  assert.strictEqual(lop, 0);
});

test('mixed: approved half-day (0.5) + full pending (1) on different dates', () => {
  const c = counts([
    { employeeId: 'E', fromDate: D, toDate: D, type: 'Casual Leave', status: 'approved', halfDay: true },
    { employeeId: 'E', fromDate: '2026-08-11', toDate: '2026-08-11', type: 'Casual Leave', status: 'pending' },
  ]);
  assert.strictEqual(c.approved, 0.5);
  assert.strictEqual(c.pending, 1);
  assert.strictEqual(c.pendingLopHours, 9);   // only the full pending day → 9h (half-day is approved → 0)
});
