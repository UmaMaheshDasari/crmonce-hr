/**
 * Request-list month filter — filters by SUBMISSION date (createdon) in IST, combined
 * with the employee + status filters. Covers IST month boundaries and year boundaries.
 * Run: `node --test src/utils/leave-month-filter.test.js`
 */
import test from 'node:test';
import assert from 'node:assert';
import {
  MONTH_OPTIONS, submissionMonthIST, leaveMatchesMonth, filterLeavesByMonth,
} from './leave-month-filter.js';
import { hrLeaveListParams } from './leave-list-query.js';

const row = (id, createdon) => ({ hr_hrleaveid: id, createdon });

// IST = UTC+5:30. These UTC instants sit exactly on IST month edges.
const IST_NOV1_START   = '2026-10-31T18:30:00Z'; // IST 2026-11-01 00:00 → Nov
const IST_OCT31_LAST   = '2026-10-31T18:29:00Z'; // IST 2026-10-31 23:59 → Oct
const IST_NOV30_LAST   = '2026-11-30T18:29:59Z'; // IST 2026-11-30 23:59 → Nov
const IST_DEC1_START   = '2026-11-30T18:30:00Z'; // IST 2026-12-01 00:00 → Dec
const IST_JAN1_2027     = '2026-12-31T18:30:00Z'; // IST 2027-01-01 00:00 → Jan 2027
const IST_DEC31_2026    = '2026-12-31T18:29:00Z'; // IST 2026-12-31 23:59 → Dec 2026

// ── Dropdown options ─────────────────────────────────────────────────────────
test('MONTH_OPTIONS: All Months + 12 months, in order', () => {
  assert.strictEqual(MONTH_OPTIONS.length, 13);
  assert.deepStrictEqual(MONTH_OPTIONS[0], { value: '', label: 'All Months' });
  assert.deepStrictEqual(MONTH_OPTIONS.slice(1).map(m => m.value), [1,2,3,4,5,6,7,8,9,10,11,12]);
  assert.strictEqual(MONTH_OPTIONS[11].label, 'November');
});

// ── IST month resolution ───────────────────────────────────────────────────
test('submissionMonthIST resolves the IST calendar month, not UTC', () => {
  assert.deepStrictEqual(submissionMonthIST(IST_NOV1_START), { year: 2026, month: 11 });
  assert.deepStrictEqual(submissionMonthIST(IST_OCT31_LAST), { year: 2026, month: 10 });
  assert.strictEqual(submissionMonthIST(''), null);
  assert.strictEqual(submissionMonthIST('not-a-date'), null);
  assert.strictEqual(submissionMonthIST(undefined), null);
});

// ── All Months = no filter ───────────────────────────────────────────────────
test('month "" (All Months) → every row matches, including rows with no createdon', () => {
  assert.strictEqual(leaveMatchesMonth(row('a', IST_NOV1_START), { year: 2026, month: '' }), true);
  assert.strictEqual(leaveMatchesMonth(row('b', undefined), { year: 2026, month: '' }), true);
});

// ── Boundary cases: first and last day of a month (IST) ──────────────────────
test('first instant of IST November matches November, not October', () => {
  assert.strictEqual(leaveMatchesMonth(row('a', IST_NOV1_START), { year: 2026, month: 11 }), true);
  assert.strictEqual(leaveMatchesMonth(row('a', IST_NOV1_START), { year: 2026, month: 10 }), false);
});

test('last instant of IST October stays in October (one minute earlier)', () => {
  assert.strictEqual(leaveMatchesMonth(row('a', IST_OCT31_LAST), { year: 2026, month: 10 }), true);
  assert.strictEqual(leaveMatchesMonth(row('a', IST_OCT31_LAST), { year: 2026, month: 11 }), false);
});

