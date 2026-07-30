const { test } = require('node:test');
const assert = require('node:assert');
const { leaveSummary, daysInclusive, resolveDays } = require('../src/services/leave-summary.util');

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

// ── Checklist #10 explicit scenarios ─────────────────────────────────────────
test('No leave records → Total Leave Taken = 0, approvedCount = 0', () => {
  const s = leaveSummary([], { from: '2026-07-01', to: '2026-07-31' });
  assert.strictEqual(s.taken, 0);
  assert.strictEqual(s.approvedCount, 0);
});

test('One approved leave → taken equals its days (never 0)', () => {
  const s = leaveSummary([{ days: 4, fromDate: '2026-07-10', status: 'approved' }],
    { from: '2026-07-01', to: '2026-07-31' });
  assert.strictEqual(s.approvedCount, 1);
  assert.strictEqual(s.taken, 4);
});

test('Multiple approved leaves → days summed correctly', () => {
  const s = leaveSummary([
    { days: 2, fromDate: '2026-07-03', status: 'approved' },
    { days: 3, fromDate: '2026-07-12', status: 'approved' },
    { days: 1, fromDate: '2026-07-25', status: 'approved' },
  ], { from: '2026-07-01', to: '2026-07-31' });
  assert.strictEqual(s.approvedCount, 3);
  assert.strictEqual(s.taken, 6);
});

test('Mixed Pending/Approved/Rejected → only Approved days counted in taken', () => {
  const s = leaveSummary([
    { days: 2, fromDate: '2026-07-05', status: 'approved' },
    { days: 4, fromDate: '2026-07-08', status: 'pending' },
    { days: 3, fromDate: '2026-07-11', status: 'rejected' },
    { days: 1, fromDate: '2026-07-18', status: 'approved' },
  ], { from: '2026-07-01', to: '2026-07-31' });
  assert.strictEqual(s.taken, 3);           // 2 + 1 approved only (pending/rejected excluded)
  assert.strictEqual(s.approvedCount, 2);
  assert.strictEqual(s.pendingCount, 1);
  assert.strictEqual(s.rejectedCount, 1);
});

test('Date filter validation: leave outside the period is excluded from taken', () => {
  const rowsX = [
    { days: 2, fromDate: '2026-06-30', status: 'approved' },   // day before the window
    { days: 2, fromDate: '2026-07-01', status: 'approved' },   // window start (inclusive)
    { days: 2, fromDate: '2026-07-31', status: 'approved' },   // window end (inclusive)
    { days: 2, fromDate: '2026-08-01', status: 'approved' },   // day after the window
  ];
  const s = leaveSummary(rowsX, { from: '2026-07-01', to: '2026-07-31' });
  assert.strictEqual(s.approvedCount, 2);   // only the two inside [Jul 1, Jul 31]
  assert.strictEqual(s.taken, 4);
});

// ── Root cause: hr_days blank on the record → recover from from→to span ───────
test('daysInclusive counts both endpoints (same day = 1)', () => {
  assert.strictEqual(daysInclusive('2026-07-10', '2026-07-10'), 1);
  assert.strictEqual(daysInclusive('2026-07-10', '2026-07-14'), 5);
  assert.strictEqual(daysInclusive('', ''), 0);
  assert.strictEqual(daysInclusive('2026-07-14', '2026-07-10'), 0);  // reversed → 0
});

test('resolveDays: uses hr_days when present, else the from→to span', () => {
  assert.strictEqual(resolveDays(3, '2026-07-10', '2026-07-20'), 3);   // trust stored value
  assert.strictEqual(resolveDays(null, '2026-07-10', '2026-07-12'), 3);// blank → span (3 days)
  assert.strictEqual(resolveDays(0, '2026-07-10', '2026-07-10'), 1);   // zero → span (1 day)
  assert.strictEqual(resolveDays('', '2026-07-10', '2026-07-14'), 5);  // empty string → span
});

test('Approved leaves with BLANK hr_days still produce a non-zero taken (the bug)', () => {
  // Simulates records where hr_days was never populated: rows built via resolveDays.
  const raw = [
    { hr_days: null, hr_fromdate: '2026-07-06', hr_todate: '2026-07-08', status: 'approved' }, // 3
    { hr_days: '',   hr_fromdate: '2026-07-20', hr_todate: '2026-07-20', status: 'approved' }, // 1
  ];
  const built = raw.map(r => ({
    days: resolveDays(r.hr_days, r.hr_fromdate, r.hr_todate),
    fromDate: r.hr_fromdate,
    status: r.status,
  }));
  const s = leaveSummary(built, { from: '2026-07-01', to: '2026-07-31' });
  assert.strictEqual(s.approvedCount, 2);
  assert.strictEqual(s.taken, 4);           // 3 + 1 — never 0 despite blank hr_days
});
