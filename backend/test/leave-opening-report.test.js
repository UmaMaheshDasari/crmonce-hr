/**
 * Leave Usage Report — pure usage math + status filtering + year-clamp + sort.
 *
 * Reporting only: Approved + Pending counted; Rejected + Cancelled excluded;
 * multi-day + year-boundary clamped; pending shown as taken but NOT deducted from
 * Remaining; least-taken-first sort with alphabetical ties. No network.
 */
process.env.NODE_ENV = 'test';
process.env.AZURE_CLIENT_ID = process.env.AZURE_CLIENT_ID || 'test-client';
process.env.AZURE_CLIENT_SECRET = process.env.AZURE_CLIENT_SECRET || 'test-secret';
process.env.AZURE_TENANT_ID = process.env.AZURE_TENANT_ID || 'test-tenant';

const { test } = require('node:test');
const assert = require('node:assert');
const rpt = require('../src/services/leave-opening-report.service');
const d365 = require('../src/services/d365.service');
const openingSvc = require('../src/services/leave-opening.service');
const payrollSettings = require('../src/services/payroll-settings.service');

const E = d365.constructor.entities;
const YEAR = 2026;
const POLICY = { casual: 12, sick: 6 };

// hr_leave_type picklist values
const T = { casual: 123140000, sick: 123140001, earned: 123140002, maternity: 123140003, paternity: 123140004, lop: 123140005 };
// hr_leave_status picklist values
const S = { pending: 123140000, approved: 123140001, rejected: 123140002, cancelled: 123140003 };

const emp = (id, name = `Emp ${id}`) => ({ hr_hremployeeid: id, hr_hremployee1: name, hr_employeeid: `E${id}` });
const lv = (type, from, to, days, over = {}) => ({ hr_leavetype: type, hr_fromdate: from, hr_todate: to || from, hr_days: days, ...over });

// ── 1. No leave → all zeros; full allocation remaining ────────────────
test('employee with no leave: zero taken, full remaining', () => {
  const r = rpt.computeUsageRow({ employee: emp('A'), policy: POLICY, year: YEAR });
  assert.equal(r.totalTaken, 0);
  assert.equal(r.casualTaken, 0);
  assert.equal(r.casualRemaining, 12);
  assert.equal(r.sickRemaining, 6);
  assert.equal(r.totalRemaining, 18);
  assert.equal(r.pendingLeaveDays, 0);
});

// ── 2. Approved leave is counted ──────────────────────────────────────
test('approved casual leave counts as taken and reduces remaining', () => {
  const r = rpt.computeUsageRow({ employee: emp('A'), policy: POLICY, year: YEAR,
    approvedLeaves: [lv(T.casual, '2026-03-02', '2026-03-03', 2)] });
  assert.equal(r.casualTaken, 2);
  assert.equal(r.approvedLeaveDays, 2);
  assert.equal(r.casualRemaining, 10);
  assert.equal(r.totalTaken, 2);
});

// ── 3. Pending is taken/applied but NOT deducted from remaining ───────
test('pending leave shows as taken but does not reduce remaining', () => {
  const r = rpt.computeUsageRow({ employee: emp('A'), policy: POLICY, year: YEAR,
    pendingLeaves: [lv(T.casual, '2026-04-06', '2026-04-08', 3)] });
  assert.equal(r.casualTaken, 3);          // applied
  assert.equal(r.pendingLeaveDays, 3);
  assert.equal(r.casualRemaining, 12);     // NOT deducted
  assert.equal(r.totalTaken, 3);
});

// ── 6. Multiple leave types map to the correct buckets ────────────────
test('casual + sick + earned map to their own buckets', () => {
  const r = rpt.computeUsageRow({ employee: emp('A'), policy: POLICY, year: YEAR,
    approvedLeaves: [
      lv(T.casual, '2026-02-02', '2026-02-02', 1),
      lv(T.sick, '2026-02-10', '2026-02-11', 2),
      lv(T.earned, '2026-05-04', '2026-05-08', 5),
    ] });
  assert.equal(r.casualTaken, 1);
  assert.equal(r.sickTaken, 2);
  assert.equal(r.earnedTaken, 5);
  assert.equal(r.totalTaken, 8);
  assert.equal(r.earnedRemaining, null);   // earned is uncapped
});

// ── 7. Multi-day leave counts hr_days ─────────────────────────────────
test('multi-day leave counts by days', () => {
  const r = rpt.computeUsageRow({ employee: emp('A'), policy: POLICY, year: YEAR,
    approvedLeaves: [lv(T.casual, '2026-06-01', '2026-06-05', 5)] });
  assert.equal(r.casualTaken, 5);
  assert.equal(r.casualRemaining, 7);
});

// ── 8. Fractional (half-day) hr_days is respected ─────────────────────
test('fractional half-day leave is honored', () => {
  const r = rpt.computeUsageRow({ employee: emp('A'), policy: POLICY, year: YEAR,
    approvedLeaves: [lv(T.sick, '2026-07-01', '2026-07-01', 0.5)] });
  assert.equal(r.sickTaken, 0.5);
  assert.equal(r.sickRemaining, 5.5);
});

// ── 9a. Year-boundary clamp (pure) ────────────────────────────────────
test('clampedDays counts only the in-year portion of a boundary-crossing leave', () => {
  const leave = lv(T.casual, '2025-12-30', '2026-01-02', 4);   // 4 calendar days total
  assert.equal(rpt.clampedDays(leave, 2026), 2);               // Jan 1–2
  assert.equal(rpt.clampedDays(leave, 2025), 2);               // Dec 30–31
});

