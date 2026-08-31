/**
 * Sheet 4 — "Attendance & LOP Reconciliation" row builder.
 *
 * Stricter LOP model than Sheet 3: PENDING leave is unpaid and contributes to LOP;
 * APPROVED leave is paid (0 LOP, full Salary-Working-Day credit); genuine absence and
 * attended-day shortage also contribute to LOP — with no double counting. Salary Working
 * Days is derived (Working − LOP/req), never hardcoded to Working Days.
 *
 * Pure, no network — exercises the real buildLopReconRow. (Sheet 3's builder/tests untouched.)
 */
process.env.NODE_ENV = 'test';

const { test } = require('node:test');
const assert = require('node:assert');
const { buildLopReconRow, pendingLopDayCount } = require('../src/services/payroll-recon.util');

const FD = 9;
const RC = { calendar: 31, working: 20 };
const base = { present: 0, half: 0, incomplete: 0, inProgress: 0, absent: 0, effectiveHours: 0, overtimeHours: 0 };
const row = (over = {}, opts = {}) => buildLopReconRow({
  employeeId: 'E', employeeName: 'X', rc: opts.rc || RC, summary: { ...base, ...over },
  approvedLeaveDays: opts.approvedLeaveDays || 0, pendingLeaveDays: opts.pendingLeaveDays || 0,
  shortageHours: opts.shortageHours || 0, fullDayHours: FD,
});

test('21 — Sheet 4 row has exactly the 17 reconciliation columns, in order, no salary amounts', () => {
  const keys = Object.keys(row());
  assert.deepEqual(keys, [
    'employeeId', 'employeeName', 'calendarDays', 'workingDays', 'presentDays', 'approvedLeaveDays',
    'pendingLeaveDays', 'absentDays', 'halfDays', 'incompleteDays', 'inProgressDays', 'salaryWorkingDays',
    'effectiveHours', 'requiredHours', 'shortageHours', 'lopHours', 'otHours',
  ]);
  for (const banned of ['grossPay', 'netPay', 'otPay', 'professionalTax', 'otherDeductions', 'lopDeduction', 'shortageDeduction']) {
    assert.ok(!(banned in row()), `${banned} must not appear`);
  }
});

test('1/5 — approved leave: paid, 0 LOP, Salary Working Days preserved (=Working)', () => {
  // Working 20, Present 16, Approved 4, Pending 0, Absent 0.
  const r = row({ present: 16, effectiveHours: 16 * FD }, { approvedLeaveDays: 4 });
  assert.strictEqual(r.approvedLeaveDays, 4);
  assert.strictEqual(r.lopHours, 0);
  assert.strictEqual(r.salaryWorkingDays, 20);   // approved leave keeps full credit
});

test('2/3 — pending leave: own column AND drives LOP (pending days × required hours)', () => {
  const r = row({ present: 18 }, { pendingLeaveDays: 2 });
  assert.strictEqual(r.pendingLeaveDays, 2);
  assert.strictEqual(r.lopHours, 2 * FD);        // 2 pending days → 18h LOP
});

test('4 — pending leave does NOT become approved leave', () => {
  const r = row({}, { pendingLeaveDays: 1 });
  assert.strictEqual(r.approvedLeaveDays, 0);
  assert.strictEqual(r.pendingLeaveDays, 1);
});

test('5b — pending leave is NOT salary-protected (reduces Salary Working Days)', () => {
  const r = row({ present: 19 }, { pendingLeaveDays: 1 });
  assert.strictEqual(r.salaryWorkingDays, 19);   // 20 − 9/9
});

test('6 — genuine absence → LOP (absent days × required hours)', () => {
  const r = row({ present: 18, absent: 2 });
  assert.strictEqual(r.absentDays, 2);
  assert.strictEqual(r.lopHours, 2 * FD);        // 18h
  assert.strictEqual(r.salaryWorkingDays, 18);   // 20 − 18/9
});

