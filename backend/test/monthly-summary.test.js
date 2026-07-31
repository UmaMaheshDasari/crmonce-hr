/**
 * Monthly Attendance Summary export — column math.
 * Columns: Employee ID | Employee Name | Calendar Days | Working Days | Present | Absent
 *   Working Days = Calendar − week-offs (Sundays) − holidays
 *   Present Days = attended (Present/Late/Early/Overtime/Incomplete/Half Day → ONE present)
 *   Absent Days  = Working − Present − Leave (weekends/holidays/leave excluded)
 * These are exactly the values buildRangeSummary feeds into the .xlsx.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const { rangeCounts, summarizeEmployee } = require('../src/services/attendance-summary.util');

// A 31-day month starting on a Sunday → 5 Sundays, 0 holidays (Sunday-only week-off,
// as the spec's "minus All Sundays"). Oct 2023 = the user's illustrative "July".
const OPTS = { weekOffDays: [0], holidays: [] };   // Sunday only

test('Working Days: 31 calendar − 5 Sundays − 0 holidays = 26', () => {
  const rc = rangeCounts('2023-10-01', '2023-10-31', OPTS);
  assert.strictEqual(rc.calendar, 31);
  assert.strictEqual(rc.weeklyOff, 5);   // 5 Sundays
  assert.strictEqual(rc.holidays, 0);
  assert.strictEqual(rc.working, 26);
});

const attendedDays = (n) => Array.from({ length: n }, () => ({ count: 2, status: 'present' }));

test('Employee A — 26 present → 0 absent', () => {
  const s = summarizeEmployee(attendedDays(26), { working: 26 });
  assert.strictEqual(s.attended, 26);   // Present Days
  assert.strictEqual(s.absent, 0);      // Absent Days
});

test('Employee B — 24 present → 2 absent', () => {
  const s = summarizeEmployee(attendedDays(24), { working: 26 });
  assert.strictEqual(s.attended, 24);
  assert.strictEqual(s.absent, 2);
});

test('Employee C — 25 present → 1 absent', () => {
  const s = summarizeEmployee(attendedDays(25), { working: 26 });
  assert.strictEqual(s.attended, 25);
  assert.strictEqual(s.absent, 1);
});

test('Present is ONE per attended day regardless of status (present/late/incomplete/half)', () => {
  const s = summarizeEmployee([
    { count: 2, status: 'present' },                     // Present
    { count: 2, status: 'present', lateArrivalMin: 30 }, // Late (still present)
    { count: 2, status: 'present', earlyDepartureMin: 20, overtimeHours: 1 }, // Early/Overtime
    { count: 1, status: 'incomplete' },                  // Incomplete
    { count: 2, status: 'half_day' },                    // Half Day
  ], { working: 26 });
  assert.strictEqual(s.attended, 5);    // all five count as ONE Present each
  assert.strictEqual(s.absent, 21);     // 26 − 5
});

test('Approved leave is not counted as Absent (Working − Present − Leave)', () => {
  const s = summarizeEmployee(attendedDays(20), { working: 26, leaveDays: 4 });
  assert.strictEqual(s.attended, 20);
  assert.strictEqual(s.absent, 2);      // 26 − 20 − 4
});

// Salary Working Days = MAX(0, Working − MAX(Absent − 1, 0)). First absent is FREE.
const salaryWorkingDays = (working, absent) => Math.max(0, working - Math.max((absent || 0) - 1, 0));

test('Salary Working Days: first absent free, 2nd+ reduce, never negative', () => {
  assert.strictEqual(salaryWorkingDays(23, 0), 23);   // 0 absent → full
  assert.strictEqual(salaryWorkingDays(23, 1), 23);   // 1 absent → still full (free)
  assert.strictEqual(salaryWorkingDays(23, 2), 22);   // 2 absent → −1
  assert.strictEqual(salaryWorkingDays(23, 3), 21);   // 3 absent → −2
  assert.strictEqual(salaryWorkingDays(23, 5), 19);   // 5 absent → −4
  assert.strictEqual(salaryWorkingDays(23, 30), 0);   // clamped, never negative
});
