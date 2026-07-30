const { test } = require('node:test');
const assert = require('node:assert');
const { leaveSummary } = require('../src/services/leave-summary.util');

const rows = [
  { days: 2, fromDate: '2026-07-06', status: 'approved' },
  { days: 1, fromDate: '2026-07-20', status: 'approved' },
  { days: 3, fromDate: '2026-06-10', status: 'approved' },   // last month
  { days: 2, fromDate: '2026-07-28', status: 'pending' },
  { days: 1, fromDate: '2026-07-15', status: 'rejected' },
  { days: 5, fromDate: '2025-12-10', status: 'approved' },    // prior year
];

test('This Month: approved/pending/rejected counts + total taken', () => {
  const s = leaveSummary(rows, { from: '2026-07-01', to: '2026-07-31' });
  assert.strictEqual(s.approvedCount, 2);   // Jul 6, Jul 20
  assert.strictEqual(s.taken, 3);           // 2 + 1 approved days
  assert.strictEqual(s.pendingCount, 1);
  assert.strictEqual(s.pendingDays, 2);
  assert.strictEqual(s.rejectedCount, 1);
});

test('Last Month: only June rows', () => {
  const s = leaveSummary(rows, { from: '2026-06-01', to: '2026-06-30' });
  assert.strictEqual(s.approvedCount, 1);
  assert.strictEqual(s.taken, 3);
  assert.strictEqual(s.pendingCount, 0);
  assert.strictEqual(s.rejectedCount, 0);
});

test('This Year: all 2026 rows, prior year excluded', () => {
  const s = leaveSummary(rows, { from: '2026-01-01', to: '2026-12-31' });
  assert.strictEqual(s.approvedCount, 3);   // Jul 6, Jul 20, Jun 10
  assert.strictEqual(s.taken, 6);           // 2 + 1 + 3
  assert.strictEqual(s.pendingCount, 1);
  assert.strictEqual(s.rejectedCount, 1);
});

test('Last Year: only 2025 rows', () => {
  const s = leaveSummary(rows, { from: '2025-01-01', to: '2025-12-31' });
  assert.strictEqual(s.approvedCount, 1);
  assert.strictEqual(s.taken, 5);
});

test('Custom range', () => {
  const s = leaveSummary(rows, { from: '2026-07-15', to: '2026-07-31' });
  assert.strictEqual(s.approvedCount, 1);   // only Jul 20
  assert.strictEqual(s.taken, 1);
  assert.strictEqual(s.pendingCount, 1);    // Jul 28
  assert.strictEqual(s.rejectedCount, 1);   // Jul 15
});

test('Empty → all zeros', () => {
  const s = leaveSummary([], { from: '2026-07-01', to: '2026-07-31' });
  assert.strictEqual(s.approvedCount, 0);
  assert.strictEqual(s.taken, 0);
  assert.strictEqual(s.pendingCount, 0);
  assert.strictEqual(s.rejectedCount, 0);
});
