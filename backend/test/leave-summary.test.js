const { test } = require('node:test');
const assert = require('node:assert');
const { leaveSummary } = require('../src/services/leave-summary.util');

const rows = [
  { days: 2, fromDate: '2026-07-06', status: 'approved', type: 'Casual Leave' },
  { days: 1, fromDate: '2026-07-20', status: 'approved', type: 'LOP' },
  { days: 3, fromDate: '2026-03-10', status: 'approved', type: 'Sick Leave' },
  { days: 2, fromDate: '2026-07-28', status: 'pending', type: 'Casual Leave' },
  { days: 1, fromDate: '2026-06-01', status: 'rejected', type: 'Casual Leave' },
  { days: 5, fromDate: '2025-12-10', status: 'approved', type: 'Casual Leave' }, // prior year — excluded
];

test('leaveSummary: dynamic counts for the dashboard', () => {
  const s = leaveSummary(rows, { year: 2026, month: 7, entitlement: 24 });
  assert.strictEqual(s.entitlement, 24);
  assert.strictEqual(s.taken, 6);          // approved this year: 2 + 1 + 3
  assert.strictEqual(s.available, 18);     // 24 - 6
  assert.strictEqual(s.approvedCount, 3);
  assert.strictEqual(s.pending, 2);
  assert.strictEqual(s.pendingCount, 1);
  assert.strictEqual(s.rejected, 1);
  assert.strictEqual(s.rejectedCount, 1);
  assert.strictEqual(s.lop, 1);            // LOP days
  assert.strictEqual(s.currentMonth, 3);   // approved July: 2 + 1
  assert.strictEqual(s.currentYear, 6);
  assert.strictEqual(s.casual, 2);         // approved Casual Leave days
  assert.strictEqual(s.sick, 3);           // approved Sick Leave days
});

test('leaveSummary: available never negative (over-taken)', () => {
  const s = leaveSummary([{ days: 30, fromDate: '2026-01-02', status: 'approved', type: 'Casual Leave' }], { year: 2026, month: 1, entitlement: 24 });
  assert.strictEqual(s.available, 0);
  assert.strictEqual(s.taken, 30);
});

test('leaveSummary: empty → zeros', () => {
  const s = leaveSummary([], { year: 2026, month: 7, entitlement: 24 });
  assert.strictEqual(s.taken, 0);
  assert.strictEqual(s.available, 24);
  assert.strictEqual(s.pendingCount, 0);
});
