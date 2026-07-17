/**
 * Absent calculation rules — a working day with NO attendance activity and no
 * approved leave is Absent; any punch (even one) is never Absent; Saturday/
 * Sunday/Holiday are excluded from Working Days.
 * Single source of truth: computeSession + summarizeEmployee + rangeCounts
 * (the same functions the /stats cards and the Excel export use).
 */
const { test } = require('node:test');
const assert = require('node:assert');
const { computeSession } = require('../src/services/attendance.util');
const { rangeCounts, summarizeEmployee } = require('../src/services/attendance-summary.util');

// A day's session from raw punches (default GENERAL 09:00–18:00 shift).
const day = (date, punches) => ({ ...computeSession(punches), date });

test('Normal Present → attended, not Absent', () => {
  const s = summarizeEmployee([day('2026-07-06', ['09:00', '18:00'])], { working: 1 });
  assert.strictEqual(s.present, 1);
  assert.strictEqual(s.attended, 1);
  assert.strictEqual(s.absent, 0);
});

test('Device Punch only (single IN) → Incomplete, NOT Absent', () => {
  const s = summarizeEmployee([day('2026-07-06', ['09:00'])], { working: 1 });
  assert.strictEqual(s.incomplete, 1);
  assert.strictEqual(s.attended, 1);
  assert.strictEqual(s.absent, 0);
});

test('Web Check-in only → Incomplete (Missing Check Out), NOT Absent', () => {
  const c = computeSession(['09:15']);
  assert.strictEqual(c.status, 'incomplete');
  assert.strictEqual(c.attendanceIssue, 'Missing Check Out');
  assert.strictEqual(summarizeEmployee([{ ...c, date: '2026-07-06' }], { working: 1 }).absent, 0);
});

test('Web Check-out only (OUT first) → Incomplete (Missing Check In), NOT Absent', () => {
  const c = computeSession([{ t: '18:00', d: 'out' }]);
  assert.strictEqual(c.status, 'incomplete');
  assert.strictEqual(c.attendanceIssue, 'Missing Check In');
  const s = summarizeEmployee([{ ...c, date: '2026-07-06' }], { working: 1 });
  assert.strictEqual(s.attended, 1);
  assert.strictEqual(s.absent, 0);
});

test('Single Punch → Incomplete with a missing-punch detail line', () => {
  const s = summarizeEmployee([day('2026-07-06', ['09:00'])], { working: 1 });
  assert.strictEqual(s.incomplete, 1);
  assert.deepStrictEqual(s.missingPunchDetails, ['06 Jul 2026 – Missing Check Out']);
});

test('No Punch on a working day → Absent', () => {
  const s = summarizeEmployee([], { working: 1 });
  assert.strictEqual(s.attended, 0);
  assert.strictEqual(s.absent, 1);
});

test('Saturday & Sunday are Weekly Off, excluded from Working Days (never Absent)', () => {
  const rc = rangeCounts('2026-07-04', '2026-07-05', { weekOffDays: [0, 6], holidays: [] }); // Sat + Sun
  assert.strictEqual(rc.weeklyOff, 2);
  assert.strictEqual(rc.working, 0);
  assert.strictEqual(summarizeEmployee([], { working: rc.working }).absent, 0);
});

test('Company Holiday excluded from Working Days (never Absent)', () => {
  const rc = rangeCounts('2026-07-15', '2026-07-15', { weekOffDays: [0, 6], holidays: ['2026-07-15'] });
  assert.strictEqual(rc.holidays, 1);
  assert.strictEqual(rc.working, 0);
  assert.strictEqual(summarizeEmployee([], { working: rc.working }).absent, 0);
});

test('Approved Leave is Leave, never Absent', () => {
  assert.strictEqual(summarizeEmployee([], { working: 5, leaveDays: 5 }).absent, 0);   // all leave
  assert.strictEqual(summarizeEmployee([], { working: 5, leaveDays: 2 }).absent, 3);   // 3 truly absent
});

test('Future working days are NOT counted as Absent (only up to today)', () => {
  const full = rangeCounts('2026-07-01', '2026-07-31', { weekOffDays: [0, 6], holidays: [] }).working;      // whole month
  const elapsed = rangeCounts('2026-07-01', '2026-07-10', { weekOffDays: [0, 6], holidays: [] }).working;   // up to the 10th
  assert.ok(elapsed < full, 'elapsed working days < full-month working days');
  // No punches yet → Absent = ELAPSED working days, never the future ones.
  assert.strictEqual(summarizeEmployee([], { working: elapsed }).absent, elapsed);
});

test('Mixed month reconciles: Absent = Working − Attended − Leave', () => {
  const sessions = [
    day('2026-07-01', ['09:00', '18:00']),  // present
    day('2026-07-02', ['09:00', '18:00']),  // present
    day('2026-07-03', ['09:00']),           // incomplete — still attended, not absent
  ];
  const s = summarizeEmployee(sessions, { working: 22, leaveDays: 2 });
  assert.strictEqual(s.present, 2);
  assert.strictEqual(s.incomplete, 1);
  assert.strictEqual(s.attended, 3);
  assert.strictEqual(s.absent, 17);         // 22 − 3 attended − 2 leave
});
