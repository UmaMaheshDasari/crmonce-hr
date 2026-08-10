const { test } = require('node:test');
const assert = require('node:assert');
const { rangeCounts, summarizeEmployee } = require('../src/services/attendance-summary.util');

test('rangeCounts: July 2026, week-off Sat+Sun, no holidays → 31 cal, 8 off, 23 working', () => {
  const rc = rangeCounts('2026-07-01', '2026-07-31', { weekOffDays: [0, 6], holidays: [] });
  assert.strictEqual(rc.calendar, 31);
  assert.strictEqual(rc.weeklyOff, 8);   // Sat 4,11,18,25 + Sun 5,12,19,26
  assert.strictEqual(rc.holidays, 0);
  assert.strictEqual(rc.working, 23);    // 31 - 0 - 8
});

test('rangeCounts: a weekday holiday reduces working days', () => {
  const rc = rangeCounts('2026-07-01', '2026-07-31', { weekOffDays: [0, 6], holidays: ['2026-07-15'] });
  assert.strictEqual(rc.holidays, 1);
  assert.strictEqual(rc.weeklyOff, 8);
  assert.strictEqual(rc.working, 22);    // 31 - 1 - 8
});

test('rangeCounts: holiday on a weekend is counted once (as holiday)', () => {
  const rc = rangeCounts('2026-07-01', '2026-07-31', { weekOffDays: [0, 6], holidays: ['2026-07-04'] }); // Sat
  assert.strictEqual(rc.holidays, 1);
  assert.strictEqual(rc.weeklyOff, 7);   // that Saturday now a holiday, not a week-off
  assert.strictEqual(rc.working, 23);    // 31 - 1 - 7 (unchanged)
});

test('summarizeEmployee: counts + absent = working - attended - leave', () => {
  const sessions = [
    { count: 2, status: 'present', effectiveHours: 9, breakHours: 1, overtimeHours: 0 },
    { count: 2, status: 'present', effectiveHours: 8, breakHours: 0.5, overtimeHours: 0 },
    { count: 2, status: 'half_day', effectiveHours: 3, breakHours: 0, overtimeHours: 0 },
    { count: 1, status: 'incomplete', effectiveHours: 0, breakHours: 0, overtimeHours: 0 },
  ];
  const s = summarizeEmployee(sessions, { working: 23, leaveDays: 1 });
  assert.strictEqual(s.present, 2);
  assert.strictEqual(s.half, 1);
  assert.strictEqual(s.incomplete, 1);
  assert.strictEqual(s.attended, 4);
  assert.strictEqual(s.absent, 18);       // 23 - 4 - 1
  assert.strictEqual(s.effectiveHours, 20);
  assert.strictEqual(s.breakHours, 1.5);
});

test('summarizeEmployee: no attendance → working days absent (minus leave)', () => {
  const s = summarizeEmployee([], { working: 23, leaveDays: 2 });
  assert.strictEqual(s.attended, 0);
  assert.strictEqual(s.absent, 21);
});

test('summarizeEmployee: absent never negative', () => {
  const sessions = Array.from({ length: 25 }, () => ({ count: 2, status: 'present', effectiveHours: 9 }));
  assert.strictEqual(summarizeEmployee(sessions, { working: 23, leaveDays: 0 }).absent, 0);
});

test('rule 8: a punch day (even 0 effective) is never absent', () => {
  const s = summarizeEmployee([{ count: 2, status: 'absent', effectiveHours: 0 }], { working: 5, leaveDays: 0 });
  assert.strictEqual(s.attended, 1);
  assert.strictEqual(s.absent, 4);        // 5 - 1 - 0
});

test('missingPunchDetails lists incomplete dates + issue; None when clean', () => {
  const sessions = [
    { count: 2, status: 'present', effectiveHours: 9, date: '2026-07-06' },
    { count: 1, status: 'incomplete', effectiveHours: 0, date: '2026-07-05', attendanceIssue: 'Missing Check Out' },
    { count: 1, status: 'incomplete', effectiveHours: 0, date: '2026-07-11', attendanceIssue: 'Missing Check In' },
  ];
  const s = summarizeEmployee(sessions, { working: 23, leaveDays: 0 });
  assert.strictEqual(s.incomplete, 2);
  assert.deepStrictEqual(s.missingPunchDetails, ['05 Jul 2026 – Missing Check Out', '11 Jul 2026 – Missing Check In']);
  assert.strictEqual(s.absent, 20);        // 23 - 3 attended - 0
  const clean = summarizeEmployee([{ count: 2, status: 'present', date: '2026-07-01' }], { working: 5 });
  assert.deepStrictEqual(clean.missingPunchDetails, []);
});