// ── 9b. Year-boundary in the row ──────────────────────────────────────
test('boundary leave contributes only in-year days to taken', () => {
  const r = rpt.computeUsageRow({ employee: emp('A'), policy: POLICY, year: 2026,
    approvedLeaves: [lv(T.casual, '2025-12-30', '2026-01-02', 4)] });
  assert.equal(r.casualTaken, 2);
});

// ── Comp-off leave (Earned + hr_usecompoff) → its own bucket ──────────
test('comp-off leave lands in the comp off bucket, not earned', () => {
  const r = rpt.computeUsageRow({ employee: emp('A'), policy: POLICY, year: YEAR,
    approvedLeaves: [lv(T.earned, '2026-08-03', '2026-08-03', 1, { hr_usecompoff: 'true' })] });
  assert.equal(r.compOffTaken, 1);
  assert.equal(r.earnedTaken, 0);
  assert.equal(r.totalTaken, 1);
});

// ── 10. Absent/unauthorized days flow in from payroll ─────────────────
test('absent days (payroll) are included in total taken', () => {
  const r = rpt.computeUsageRow({ employee: emp('A'), policy: POLICY, year: YEAR,
    approvedLeaves: [lv(T.casual, '2026-03-02', '2026-03-02', 1)], absentDays: 3 });
  assert.equal(r.absentDays, 3);
  assert.equal(r.casualTaken, 1);
  assert.equal(r.totalTaken, 4);           // 1 casual + 3 absent
});

// ── Opening migration folds into taken but remaining stays balance-based ──
test('opening used folds into taken and reduces remaining', () => {
  const r = rpt.computeUsageRow({ employee: emp('A'), policy: POLICY, year: YEAR,
    opening: { casualUsed: 4 },
    approvedLeaves: [lv(T.casual, '2026-03-02', '2026-03-02', 1)] });
  assert.equal(r.casualTaken, 5);          // 4 opening + 1 approved
  assert.equal(r.casualRemaining, 7);      // 12 − (4 + 1)
});

// ── 11/12/13. Sort: least first, highest last, ties alphabetical ──────
test('sortRows: least taken first, highest last, ties alphabetical', () => {
  const mk = (name, total) => ({ employeeName: name, totalTaken: total });
  const sorted = rpt.sortRows([
    mk('Zara', 9), mk('Bob', 0), mk('Alice', 4), mk('Chris', 4),
  ]);
  assert.deepEqual(sorted.map(r => r.employeeName), ['Bob', 'Alice', 'Chris', 'Zara']);
  assert.equal(sorted[0].totalTaken, 0);     // 0-leave at TOP
  assert.equal(sorted.at(-1).totalTaken, 9); // highest at BOTTOM
});

// ── 4 & 5. buildSummary excludes rejected + cancelled, includes pending ──
test('buildSummary counts approved+pending, excludes rejected+cancelled', async () => {
  const A = 'guid-A';
  const realGetList = d365.getList, realGetListOptional = d365.getListOptional;
  const realOpeningList = openingSvc.list, realResolved = payrollSettings.getResolved;
  payrollSettings.getResolved = async () => ({ leavePolicy: POLICY });
  openingSvc.list = async () => [];
  d365.getListOptional = async (entity) => {
    if (entity === E.employee) return { data: [emp(A, 'Alice')] };
    if (entity === E.payroll) return { data: [] };
    return { data: [] };
  };
  d365.getList = async (entity, opts) => {
    if (entity === E.leave) {
      // The service must have filtered to approved+pending only; return that mix.
      // (Rejected/cancelled rows would never be returned by the real filter.)
      return { data: [
        { ...lv(T.casual, '2026-03-02', '2026-03-03', 2), hr_status: S.approved, _hr_hremployee_value: A },
        { ...lv(T.sick, '2026-04-01', '2026-04-01', 1), hr_status: S.pending, _hr_hremployee_value: A },
      ] };
    }
    if (entity === E.leaveLedger) return { data: [] };
    return { data: [] };
  };
  try {
    const rows = await rpt.buildSummary({ year: YEAR });
    assert.equal(rows.length, 1);
    const r = rows[0];
    assert.equal(r.employeeName, 'Alice');
    assert.equal(r.casualTaken, 2);          // approved
    assert.equal(r.sickTaken, 1);            // pending included
    assert.equal(r.approvedLeaveDays, 2);
    assert.equal(r.pendingLeaveDays, 1);
    assert.equal(r.totalTaken, 3);
    // The OData filter string must restrict to approved+pending only.
    // (guards against a regression that would let rejected/cancelled leak in)
  } finally {
    d365.getList = realGetList; d365.getListOptional = realGetListOptional;
    openingSvc.list = realOpeningList; payrollSettings.getResolved = realResolved;
  }
});

test('buildSummary leave filter restricts to approved+pending statuses', async () => {
  let captured = '';
  const realGetList = d365.getList, realGetListOptional = d365.getListOptional;
  const realOpeningList = openingSvc.list, realResolved = payrollSettings.getResolved;
  payrollSettings.getResolved = async () => ({ leavePolicy: POLICY });
  openingSvc.list = async () => [];
  d365.getListOptional = async () => ({ data: [] });
  d365.getList = async (entity, opts) => {
    if (entity === E.leave) captured = opts.filter;
    return { data: [] };
  };
  try {
    await rpt.buildSummary({ year: YEAR });
    assert.ok(captured.includes(String(S.approved)), 'filter must include approved status');
    assert.ok(captured.includes(String(S.pending)), 'filter must include pending status');
    assert.ok(!captured.includes(String(S.rejected)), 'filter must NOT include rejected');
    assert.ok(!captured.includes(String(S.cancelled)), 'filter must NOT include cancelled');
  } finally {
    d365.getList = realGetList; d365.getListOptional = realGetListOptional;
    openingSvc.list = realOpeningList; payrollSettings.getResolved = realResolved;
  }
});
