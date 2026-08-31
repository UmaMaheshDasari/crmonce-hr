/**
 * Optional "Include Pending Leave" in the Absent view (/attendance/absentees).
 *
 * ACTUAL Absent = active employee on a working day with NO record and NO approved/pending leave
 * (pending is NOT an actual Absent). The `includePending` toggle ADDS pending-leave rows (status
 * 'leave_pending', never 'absent') for pending-leave working dates with no record — same scope &
 * date range. It NEVER changes the actual-Absent set or the summary counts.
 *
 * This models the /absentees handler's exact two-part row construction (absent rows via the
 * approved+pending exclusion; optional pending rows when the toggle is on). Pure, no network.
 */
process.env.NODE_ENV = 'test';

const { test } = require('node:test');
const assert = require('node:assert');
const { absentDatesFor, expandLeaveDays } = require('../src/services/attendance-summary.util');

const D = '2026-08-31';
const OPTS = { weekOffDays: [], holidays: [] };
const WORKDATES = [D];

// Build the /absentees rows exactly as the handler does.
function absenteeRows({ employees, records = {}, leaves = {}, includePending = false }) {
  // records[empId] = Set(dates with a punch); leaves[empId] = [{from,to,status}]
  const rows = [];
  // onLeave = approved+pending (both suppress actual Absent); pendingSet = pending only.
  const perEmp = {};
  for (const e of employees) {
    const map = expandLeaveDays((leaves[e.id] || []).map(l => ({ employeeId: e.id, fromDate: l.from, toDate: l.to || l.from, status: l.status })), D, D, OPTS).get(e.id) || new Map();
    const onLeave = new Set(map.keys());
    const pending = new Set([...map].filter(([, v]) => v.status === 'pending').map(([d]) => d));
    perEmp[e.id] = { onLeave, pending };
  }
  // Actual Absent rows.
  for (const e of employees) {
    const rec = records[e.id] || new Set();
    const { onLeave } = perEmp[e.id];
    const absent = absentDatesFor(D, D, D, ds => rec.has(ds), ds => onLeave.has(ds), { ...OPTS, today: D, todayPending: false });
    for (const ds of absent) rows.push({ employee: e.name, date: ds, status: 'absent' });
  }
  // Optional Pending-leave rows.
  if (includePending) {
    for (const e of employees) {
      const rec = records[e.id] || new Set();
      for (const ds of WORKDATES) if (perEmp[e.id].pending.has(ds) && !rec.has(ds)) rows.push({ employee: e.name, date: ds, status: 'leave_pending' });
    }
  }
  return rows;
}

const EMPLOYEES = [
  { id: 'A', name: 'Crmonce Admin' },   // no record, no leave → actual Absent
  { id: 'J', name: 'Jana Thanuja' },    // pending leave, no record
  { id: 'C', name: 'Challa Pravallika' },// pending leave, no record
  { id: 'K', name: 'Approved Person' }, // approved leave, no record → never Absent
];
const LEAVES = {
  J: [{ from: D, status: 'pending' }],
  C: [{ from: D, status: 'pending' }],
  K: [{ from: D, status: 'approved' }],
};

test('1/4/6 — toggle OFF → only ACTUAL absent rows (1); approved & pending excluded', () => {
  const rows = absenteeRows({ employees: EMPLOYEES, leaves: LEAVES, includePending: false });
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].employee, 'Crmonce Admin');
  assert.strictEqual(rows[0].status, 'absent');
  assert.ok(!rows.some(r => r.status === 'leave_pending'), 'no pending rows when OFF');
  assert.ok(!rows.some(r => r.employee === 'Approved Person'), 'approved leave never Absent');
});

test('2/3 — toggle ON → actual absent (1) + pending-leave rows (2), labelled leave_pending', () => {
  const rows = absenteeRows({ employees: EMPLOYEES, leaves: LEAVES, includePending: true });
  assert.strictEqual(rows.length, 3);
  assert.strictEqual(rows.filter(r => r.status === 'absent').length, 1);
  assert.strictEqual(rows.filter(r => r.status === 'leave_pending').length, 2);
  // pending employees carry status leave_pending — NEVER 'absent'
  const jana = rows.find(r => r.employee === 'Jana Thanuja');
  assert.strictEqual(jana.status, 'leave_pending');
  assert.notStrictEqual(jana.status, 'absent');
});

test('4/5 — the ACTUAL absent set is identical with the toggle ON vs OFF (count unaffected)', () => {
  const off = absenteeRows({ employees: EMPLOYEES, leaves: LEAVES, includePending: false }).filter(r => r.status === 'absent');
  const on = absenteeRows({ employees: EMPLOYEES, leaves: LEAVES, includePending: true }).filter(r => r.status === 'absent');
  assert.deepEqual(off, on, 'actual Absent rows unchanged by the toggle');
});

test('7 — a pending-leave employee is not turned into an actual Absent even when included', () => {
  const rows = absenteeRows({ employees: EMPLOYEES, leaves: LEAVES, includePending: true });
  assert.ok(!rows.some(r => r.employee === 'Jana Thanuja' && r.status === 'absent'), 'pending stays leave_pending, never actual Absent');
});

test('8 — rejected/cancelled leave (never fetched) → the day stays actual Absent', () => {
  const rows = absenteeRows({ employees: [{ id: 'R', name: 'Rej' }], leaves: { R: [] }, includePending: true });
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].status, 'absent');   // no approved/pending leave in the map → Absent
});

test('9 — a pending-leave day WITH a punch is not emitted (the record represents the day)', () => {
  const rows = absenteeRows({ employees: [{ id: 'J', name: 'Jana' }], records: { J: new Set([D]) }, leaves: LEAVES, includePending: true });
  assert.strictEqual(rows.length, 0, 'punched pending-leave day → no absent and no pending row');
});
