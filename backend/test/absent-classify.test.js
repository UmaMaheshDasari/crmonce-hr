/**
 * classifyEmployeeDays — the SINGLE source of truth for Absent across the whole HR
 * system (dashboard cards, summary cards, reports, Excel export, absentee rows).
 *
 * The key guarantee (business rule #9): the Absent COUNT (out.absent) always equals
 * the number of Absent ROWS (out.absentDates.length) because both come from the very
 * same day-by-day walk. Every test below re-asserts that invariant.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const { classifyEmployeeDays } = require('../src/services/attendance-summary.util');
const { computeSession } = require('../src/services/attendance.util');

const OPTS = { weekOffDays: [0, 6], holidays: [] };           // Sat + Sun off, no holidays
const sess = (pairs) => new Map(pairs);                       // [['2026-07-01', session], ...]

// Every classification must satisfy these accounting identities.
function assertConsistent(r) {
  assert.strictEqual(r.absent, r.absentDates.length, 'Absent count must equal the number of Absent rows');
  assert.strictEqual(r.attended, r.present + r.half + r.incomplete, 'attended = present + half + incomplete');
  assert.strictEqual(r.working, r.attended + r.leave + r.absent, 'working = attended + leave + absent');
}

test('Present — a completed working day is Present, never Absent', () => {
  const r = classifyEmployeeDays('2026-07-01', '2026-07-01', '2026-07-01',
    sess([['2026-07-01', { count: 2, status: 'present', effectiveHours: 9 }]]), new Set(), OPTS);
  assert.strictEqual(r.present, 1);
  assert.strictEqual(r.attended, 1);
  assert.strictEqual(r.absent, 0);
  assertConsistent(r);
});

test('Absent — a working day with no punch and no leave', () => {
  const r = classifyEmployeeDays('2026-07-01', '2026-07-01', '2026-07-01', sess([]), new Set(), OPTS);
  assert.strictEqual(r.absent, 1);
  assert.deepStrictEqual(r.absentDates, ['2026-07-01']);
  assert.strictEqual(r.working, 1);
  assertConsistent(r);
});

test('Approved Leave — never Absent', () => {
  const r = classifyEmployeeDays('2026-07-01', '2026-07-01', '2026-07-01',
    sess([]), new Set(['2026-07-01']), OPTS);
  assert.strictEqual(r.leave, 1);
  assert.strictEqual(r.absent, 0);
  assertConsistent(r);
});

test('Weekend — Saturday & Sunday are never Absent (excluded from working days)', () => {
  const r = classifyEmployeeDays('2026-07-04', '2026-07-05', '2026-07-04', sess([]), new Set(), OPTS); // Sat+Sun
  assert.strictEqual(r.working, 0);
  assert.strictEqual(r.absent, 0);
  assertConsistent(r);
});

test('Holiday — a company holiday is never Absent (excluded from working days)', () => {
  const r = classifyEmployeeDays('2026-07-01', '2026-07-01', '2026-07-01',
    sess([]), new Set(), { weekOffDays: [0, 6], holidays: ['2026-07-01'] });
  assert.strictEqual(r.working, 0);
  assert.strictEqual(r.absent, 0);
  assertConsistent(r);
});

test('Half Day — counted as Half Day, not Absent', () => {
  const r = classifyEmployeeDays('2026-07-01', '2026-07-01', '2026-07-01',
    sess([['2026-07-01', { count: 2, status: 'half_day', effectiveHours: 4 }]]), new Set(), OPTS);
  assert.strictEqual(r.half, 1);
  assert.strictEqual(r.attended, 1);
  assert.strictEqual(r.absent, 0);
  assertConsistent(r);
});

test('Incomplete — counted as Incomplete, not Absent', () => {
  const r = classifyEmployeeDays('2026-07-01', '2026-07-01', '2026-07-01',
    sess([['2026-07-01', { count: 1, status: 'incomplete', attendanceIssue: 'Missing Check Out' }]]), new Set(), OPTS);
  assert.strictEqual(r.incomplete, 1);
  assert.strictEqual(r.absent, 0);
  assertConsistent(r);
});

test('Missing Punch — single punch surfaces a missing-punch detail, never Absent', () => {
  // Realistic session straight from computeSession (a lone check-in).
  const c = computeSession(['09:15']);
  assert.strictEqual(c.status, 'incomplete');
  const r = classifyEmployeeDays('2026-07-01', '2026-07-01', '2026-07-01',
    sess([['2026-07-01', { ...c }]]), new Set(), OPTS);
  assert.strictEqual(r.incomplete, 1);
  assert.strictEqual(r.absent, 0);
  assert.strictEqual(r.missingPunchDetails.length, 1);
  assert.match(r.missingPunchDetails[0], /Missing Check Out/);
  assertConsistent(r);
});

test('No attendance history (firstDate null) — 0 working days, never Absent', () => {
  const r = classifyEmployeeDays('2026-07-01', '2026-07-31', null, sess([]), new Set(), OPTS);
  assert.strictEqual(r.working, 0);
  assert.strictEqual(r.absent, 0);
  assert.deepStrictEqual(r.absentDates, []);
});

test('First punch mid-range — days before the first punch are NOT Absent', () => {
  // Range starts 01 Jul but the employee\'s first punch is 06 Jul. 01–03 Jul are
  // working days that must be ignored (the old /absentees path wrongly counted them).
  const r = classifyEmployeeDays('2026-07-01', '2026-07-08', '2026-07-06',
    sess([['2026-07-06', { count: 2, status: 'present', effectiveHours: 9 }]]), new Set(), OPTS);
  // Working days from 06 Jul: Mon 06, Tue 07, Wed 08 = 3 (01–03 excluded, 04–05 weekend).
  assert.strictEqual(r.working, 3);
  assert.strictEqual(r.present, 1);
  assert.strictEqual(r.absent, 2);                       // 07 + 08 Jul, NOT 01–03
  assert.deepStrictEqual(r.absentDates, ['2026-07-07', '2026-07-08']);
  assertConsistent(r);
});

test('Mixed Month — Present/Half/Incomplete/Leave/Absent all reconcile; count = rows', () => {
  // First punch 06 Jul; range 01–15 Jul; today assumed >= 15 Jul (capTo = 15 Jul).
  const r = classifyEmployeeDays('2026-07-01', '2026-07-15', '2026-07-06',
    sess([
      ['2026-07-06', { count: 2, status: 'present', effectiveHours: 9 }],
      ['2026-07-07', { count: 2, status: 'present', effectiveHours: 9 }],
      ['2026-07-08', { count: 2, status: 'half_day', effectiveHours: 4 }],
      ['2026-07-09', { count: 1, status: 'incomplete', attendanceIssue: 'Missing Check Out' }],
      ['2026-07-15', { count: 2, status: 'present', effectiveHours: 9 }],
    ]),
    new Set(['2026-07-10']),                              // approved leave on 10 Jul
    OPTS);

  // Working days 06–15 Jul excl weekends (11,12) = 06,07,08,09,10,13,14,15 → 8.
  assert.strictEqual(r.working, 8);
  assert.strictEqual(r.present, 3);                       // 06, 07, 15
  assert.strictEqual(r.half, 1);                          // 08
  assert.strictEqual(r.incomplete, 1);                    // 09
  assert.strictEqual(r.leave, 1);                         // 10
  assert.strictEqual(r.absent, 2);                        // 13, 14
  assert.deepStrictEqual(r.absentDates, ['2026-07-13', '2026-07-14']);
  assertConsistent(r);
});

test('Card total equals Absent rows across MULTIPLE employees (the #9 guarantee)', () => {
  // Two employees classified independently, then aggregated exactly as
  // buildRangeSummary / the /stats card do.
  const empA = classifyEmployeeDays('2026-07-01', '2026-07-03', '2026-07-01',
    sess([['2026-07-01', { count: 2, status: 'present', effectiveHours: 9 }]]), new Set(), OPTS); // 02,03 absent
  const empB = classifyEmployeeDays('2026-07-01', '2026-07-03', '2026-07-02',
    sess([]), new Set(['2026-07-02']), OPTS);            // 02 leave, 03 absent

  const cardAbsent = empA.absent + empB.absent;                                  // the summary card number
  const rows = [...empA.absentDates, ...empB.absentDates];                       // the Absent table rows
  assert.strictEqual(cardAbsent, rows.length, 'summary card Absent must equal the number of Absent rows');
  assert.strictEqual(cardAbsent, 3);                                             // A:02,03  B:03
});