test('7 — attended-day shortage → LOP, shown separately (not hidden in Absent)', () => {
  const r = row({ present: 20, effectiveHours: 20 * FD - 2 }, { shortageHours: 2 });
  assert.strictEqual(r.shortageHours, 2);
  assert.strictEqual(r.absentDays, 0);           // shortage never becomes a full-day absence
  assert.strictEqual(r.lopHours, 2);
});

test('8/9 — incomplete (missing punch) carried as its own column; its shortage flows into LOP', () => {
  // A missing-punch day is Incomplete (not Half); its firm shortage arrives via shortageHours.
  const r = row({ present: 19, incomplete: 1, effectiveHours: 19 * FD + 4 }, { shortageHours: 5 });
  assert.strictEqual(r.incompleteDays, 1);
  assert.strictEqual(r.halfDays, 0);             // missing punch is NOT auto Half Day
  assert.strictEqual(r.lopHours, 5);             // applicable missing/shortage hours → LOP
});

test('13 — Half Days shown separately (not fabricated from pending/shortage/missing punch)', () => {
  const r = row({ present: 18, half: 1, effectiveHours: 18 * FD + 4.5 }, { shortageHours: 4.5 });
  assert.strictEqual(r.halfDays, 1);
  assert.strictEqual(r.pendingLeaveDays, 0);
});

test('14 — In Progress shown; today’s open day is not turned into LOP by the builder', () => {
  // The builder receives only finalized pending/absent counts + shortage; an in-progress day
  // contributes none of them, so it adds 0 LOP.
  const r = row({ present: 19, inProgress: 1, effectiveHours: 19 * FD });
  assert.strictEqual(r.inProgressDays, 1);
  assert.strictEqual(r.lopHours, 0);
});

test('15 — Salary Working Days is DERIVED (Working − LOP/req), never hardcoded to Working', () => {
  // The Sheet 3 bug: Present 4 / Working 20 showed Salary Working Days 20. Here it is 4.
  const r = row({ present: 4, absent: 16, effectiveHours: 4 * FD });
  assert.strictEqual(r.absentDays, 16);
  assert.strictEqual(r.lopHours, 16 * FD);
  assert.strictEqual(r.salaryWorkingDays, 4);    // 20 − 144/9 = 4  (NOT 20)
  assert.notStrictEqual(r.salaryWorkingDays, r.workingDays);
});

test('16 — August 31-day range: Calendar/Working/Required come straight through', () => {
  const r = buildLopReconRow({ employeeId: 'E', employeeName: 'X', rc: { calendar: 31, working: 21 }, summary: { ...base, present: 21, effectiveHours: 21 * FD }, approvedLeaveDays: 0, pendingLeaveDays: 0, shortageHours: 0, fullDayHours: FD });
  assert.strictEqual(r.calendarDays, 31);
  assert.strictEqual(r.workingDays, 21);
  assert.strictEqual(r.requiredHours, 21 * FD);   // 189h
});

test('17 — month separation: values are pure functions of the passed month rc/summary', () => {
  const jul = buildLopReconRow({ employeeId: 'E', employeeName: 'X', rc: { calendar: 31, working: 23 }, summary: { ...base, present: 23, effectiveHours: 23 * FD }, approvedLeaveDays: 0, pendingLeaveDays: 0, shortageHours: 0, fullDayHours: FD });
  const aug = buildLopReconRow({ employeeId: 'E', employeeName: 'X', rc: { calendar: 31, working: 21 }, summary: { ...base, present: 21, effectiveHours: 21 * FD }, approvedLeaveDays: 0, pendingLeaveDays: 0, shortageHours: 0, fullDayHours: FD });
  assert.strictEqual(jul.workingDays, 23);
  assert.strictEqual(aug.workingDays, 21);
  assert.notStrictEqual(jul.requiredHours, aug.requiredHours);
});

