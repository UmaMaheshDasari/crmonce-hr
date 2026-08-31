/**
 * Summary status buckets must AGREE with the detail-list status filter.
 *
 * Bug: summarizeEmployee lumped 'in_progress' (today's live open session) into the Incomplete
 * count, but the detail list classifies it as 'in_progress' — so the Incomplete card counted a
 * record the Incomplete filter could not retrieve. Fix: in_progress is its OWN bucket
 * (summary.inProgress); Incomplete is only genuine finalized incompletes. Same computeSession
 * status drives the summary, the list filter and the Excel — so counts == filtered records.
 */
process.env.NODE_ENV = 'test';

const { test } = require('node:test');
const assert = require('node:assert');
const { computeSession } = require('../src/services/attendance.util');
const { summarizeEmployee } = require('../src/services/attendance-summary.util');

const PAST = '2026-07-06';
// Live (no date) session → in_progress; past session → finalized.
const live = (punches) => computeSession(punches);
const past = (punches) => computeSession(punches, 'GEN', { date: PAST });

test('5/9 — today IN with no OUT → IN PROGRESS bucket (not Incomplete, not Half Day, not Absent)', () => {
  const c = live(['09:00']);
  assert.strictEqual(c.status, 'in_progress');
  const s = summarizeEmployee([{ ...c, date: PAST }], { working: 1 });
  assert.strictEqual(s.inProgress, 1);
  assert.strictEqual(s.incomplete, 0);
  assert.strictEqual(s.half, 0);
  assert.strictEqual(s.absent, 0);   // has a punch → attended
});

test('4/8/10 — past missing final OUT (4h confirmed) → INCOMPLETE bucket, still visible', () => {
  const c = past(['09:00', '13:00', '14:00']);   // 09-13 = 4h, open 3rd → finalized incomplete
  assert.strictEqual(c.status, 'incomplete');
  assert.strictEqual(c.effectiveHours, 4);
  const s = summarizeEmployee([c], { working: 1 });
  assert.strictEqual(s.incomplete, 1);
  assert.strictEqual(s.inProgress, 0);
});

test('1/3 — present and half-day land in their own buckets', () => {
  const s = summarizeEmployee([past(['09:00', '18:00']), past(['09:00', '13:00'])], { working: 2 });
  assert.strictEqual(s.present, 1);
  assert.strictEqual(s.half, 1);
  assert.strictEqual(s.incomplete, 0);
  assert.strictEqual(s.inProgress, 0);
});

test('6/7 — summary Incomplete/InProgress counts EQUAL the number of records with each status (filter agreement)', () => {
  const sessions = [
    { ...live(['08:55']), date: '2026-08-31' },          // in_progress (today live)
    { ...live(['08:58']), date: '2026-08-31' },          // in_progress
    past(['09:00', '13:00', '14:00']),                   // incomplete (past missing OUT)
    past(['09:00', '18:00']),                            // present
  ];
  const s = summarizeEmployee(sessions, { working: 4 });
  // What the LIST filter would return: records whose computed status === the filter value.
  const listCount = (st) => sessions.filter(c => c.status === st).length;
  assert.strictEqual(s.inProgress, listCount('in_progress'));   // 2 == 2
  assert.strictEqual(s.incomplete, listCount('incomplete'));    // 1 == 1
  assert.strictEqual(s.present, listCount('present'));          // 1 == 1
  assert.strictEqual(s.inProgress, 2);
  assert.strictEqual(s.incomplete, 1);
});

test('11/12 — an in_progress session is never Absent (a working employee keeps their punch credit)', () => {
  const s = summarizeEmployee([{ ...live(['09:00']), date: '2026-08-31' }], { working: 1, leaveDays: 0 });
  assert.strictEqual(s.absent, 0);
  assert.strictEqual(s.inProgress, 1);
});