test('last instant of IST November matches November; first of December does not', () => {
  assert.strictEqual(leaveMatchesMonth(row('a', IST_NOV30_LAST), { year: 2026, month: 11 }), true);
  assert.strictEqual(leaveMatchesMonth(row('b', IST_DEC1_START), { year: 2026, month: 11 }), false);
  assert.strictEqual(leaveMatchesMonth(row('b', IST_DEC1_START), { year: 2026, month: 12 }), true);
});

// ── Year boundary ────────────────────────────────────────────────────────────
test('year boundary: IST Jan 1 2027 is Jan-2027, not Dec-2026', () => {
  assert.strictEqual(leaveMatchesMonth(row('a', IST_JAN1_2027), { year: 2027, month: 1 }), true);
  assert.strictEqual(leaveMatchesMonth(row('a', IST_JAN1_2027), { year: 2026, month: 12 }), false);
  assert.strictEqual(leaveMatchesMonth(row('b', IST_DEC31_2026), { year: 2026, month: 12 }), true);
  assert.strictEqual(leaveMatchesMonth(row('b', IST_DEC31_2026), { year: 2027, month: 1 }), false);
});

test('same month, different year does not match (year matters)', () => {
  const novPrevYear = '2025-11-10T06:00:00Z';
  assert.strictEqual(leaveMatchesMonth(row('a', novPrevYear), { year: 2026, month: 11 }), false);
  assert.strictEqual(leaveMatchesMonth(row('a', novPrevYear), { year: 2025, month: 11 }), true);
});

test('row with missing/invalid createdon never matches a specific month', () => {
  assert.strictEqual(leaveMatchesMonth(row('a', undefined), { year: 2026, month: 11 }), false);
  assert.strictEqual(leaveMatchesMonth(row('a', 'nope'), { year: 2026, month: 11 }), false);
});

// ── filterLeavesByMonth over a mixed dataset ─────────────────────────────────
const DATASET = [
  row('oct', IST_OCT31_LAST),   // Oct 2026
  row('nov1', IST_NOV1_START),  // Nov 2026
  row('nov2', IST_NOV30_LAST),  // Nov 2026
  row('dec', IST_DEC1_START),   // Dec 2026
  row('none', undefined),       // no submission date
];

test('filterLeavesByMonth: November keeps only the two November rows', () => {
  const got = filterLeavesByMonth(DATASET, { year: 2026, month: 11 }).map(r => r.hr_hrleaveid);
  assert.deepStrictEqual(got, ['nov1', 'nov2']);
});

test('filterLeavesByMonth: All Months returns the full set (new array)', () => {
  const got = filterLeavesByMonth(DATASET, { year: 2026, month: '' });
  assert.strictEqual(got.length, DATASET.length);
  assert.notStrictEqual(got, DATASET);           // copy, not the same reference
});

test('filterLeavesByMonth: empty / missing inputs are safe', () => {
  assert.deepStrictEqual(filterLeavesByMonth(), []);
  assert.deepStrictEqual(filterLeavesByMonth(undefined, { year: 2026, month: 11 }), []);
});

// ── Combined filters are independent (employee+status via params, month via list) ──
test('month filter is orthogonal to the employee/status request params', () => {
  // Request params depend only on (status, employeeId); month never leaks into them.
  assert.deepStrictEqual(hrLeaveListParams('pending', 'emp-9'), { status: 'pending', employeeId: 'emp-9' });
  assert.deepStrictEqual(hrLeaveListParams('approved', ''), { status: 'approved', employeeId: undefined });
  // And the month filter narrows whatever rows those params produced, independently.
  const novForEmp = filterLeavesByMonth(DATASET, { year: 2026, month: 11 }).map(r => r.hr_hrleaveid);
  assert.deepStrictEqual(novForEmp, ['nov1', 'nov2']);
});

test('combined examples: All Months vs November produce different subsets of the same fetch', () => {
  const all = filterLeavesByMonth(DATASET, { year: 2026, month: '' }).length;      // All
  const nov = filterLeavesByMonth(DATASET, { year: 2026, month: 11 }).length;      // November
  assert.strictEqual(all, 5);
  assert.strictEqual(nov, 2);
});