test('18 — no double counting: absent + pending + shortage are summed once each', () => {
  // Working 20, Approved 2, Pending 1, Absent 1, Shortage 2h → LOP = 9 + 9 + 2 = 20h.
  const r = row({ present: 15, absent: 1, effectiveHours: 130 }, { approvedLeaveDays: 2, pendingLeaveDays: 1, shortageHours: 2 });
  assert.strictEqual(r.approvedLeaveDays, 2);
  assert.strictEqual(r.pendingLeaveDays, 1);
  assert.strictEqual(r.absentDays, 1);
  assert.strictEqual(r.shortageHours, 2);
  assert.strictEqual(r.lopHours, 1 * FD + 1 * FD + 2);   // 20h — each component once
  assert.strictEqual(r.salaryWorkingDays, Math.round((20 - 20 / FD) * 100) / 100);   // 17.78
});

test('19 — OT Hours come from attendance; no OT Pay', () => {
  const r = row({ present: 20, overtimeHours: 6.5, effectiveHours: 20 * FD + 6.5 });
  assert.strictEqual(r.otHours, 6.5);
  assert.ok(!('otPay' in r));
});

// ── Final rule: pending leave on TODAY still counts (only attendance excludes it) ──
const TODAY = '2026-08-31';
const leaveMap = (entries) => new Map(entries);   // [ [date, {status}], ... ]

test('pending leave on TODAY → Pending Leave = 1 and LOP = 9h (today NOT excluded)', () => {
  // Route-level count: a pending leave dated today, with no attendance record → counts.
  const count = pendingLopDayCount(leaveMap([[TODAY, { status: 'pending' }]]), () => false);
  assert.strictEqual(count, 1, 'today\'s pending leave is counted');
  const r = row({ present: 20 }, { rc: { calendar: 31, working: 21 }, pendingLeaveDays: count });
  assert.strictEqual(r.pendingLeaveDays, 1);
  assert.strictEqual(r.approvedLeaveDays, 0);
  assert.strictEqual(r.lopHours, FD);            // 9h
});

test('approved leave on TODAY → Approved Leave = 1 and LOP = 0 (pending count 0)', () => {
  const count = pendingLopDayCount(leaveMap([[TODAY, { status: 'approved' }]]), () => false);
  assert.strictEqual(count, 0, 'approved leave is never a pending-LOP day');
  const r = row({ present: 20 }, { rc: { calendar: 31, working: 21 }, approvedLeaveDays: 1, pendingLeaveDays: count });
  assert.strictEqual(r.approvedLeaveDays, 1);
  assert.strictEqual(r.pendingLeaveDays, 0);
  assert.strictEqual(r.lopHours, 0);
});

test('attendance precedence — a pending-leave date WITH a punch is not a pending-LOP day', () => {
  // Punch/in-progress record on the date wins → not double-counted as pending LOP.
  const count = pendingLopDayCount(leaveMap([[TODAY, { status: 'pending' }]]), (d) => d === TODAY);
  assert.strictEqual(count, 0);
});

test('multiple pending days across the month all count (no today/future exclusion)', () => {
  const count = pendingLopDayCount(leaveMap([
    ['2026-08-10', { status: 'pending' }],
    ['2026-08-28', { status: 'pending' }],
    [TODAY, { status: 'pending' }],
    ['2026-08-15', { status: 'approved' }],   // approved excluded
  ]), () => false);
  assert.strictEqual(count, 3);
});

test('approve-later semantics — moving a day from pending→approved removes its LOP', () => {
  const pending = row({ present: 19 }, { pendingLeaveDays: 1 });
  const approved = row({ present: 19 }, { approvedLeaveDays: 1 });   // same day, now approved
  assert.strictEqual(pending.lopHours, FD);        // pending → 9h LOP
  assert.strictEqual(approved.lopHours, 0);         // approved → 0 LOP
  assert.ok(approved.salaryWorkingDays > pending.salaryWorkingDays);
});
