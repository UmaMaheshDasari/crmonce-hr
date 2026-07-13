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
