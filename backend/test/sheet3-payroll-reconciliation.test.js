/**
 * Sheet 3 — Monthly Attendance Report row builder (ATTENDANCE ONLY, no money).
 *
 * Proves the row carries exactly the 15 attendance columns and NO monetary field, that
 * every value is attendance-derived (day/hour counts from summarizeEmployee; shortage
 * hours from the monthly hour-balance), that approved leave is separate & salary-protected,
 * and that LOP Hours and Shortage Hours are distinct.
 *
 * Pure, no network — exercises the real buildAttendanceRow / lopHoursOf.
 */
process.env.NODE_ENV = 'test';

const { test } = require('node:test');
const assert = require('node:assert');
const { buildAttendanceRow, lopHoursOf } = require('../src/services/payroll-recon.util');

const FD = 9;   // full-day expected hours
const RC = { calendar: 31, working: 21 };

// Working 21, Present 19, Approved Leave 2, Absent 0 (the "approved leave" example).
const cleanSummary = { present: 19, half: 0, incomplete: 0, inProgress: 0, absent: 0, effectiveHours: 171, overtimeHours: 0 };
const cleanRow = () => buildAttendanceRow({ employeeId: 'E001', employeeName: 'Clean', rc: RC, summary: cleanSummary, approvedLeaveDays: 2, shortageHours: 0, fullDayHours: FD });

// Genuine absence (1) + an attended-day shortfall (2.25h) + OT (5h).
const mixedSummary = { present: 17, half: 1, incomplete: 1, inProgress: 1, absent: 1, effectiveHours: 150, overtimeHours: 5 };
const mixedRow = () => buildAttendanceRow({ employeeId: 'E002', employeeName: 'Mixed', rc: RC, summary: mixedSummary, approvedLeaveDays: 0, shortageHours: 2.25, fullDayHours: FD });

test('1 — the row has EXACTLY the 15 attendance columns, in order, and NO monetary field', () => {
  const keys = Object.keys(cleanRow());
  const expected = [
    'employeeId', 'employeeName', 'calendarDays', 'workingDays', 'presentDays', 'approvedLeaveDays',
    'absentDays', 'halfDays', 'incompleteDays', 'inProgressDays', 'salaryWorkingDays', 'effectiveHours',
    'lopHours', 'shortageHours', 'otHours',
  ];
  assert.deepEqual(keys, expected);
  // No salary/money field may leak onto this attendance sheet.
  for (const banned of ['grossPay', 'netPay', 'otPay', 'professionalTax', 'otherDeductions', 'lopDeduction', 'shortageDeduction']) {
    assert.ok(!(banned in cleanRow()), `${banned} must NOT appear on the attendance sheet`);
  }
});

test('2 — August full month: Calendar Days & Working Days come straight from rc', () => {
  const r = buildAttendanceRow({ employeeId: 'E', employeeName: 'X', rc: { calendar: 31, working: 21 }, summary: cleanSummary, approvedLeaveDays: 0, shortageHours: 0, fullDayHours: FD });
  assert.strictEqual(r.calendarDays, 31);
  assert.strictEqual(r.workingDays, 21);
});

test('3 — approved leave appears in its own column', () => {
  assert.strictEqual(cleanRow().approvedLeaveDays, 2);
});

test('4 — approved leave is NOT counted as absent', () => {
  assert.strictEqual(cleanRow().absentDays, 0);   // 2 approved-leave days, 0 absent
});

test('5 — approved leave does NOT reduce Salary Working Days (salary-protected basis)', () => {
  const r = cleanRow();
  assert.strictEqual(r.salaryWorkingDays, 21);           // = working days, approved leave not subtracted
  assert.notStrictEqual(r.salaryWorkingDays, RC.working - 2);
});

test('6 — genuine absence shows in Absent Days', () => {
  assert.strictEqual(mixedRow().absentDays, 1);
});

test('7 — Half Days shown separately', () => {
  assert.strictEqual(mixedRow().halfDays, 1);
});

test('8 — Incomplete and In Progress are separate columns (past missing punch vs today open)', () => {
  const r = mixedRow();
  assert.strictEqual(r.incompleteDays, 1);
  assert.strictEqual(r.inProgressDays, 1);
});

test('9 — Effective Hours come from attendance (summary.effectiveHours)', () => {
  assert.strictEqual(mixedRow().effectiveHours, 150);
});

test('10 — LOP Hours = genuine absent days × full-day hours (tied to Absent Days)', () => {
  assert.strictEqual(mixedRow().lopHours, 1 * FD);       // 1 absent day → 9h
  assert.strictEqual(cleanRow().lopHours, 0);            // 0 absent (approved leave) → 0h, no LOP
  assert.strictEqual(lopHoursOf(3, FD), 27);
});

test('11 — Shortage Hours carried from the monthly hour-balance, SEPARATE from LOP', () => {
  const r = mixedRow();
  assert.strictEqual(r.shortageHours, 2.25);
  assert.notStrictEqual(r.shortageHours, r.lopHours);   // shortage and LOP are distinct
});

test('12 — OT Hours come from attendance; no OT Pay on this sheet', () => {
  const r = mixedRow();
  assert.strictEqual(r.otHours, 5);
  assert.ok(!('otPay' in r));
});

test('13 — shortage hours populate even with zero absence (attended-day shortfall)', () => {
  const r = buildAttendanceRow({ employeeId: 'E', employeeName: 'X', rc: RC, summary: { ...cleanSummary }, approvedLeaveDays: 0, shortageHours: 4.5, fullDayHours: FD });
  assert.strictEqual(r.absentDays, 0);
  assert.strictEqual(r.lopHours, 0);
  assert.strictEqual(r.shortageHours, 4.5);   // shortage independent of absence — no payroll needed
});
