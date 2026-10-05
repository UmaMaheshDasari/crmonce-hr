/**
 * Date-level allocation: a working date contributes AT MOST 1.0, split into a WORKED fraction
 * and an APPROVED-LEAVE fraction (approved leave owns its fraction; worked fills the rest).
 *   workedFrac = min(attendanceFrac, 1 − approvedFrac)   [present=1, half_day=0.5, else 0]
 * So a half-day worked + half-day approved leave on the SAME date = 0.5 Present + 0.5 Approved
 * Leave (never a full Half Day + another 0.5). A standalone half-day (no leave) = 0.5 Present +
 * 0.5 standalone Half indicator. Pure (summarizeEmployee), no network.
 */
process.env.NODE_ENV = 'test';
const { test } = require('node:test');
const assert = require('node:assert');
const { summarizeEmployee } = require('../src/services/attendance-summary.util');

const S = (date, status, eff) => ({ date, status, count: status === 'incomplete' ? 1 : 2, effectiveHours: eff ?? (status === 'present' ? 9 : status === 'half_day' ? 4 : 0), breakHours: 0, overtimeHours: 0 });
const amap = (obj) => new Map(Object.entries(obj));

test('1 — full present day → Present 1, Half 0', () => {
  const s = summarizeEmployee([S('2026-09-01', 'present')], { working: 1 });
  assert.strictEqual(s.present, 1);
  assert.strictEqual(s.half, 0);
});

test('3 — standalone half-day (no leave) → Present 0.5, Half 0.5', () => {
  const s = summarizeEmployee([S('2026-09-01', 'half_day')], { working: 1 });
  assert.strictEqual(s.present, 0.5);
  assert.strictEqual(s.half, 0.5);
});

test('5 — half-day worked + half-day approved leave (SAME date) → Present 0.5, Half 0, allocation 1', () => {
  const s = summarizeEmployee([S('2026-09-29', 'half_day')], { working: 1, approvedLeaveByDate: amap({ '2026-09-29': 0.5 }), approvedLeaveDays: 0.5 });
  assert.strictEqual(s.present, 0.5);         // worked half
  assert.strictEqual(s.half, 0);              // covered by approved leave → NOT a standalone Half Day
  assert.ok(s.present + 0.5 <= 1.0000001);    // worked 0.5 + approved 0.5 = 1.0 (no over-count)
});

test('6 — half-day worked + FULL-day approved leave (SAME date) → Present 0, Half 0 (leave owns the day)', () => {
  const s = summarizeEmployee([S('2026-09-22', 'half_day')], { working: 1, approvedLeaveByDate: amap({ '2026-09-22': 1 }), approvedLeaveDays: 1 });
  assert.strictEqual(s.present, 0);           // min(0.5, 1 − 1) = 0
  assert.strictEqual(s.half, 0);
});

test('full present + full-day approved leave on the SAME date → Present 0 (leave owns the day; no >1 allocation)', () => {
  const s = summarizeEmployee([S('2026-09-10', 'present')], { working: 1, approvedLeaveByDate: amap({ '2026-09-10': 1 }), approvedLeaveDays: 1 });
  assert.strictEqual(s.present, 0);
});

test('no date contributes worked+approved > 1.0 for any attendance/leave combination', () => {
  for (const status of ['present', 'half_day', 'incomplete', 'in_progress']) {
    for (const frac of [0, 0.5, 1]) {
      const s = summarizeEmployee([S('2026-09-05', status)], { working: 1, approvedLeaveByDate: amap({ '2026-09-05': frac }), approvedLeaveDays: frac });
      assert.ok(s.present + frac <= 1.0000001, `${status} + approved ${frac}: worked ${s.present} + ${frac} ≤ 1`);
    }
  }
});

test('ANNAM Sep 2026 — Present 16.5, Half 0, Absent 0, Approved 4.5 (worked + approved = 21 working days)', () => {
  const sessions = [];
  // 16 full-present days on dates that are NOT leave dates
  for (const d of ['01', '02', '03', '04', '07', '08', '09', '10', '11', '12', '13', '14', '15', '21', '23', '24']) sessions.push(S(`2026-09-${d}`, 'present'));
  sessions.push(S('2026-09-22', 'half_day', 2.2));   // half worked + FULL approved leave
  sessions.push(S('2026-09-29', 'half_day', 5.32));  // half worked + HALF approved leave
  const approvedByDate = amap({ '2026-09-16': 1, '2026-09-17': 1, '2026-09-18': 1, '2026-09-22': 1, '2026-09-29': 0.5 });
  const approvedTotal = 4.5;   // 3 (16–18) + 1 (22 full) + 0.5 (29 half)
  const s = summarizeEmployee(sessions, { working: 21, approvedLeaveByDate: approvedByDate, approvedLeaveDays: approvedTotal });
  assert.strictEqual(s.present, 16.5);        // 16 full + 0.5 (09-29 worked); 09-22 worked owned by its full leave
  assert.strictEqual(s.half, 0);              // both half-days are covered by approved leave
  assert.strictEqual(s.attended, 18);
  assert.strictEqual(s.absent, 0);            // max(0, 21 − 18 attended − 4.5)
  assert.strictEqual(s.present + approvedTotal, 21);   // no over-allocation
});
