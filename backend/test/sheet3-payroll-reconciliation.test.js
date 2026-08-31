/**
 * Sheet 3 — Monthly Attendance + Payroll reconciliation row builder.
 *
 * Proves the recon row (Excel Sheet 3) reads ₹ amounts from the STORED payroll row
 * (never recreating payroll math) and attendance counts from summarizeEmployee, and
 * that the four deduction columns reconcile: PT + LOP + Shortage + Other === Gross − Net.
 *
 * Pure, no network — exercises the real buildReconRow / otherDeductionsOf.
 */
process.env.NODE_ENV = 'test';

const { test } = require('node:test');
const assert = require('node:assert');
const { buildReconRow, otherDeductionsOf, lopHoursOf } = require('../src/services/payroll-recon.util');

const FD = 9;   // full-day expected hours
const RC = { calendar: 31, working: 21 };

// A clean, fully-generated payroll row: Working 21, Present 19, Approved Leave 2, Absent 0.
// Gross 42000; deductions PF 1800 + PT 200 + IncomeTax 0 + LOP 0 + Shortage 0 + Advance 0
// + Other 0 = 2000 → Net 40000.
const cleanSummary = { present: 19, half: 0, incomplete: 0, inProgress: 0, absent: 0, effectiveHours: 171, overtimeHours: 0 };
const cleanRow = {
  hr_gross: 42000, hr_netpay: 40000, hr_pf: 1800, hr_professionaltax: 200, hr_incometax: 0,
  hr_lop: 0, hr_hourdeduction: 0, hr_advance: 0, hr_deductions: 0,
  hr_overtime: 0, hr_presentdays: 19, hr_absentdays: 0, hr_workingdays: 21, hr_paydays: 21,
};
const cleanRecon = () => buildReconRow({
  employeeId: 'E001', employeeName: 'Clean Emp', rc: RC, summary: cleanSummary,
  approvedLeaveDays: 2, payrollRow: cleanRow, shortageHours: 0, fullDayHours: FD,
});

// An employee with genuine absence + an hour shortage: Absent 1 (LOP), shortage 2.25h.
// Gross 42000; PF 1800 + PT 200 + LOP 2000 + Shortage 900 = 4900 → Net 37100.
const mixedSummary = { present: 17, half: 0, incomplete: 0, inProgress: 0, absent: 1, effectiveHours: 150, overtimeHours: 5 };
const mixedRow = {
  hr_gross: 42000, hr_netpay: 37100, hr_pf: 1800, hr_professionaltax: 200, hr_incometax: 0,
  hr_lop: 2000, hr_hourdeduction: 900, hr_advance: 0, hr_deductions: 0,
  hr_overtime: 0, hr_presentdays: 17, hr_absentdays: 1, hr_workingdays: 21, hr_paydays: 20,
};
const mixedRecon = () => buildReconRow({
  employeeId: 'E002', employeeName: 'Mixed Emp', rc: RC, summary: mixedSummary,
  approvedLeaveDays: 1, payrollRow: mixedRow, shortageHours: 2.25, fullDayHours: FD,
});

test('1 — approved leave appears in Approved Leave Days', () => {
  assert.strictEqual(cleanRecon().approvedLeaveDays, 2);
});

test('2 — approved leave does NOT create LOP (hours or ₹)', () => {
  const r = cleanRecon();
  assert.strictEqual(r.lopHours, 0);
  assert.strictEqual(r.lopDeduction, 0);
  assert.strictEqual(r.absentDays, 0);
});

test('3 — approved leave does NOT reduce Salary Working Days (salary protected)', () => {
  const r = cleanRecon();
  // 21 working days, 2 approved leave → Salary Working Days stays 21 (payroll hr_workingdays).
  assert.strictEqual(r.salaryWorkingDays, 21);
  assert.notStrictEqual(r.salaryWorkingDays, RC.working - 2);   // NOT working − approved leave
});

test('4 — genuine absence produces LOP (1 absent day → LOP hours & ₹)', () => {
  const r = mixedRecon();
  assert.strictEqual(r.absentDays, 1);
  assert.strictEqual(r.lopDeduction, 2000);
  assert.ok(r.lopHours > 0);
});

test('5 — LOP Hours = LOP days × full-day hours', () => {
  assert.strictEqual(mixedRecon().lopHours, 1 * FD);
  assert.strictEqual(lopHoursOf(3, FD), 27);
});

test('6 — LOP Deduction matches the payroll row (hr_lop)', () => {
  assert.strictEqual(mixedRecon().lopDeduction, mixedRow.hr_lop);
});

