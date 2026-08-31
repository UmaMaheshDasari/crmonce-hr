/**
 * Salary Working Days (Monthly Attendance Summary, Sheet 3) =
 *   Working Days − approved-leave working-day equivalent.
 *
 * Driven by ACTUAL approved leave (half-day aware), never a fixed absent-based adjustment.
 * These tests exercise approvedLeaveDaysWeighted (the day-math: full/half/weekend/overlap/
 * month-clip) and the caller's approved-only filter (pending/rejected excluded), then assert
 * Salary Working Days = Working − approved leave for each of the 10 required cases.
 *
 * Deterministic config passed via opts (no dependency on the live holiday calendar).
 */
process.env.NODE_ENV = 'test';

const { test } = require('node:test');
const assert = require('node:assert');
const { approvedLeaveDaysWeighted } = require('../src/services/attendance-summary.util');

const AUG = { from: '2026-08-01', to: '2026-08-31' };
const NO_WEEKENDS = { weekOffDays: [], holidays: [] };   // every date is a working day (isolates day-math)
const WORKING_DAYS = 21;   // the example's Working Days for August

const wd = (dateStr) => new Date(`${dateStr}T00:00:00Z`).getUTCDay();   // weekday of a date
const salaryDays = (approvedLeaves, opts = NO_WEEKENDS) =>
  Math.round((WORKING_DAYS - approvedLeaveDaysWeighted(approvedLeaves, AUG.from, AUG.to, opts)) * 100) / 100;
// Mirrors buildRangeSummary's filter: only 'approved' leaves feed the calculation.
const approvedOnly = (leaves) => leaves.filter((l) => l.status === 'approved');
const leave = (from, to, days, status = 'approved') => ({ hr_fromdate: from, hr_todate: to || from, hr_days: days, status });

test('Test 1 — no approved leave → Salary Working Days = 21', () => {
  assert.strictEqual(salaryDays([]), 21);
});

test('Test 2 — one approved full-day leave → 20', () => {
  assert.strictEqual(salaryDays([leave('2026-08-05', null, 1)]), 20);
});

test('Test 3 — two approved full-day leaves → 19', () => {
  assert.strictEqual(salaryDays([leave('2026-08-05', null, 1), leave('2026-08-06', null, 1)]), 19);
});

test('Test 4 — one approved HALF-day leave → 20.5 (not counted as a full day)', () => {
  assert.strictEqual(approvedLeaveDaysWeighted([leave('2026-08-05', null, 0.5)], AUG.from, AUG.to, NO_WEEKENDS), 0.5);
  assert.strictEqual(salaryDays([leave('2026-08-05', null, 0.5)]), 20.5);
});

test('Test 5 — pending leave does NOT reduce Salary Working Days', () => {
  const leaves = [leave('2026-08-05', null, 1, 'pending')];
  assert.strictEqual(salaryDays(approvedOnly(leaves)), 21);
});

test('Test 6 — rejected leave does NOT reduce Salary Working Days', () => {
  const leaves = [leave('2026-08-05', null, 1, 'rejected')];
  assert.strictEqual(salaryDays(approvedOnly(leaves)), 21);
});

test('Test 7 — approved JULY leave does NOT affect August', () => {
  assert.strictEqual(approvedLeaveDaysWeighted([leave('2026-07-20', null, 1)], AUG.from, AUG.to, NO_WEEKENDS), 0);
  assert.strictEqual(salaryDays([leave('2026-07-20', null, 1)]), 21);
});

test('Test 8 — approved SEPTEMBER leave does NOT affect August', () => {
  assert.strictEqual(approvedLeaveDaysWeighted([leave('2026-09-02', null, 1)], AUG.from, AUG.to, NO_WEEKENDS), 0);
  assert.strictEqual(salaryDays([leave('2026-09-02', null, 1)]), 21);
});

test('Test 9 — approved leave on a weekend/non-working day does NOT reduce Salary Working Days', () => {
  const d = '2026-08-09';
  const opts = { weekOffDays: [wd(d)], holidays: [] };   // make that exact day a weekly-off
  assert.strictEqual(approvedLeaveDaysWeighted([leave(d, null, 1)], AUG.from, AUG.to, opts), 0);
});

test('Test 10 — overlapping/duplicate approved leaves are NOT double-counted', () => {
  // Two records covering the SAME working day → counted once (1), not twice.
  const dup = [leave('2026-08-05', '2026-08-05', 1), leave('2026-08-05', '2026-08-05', 1)];
  assert.strictEqual(approvedLeaveDaysWeighted(dup, AUG.from, AUG.to, NO_WEEKENDS), 1);
  // Overlapping multi-day spans sharing dates → each distinct working date counted once.
  const overlap = [leave('2026-08-05', '2026-08-07', 3), leave('2026-08-06', '2026-08-08', 3)];
  assert.strictEqual(approvedLeaveDaysWeighted(overlap, AUG.from, AUG.to, NO_WEEKENDS), 4);   // Aug 5,6,7,8
});

test('Month boundary — a leave spanning Jul→Aug counts ONLY its August working dates', () => {
  // Jul 30 – Aug 3 span; only Aug 1,2,3 fall in August (with no weekends).
  const v = approvedLeaveDaysWeighted([leave('2026-07-30', '2026-08-03', 5)], AUG.from, AUG.to, NO_WEEKENDS);
  assert.strictEqual(v, 3);
});
