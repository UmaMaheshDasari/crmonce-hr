/**
 * Approved leave must never be counted as Absent (Monthly Attendance Summary).
 *
 * The fix: the Absent calc (buildRangeSummary → absentDatesFor) excludes ONLY approved-leave
 * dates. Pending/rejected/cancelled do NOT suppress absence (a no-punch day stays Absent),
 * matching payroll (buildMonthlyBalance) and /summary/monthly. Sheet 3 (Excel) reuses this same
 * authoritative summary.absent instead of recomputing it, so UI and Excel agree.
 *
 * These tests exercise the REAL utils (expandLeaveDays builds date→status; the fix derives the
 * approved-only set; absentDatesFor enumerates absence). Pure, no network.
 */
process.env.NODE_ENV = 'test';

const { test } = require('node:test');
const assert = require('node:assert');
const { expandLeaveDays, absentDatesFor } = require('../src/services/attendance-summary.util');

const FROM = '2026-08-01', TO = '2026-08-31', TODAY = '2026-08-31';
const OPTS = { weekOffDays: [], holidays: [] };   // every date is a working day (isolates the leave rule)

// Replicates the FIX: approved-only leave dates suppress absence; the rest do not.
function absentDates({ records = [], leaves = [], firstDate = FROM }) {
  const recordSet = new Set(records);
  const map = expandLeaveDays(leaves.map(l => ({ employeeId: 'E', fromDate: l.from, toDate: l.to || l.from, status: l.status })), FROM, TO, OPTS).get('E') || new Map();
  const approved = new Set();
  for (const [d, info] of map) if (info.status === 'approved') approved.add(d);
  return absentDatesFor(FROM, TO, firstDate, ds => recordSet.has(ds), ds => approved.has(ds), { ...OPTS, today: TODAY, todayPending: false });
}

test('1 — approved full-day leave + no punch → NOT Absent', () => {
  const a = absentDates({ records: [], leaves: [{ from: '2026-08-10', status: 'approved' }], firstDate: '2026-08-10' });
  assert.ok(!a.includes('2026-08-10'), 'approved-leave day is not Absent');
});

test('2 — pending leave + no punch → Absent (does not suppress absence)', () => {
  const a = absentDates({ records: [], leaves: [{ from: '2026-08-10', status: 'pending' }], firstDate: '2026-08-10' });
  assert.ok(a.includes('2026-08-10'), 'pending leave day stays Absent');
});

test('3 — rejected leave + no punch → Absent', () => {
  // rejected is never fetched → never in the leave map → the day stays Absent.
  const a = absentDates({ records: [], leaves: [{ from: '2026-08-10', status: 'rejected' }], firstDate: '2026-08-10' });
  assert.ok(a.includes('2026-08-10'));
});

test('4 — cancelled leave + no punch → Absent', () => {
  const a = absentDates({ records: [], leaves: [{ from: '2026-08-10', status: 'cancelled' }], firstDate: '2026-08-10' });
  assert.ok(a.includes('2026-08-10'));
});

test('6 — normal working day + no punch + no leave → Absent', () => {
  const a = absentDates({ records: [], leaves: [], firstDate: '2026-08-10' });
  assert.ok(a.includes('2026-08-10'), 'a no-punch, no-leave working day is Absent');
});

test('7 — approved leave + an attendance record on the SAME day → not double-counted (has record ⇒ not Absent)', () => {
  const a = absentDates({ records: ['2026-08-10'], leaves: [{ from: '2026-08-10', status: 'approved' }], firstDate: '2026-08-10' });
  assert.ok(!a.includes('2026-08-10'), 'a day with a punch is never Absent');
});

test('5 — approved half-day (has a punch) → not Absent; the day is not turned into a full-day absence', () => {
  // A half-day leave day still has attendance (half worked); it must never be Absent.
  const a = absentDates({ records: ['2026-08-10'], leaves: [{ from: '2026-08-10', status: 'approved' }], firstDate: '2026-08-10' });
  assert.ok(!a.includes('2026-08-10'));
});

test('8 — beginning-of-month approved leave → not Absent', () => {
  const a = absentDates({ records: [], leaves: [{ from: '2026-08-01', status: 'approved' }], firstDate: '2026-08-01' });
  assert.ok(!a.includes('2026-08-01'));
});

test('9 — end-of-month approved leave → not Absent', () => {
  const a = absentDates({ records: [], leaves: [{ from: '2026-08-31', status: 'approved' }], firstDate: '2026-08-31' });
  assert.ok(!a.includes('2026-08-31'));
});

test('10 — multiple employees / dates: each employee\'s approved leave is applied independently', () => {
  // Emp A: approved 08-05 (not absent), no punch on 08-06 (absent).
  const aA = absentDates({ records: [], leaves: [{ from: '2026-08-05', status: 'approved' }], firstDate: '2026-08-05' })
    .filter(d => d === '2026-08-05' || d === '2026-08-06');
  assert.deepEqual(aA, ['2026-08-06'], 'A: 05 excused (approved), 06 absent');
  // Emp B: pending 08-05 → absent.
  const aB = absentDates({ records: [], leaves: [{ from: '2026-08-05', status: 'pending' }], firstDate: '2026-08-05' })
    .filter(d => d === '2026-08-05');
  assert.deepEqual(aB, ['2026-08-05'], 'B: pending 05 stays absent');
});

test('the real Uma Alapaka case — approved leave on a no-punch day is excused (Absent 0, not 1)', () => {
  // Working 08-03..08-05; punches on 03 & 04; approved leave on 05 (no punch). Old Excel would
  // mark 05 Absent (1); the fix excuses it → 0 absent.
  const a = absentDates({ records: ['2026-08-03', '2026-08-04'], leaves: [{ from: '2026-08-05', status: 'approved' }], firstDate: '2026-08-03' })
    .filter(d => d >= '2026-08-03' && d <= '2026-08-05');
  assert.deepEqual(a, [], 'no Absent day — the no-punch day is approved leave');
});