// ── Absent-before-grace + per-shift eligibility (spec §4/§7/§8) ──────────────
const { absentDatesFor, gracePassedToday } = require('../src/services/attendance-summary.util');
const OPTS = { weekOffDays: [0, 6], holidays: ['2026-07-15'] };
const min = (h, m) => h * 60 + (m || 0);

test('gracePassedToday: different shifts evaluated independently', () => {
  const A = { start: '09:00' }, B = { start: '10:00' }, C = { start: '08:30' };
  // 09:16 now: A(09:00+15=09:15) passed; B(10:00+15) not; C(08:30+10=08:40) passed.
  const now = min(9, 16);
  assert.strictEqual(gracePassedToday(A, 15, now), true);
  assert.strictEqual(gracePassedToday(B, 15, now), false);
  assert.strictEqual(gracePassedToday(C, 10, now), true);
});

test('gracePassedToday: before / exactly-at / after grace', () => {
  const A = { start: '09:00' };
  assert.strictEqual(gracePassedToday(A, 15, min(9, 10)), false);  // 09:10 before → Pending
  assert.strictEqual(gracePassedToday(A, 15, min(9, 15)), false);  // 09:15 exactly → still Pending/Normal
  assert.strictEqual(gracePassedToday(A, 15, min(9, 16)), true);   // 09:16 after → Absent-eligible
});

test('gracePassedToday: night / unknown shift is always eligible (never hidden)', () => {
  assert.strictEqual(gracePassedToday({ start: '22:00', isNight: true }, 15, min(1, 0)), true);
  assert.strictEqual(gracePassedToday(null, 15, min(0, 0)), true);
});

test('absentDatesFor: enumerates working days with no record and no leave', () => {
  const dates = absentDatesFor('2026-07-01', '2026-07-10', '2026-07-01',
    ds => ['2026-07-01', '2026-07-02'].includes(ds),   // has record
    ds => ds === '2026-07-03',                          // on leave
    OPTS);
  // Working days Jul 1–10 (excl Sat 4, Sun 5): 1,2,3,6,7,8,9,10. Minus record(1,2) + leave(3).
  assert.deepStrictEqual(dates, ['2026-07-06', '2026-07-07', '2026-07-08', '2026-07-09', '2026-07-10']);
});

test('absentDatesFor: skips holiday (Jul 15) and weekly-offs', () => {
  const dates = absentDatesFor('2026-07-13', '2026-07-19', '2026-07-13', () => false, () => false, OPTS);
  // Jul 13 Mon,14 Tue,15 HOLIDAY,16 Wed,17 Thu (18 Sat,19 Sun off). Skips 15,18,19.
  assert.deepStrictEqual(dates, ['2026-07-13', '2026-07-14', '2026-07-16', '2026-07-17']);
});

test('absentDatesFor: nothing before the first attendance date', () => {
  const dates = absentDatesFor('2026-07-01', '2026-07-10', '2026-07-08', () => false, () => false, OPTS);
  assert.deepStrictEqual(dates, ['2026-07-08', '2026-07-09', '2026-07-10']);  // 6,7 excluded (before first date)
});

test('absentDatesFor: TODAY is skipped when todayPending (pre-grace), counted otherwise', () => {
  const args = ['2026-07-06', '2026-07-08', '2026-07-06', () => false, () => false];
  const pending = absentDatesFor(...args, { ...OPTS, today: '2026-07-08', todayPending: true });
  const passed = absentDatesFor(...args, { ...OPTS, today: '2026-07-08', todayPending: false });
  assert.deepStrictEqual(pending, ['2026-07-06', '2026-07-07']);               // today (08) excluded
  assert.deepStrictEqual(passed, ['2026-07-06', '2026-07-07', '2026-07-08']);  // today included
});