test('7 — Shortage Hours are carried from the monthly-balance value', () => {
  assert.strictEqual(mixedRecon().shortageHours, 2.25);
});

test('8 — Shortage Deduction matches the payroll row (hr_hourdeduction)', () => {
  assert.strictEqual(mixedRecon().shortageDeduction, mixedRow.hr_hourdeduction);
});

test('9 — LOP and Shortage stay SEPARATE (never combined)', () => {
  const r = mixedRecon();
  assert.strictEqual(r.lopDeduction, 2000);
  assert.strictEqual(r.shortageDeduction, 900);
  assert.notStrictEqual(r.lopDeduction, r.lopDeduction + r.shortageDeduction);
});

test('10 — Professional Tax matches the payroll row (hr_professionaltax)', () => {
  assert.strictEqual(mixedRecon().professionalTax, 200);
});

test('11 — Other Deductions = PF + IncomeTax + Advance + Other bucket (non-LOP/shortage/PT)', () => {
  // mixed: PF 1800 + IncomeTax 0 + Advance 0 + Other 0 = 1800.
  assert.strictEqual(mixedRecon().otherDeductions, 1800);
  assert.strictEqual(otherDeductionsOf({ hr_pf: 1800, hr_incometax: 500, hr_advance: 300, hr_deductions: 100 }), 2700);
});

test('11b — deductions reconcile: PT + LOP + Shortage + Other === Gross − Net', () => {
  for (const r of [cleanRecon(), mixedRecon()]) {
    const sum = r.professionalTax + r.lopDeduction + r.shortageDeduction + r.otherDeductions;
    const grossMinusNet = r.grossPay - r.netPay;
    assert.strictEqual(sum, grossMinusNet, `recon ${r.employeeName}: ${sum} vs ${grossMinusNet}`);
  }
});

test('12 — Gross Pay matches the payroll row (hr_gross)', () => {
  assert.strictEqual(mixedRecon().grossPay, 42000);
});

test('13 — OT Hours come from attendance (summary.overtimeHours)', () => {
  assert.strictEqual(mixedRecon().otHours, 5);
});

test('14 — OT Pay respects "Calculate OT Pay = No" (row hr_overtime 0 though OT hours > 0)', () => {
  const r = mixedRecon();
  assert.ok(r.otHours > 0, 'OT hours still displayed');
  assert.strictEqual(r.otPay, 0, 'OT pay is ₹0 per the setting baked into hr_overtime');
  // And when the setting is Yes the stored OT pay flows through unchanged.
  const paid = buildReconRow({ employeeId: 'E', employeeName: 'X', rc: RC, summary: mixedSummary, approvedLeaveDays: 0, payrollRow: { ...mixedRow, hr_overtime: 1250 }, shortageHours: 0, fullDayHours: FD });
  assert.strictEqual(paid.otPay, 1250);
});

test('15 — Net Pay matches the payroll row (hr_netpay)', () => {
  assert.strictEqual(mixedRecon().netPay, 37100);
});

test('16 — no payroll row (month not generated) → money columns null, day counts still from attendance', () => {
  const r = buildReconRow({ employeeId: 'E9', employeeName: 'NoPay', rc: RC, summary: cleanSummary, approvedLeaveDays: 2, payrollRow: null, shortageHours: 0, fullDayHours: FD });
  assert.strictEqual(r.hasPayroll, false);
  for (const k of ['lopDeduction', 'shortageDeduction', 'professionalTax', 'otherDeductions', 'grossPay', 'otPay', 'netPay']) {
    assert.strictEqual(r[k], null, `${k} is null when there is no payroll row`);
  }
  // Attendance-side values still resolve (and Salary Working Days falls back to working days).
  assert.strictEqual(r.presentDays, 19);
  assert.strictEqual(r.approvedLeaveDays, 2);
  assert.strictEqual(r.salaryWorkingDays, RC.working);
});

test('17 — the row exposes exactly the 22 report fields (+ hasPayroll flag) — schema stability', () => {
  const keys = Object.keys(cleanRecon());
  const expected = [
    'employeeId', 'employeeName', 'calendarDays', 'workingDays', 'presentDays', 'approvedLeaveDays',
    'absentDays', 'halfDays', 'incompleteDays', 'inProgressDays', 'salaryWorkingDays', 'effectiveHours',
    'lopHours', 'lopDeduction', 'shortageHours', 'shortageDeduction', 'professionalTax', 'otherDeductions',
    'grossPay', 'otHours', 'otPay', 'netPay', 'hasPayroll',
  ];
  assert.deepEqual(keys, expected);
});
