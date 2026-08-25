/**
 * Absent + no leave → next-day notification. Pure decision + previous-day IST math +
 * the sweep (d365 + notification-ledger stubbed): one email per absent employee/date,
 * deduped across re-runs/restart/PM2, suppressed by valid leave / weekly-off / holiday /
 * not-employed / actually-present. No network.
 */
process.env.NODE_ENV = 'test';
process.env.AZURE_CLIENT_ID = process.env.AZURE_CLIENT_ID || 'test-client';
process.env.AZURE_CLIENT_SECRET = process.env.AZURE_CLIENT_SECRET || 'test-secret';
process.env.AZURE_TENANT_ID = process.env.AZURE_TENANT_ID || 'test-tenant';

const { test } = require('node:test');
const assert = require('node:assert');
const exc = require('../src/services/attendance-exception.service');
const d365 = require('../src/services/d365.service');
const ledger = require('../src/services/notification-ledger.service');
const attnCfg = require('../src/services/attendance.config');

const EMP = 'hr_hremployees', ATT = 'hr_hrattendances', LEAVE = 'hr_hrleaves';
const LV = { pending: 123140000, approved: 123140001, rejected: 123140002, cancelled: 123140003 };
const WORKING = '2026-08-20';   // Thursday
const SUNDAY = '2026-08-23';    // weekly-off

const emp = (id, over = {}) => ({ hr_hremployeeid: id, hr_hremployee1: `Emp ${id}`, hr_email: `${id.toLowerCase()}@crmonce.com`, hr_joiningdate: '2020-01-01', ...over });
const att = (id, punches = ['09:00', '18:00'], date = WORKING) => ({ _hr_hremployee_value: id, hr_date: date, hr_allpunches: JSON.stringify(punches) });
const leave = (id, status, from, to) => ({ _hr_hremployee_value: id, hr_status: status, hr_fromdate: from, hr_todate: to });

function stub({ employees = [emp('E1')], attendance = [], leaves = [] } = {}) {
  const o = { glo: d365.getListOptional, gl: d365.getList, so: ledger.sendOnce };
  const sends = []; const seen = new Set();
  d365.getListOptional = async (entity) => (entity === EMP ? { data: employees } : { data: [] });
  d365.getList = async (entity) => {
    if (entity === ATT) return { data: attendance };
    if (entity === LEAVE) return { data: leaves };
    return { data: [] };
  };
  // Simulate the notification ledger's at-most-once dedup (employee | date | type).
  ledger.sendOnce = async (p) => {
    const k = `${p.employeeId}|${p.date}|${p.type}`;
    if (seen.has(k)) return { skipped: true, reason: 'already_sent' };
    seen.add(k); sends.push(p); return { skipped: false };
  };
  return { sends, seen, restore() { d365.getListOptional = o.glo; d365.getList = o.gl; ledger.sendOnce = o.so; } };
}

// ── PURE decision ─────────────────────────────────────────────────────────────
test('decision — notify only when working + employed + no punch + no valid leave', () => {
  const D = exc.shouldNotifyAbsentNoLeave;
  assert.strictEqual(D({ isWorkingDay: true, employed: true, hasPunch: false, onValidLeave: false }), true);
  assert.strictEqual(D({ isWorkingDay: false, employed: true, hasPunch: false, onValidLeave: false }), false); // weekly-off/holiday
  assert.strictEqual(D({ isWorkingDay: true, employed: false, hasPunch: false, onValidLeave: false }), false); // not employed
  assert.strictEqual(D({ isWorkingDay: true, employed: true, hasPunch: true, onValidLeave: false }), false); // present
  assert.strictEqual(D({ isWorkingDay: true, employed: true, hasPunch: false, onValidLeave: true }), false); // valid leave
});

// ── previous-day IST math (14) ────────────────────────────────────────────────
test('14 — previousBusinessDate returns the prior IST civil day (no UTC shift)', () => {
  assert.strictEqual(exc.previousBusinessDate('2026-08-21'), '2026-08-20');
  assert.strictEqual(exc.previousBusinessDate('2026-03-01'), '2026-02-28');   // month boundary
  assert.strictEqual(exc.previousBusinessDate('2026-01-01'), '2025-12-31');   // year boundary
});

// ── sweep integration ─────────────────────────────────────────────────────────
test('1 — absent + no leave on a working day → sends the next-day notice', async () => {
  const s = stub({ employees: [emp('E1')], attendance: [], leaves: [] });
  try {
    const r = await exc.sweepAbsentNoLeave({ date: WORKING });
    assert.strictEqual(r.notified, 1);
    assert.strictEqual(s.sends.length, 1);
    assert.strictEqual(s.sends[0].type, 'ABSENT_LEAVE_NOT_APPLIED');
    assert.strictEqual(s.sends[0].to, 'e1@crmonce.com');
    assert.strictEqual(s.sends[0].date, WORKING);
    assert.match(s.sends[0].subject, /Leave Not Applied.*Attendance Marked Absent/);
  } finally { s.restore(); }
});

test('2–5,13 — re-run / restart / multiple workers → still ONE email (ledger dedup)', async () => {
  const s = stub({ employees: [emp('E1')], attendance: [], leaves: [] });
  try {
    const a = await exc.sweepAbsentNoLeave({ date: WORKING });
    const b = await exc.sweepAbsentNoLeave({ date: WORKING });   // scheduler runs again / restart / another worker
    assert.strictEqual(a.notified, 1);
    assert.strictEqual(b.notified, 0);   // already sent → suppressed
    assert.strictEqual(s.sends.length, 1);
  } finally { s.restore(); }
});

test('6 — approved leave covering the date → no email', async () => {
  const s = stub({ employees: [emp('E1')], attendance: [], leaves: [leave('E1', LV.approved, WORKING, WORKING)] });
  try { assert.strictEqual((await exc.sweepAbsentNoLeave({ date: WORKING })).notified, 0); assert.strictEqual(s.sends.length, 0); } finally { s.restore(); }
});

test('7 — pending leave covering the date → no email', async () => {
  const s = stub({ employees: [emp('E1')], attendance: [], leaves: [leave('E1', LV.pending, WORKING, WORKING)] });
  try { assert.strictEqual((await exc.sweepAbsentNoLeave({ date: WORKING })).notified, 0); } finally { s.restore(); }
});

test('8 — a multi-day approved leave range covering the date → no email', async () => {
  const s = stub({ employees: [emp('E1')], attendance: [], leaves: [leave('E1', LV.approved, '2026-08-18', '2026-08-25')] });
  try { assert.strictEqual((await exc.sweepAbsentNoLeave({ date: WORKING })).notified, 0); } finally { s.restore(); }
});

test('9 — weekly off → skipped (nobody is absent)', async () => {
  const s = stub({ employees: [emp('E1')], attendance: [], leaves: [] });
  try { const r = await exc.sweepAbsentNoLeave({ date: SUNDAY }); assert.strictEqual(r.skipped, 'non_working_day'); assert.strictEqual(s.sends.length, 0); } finally { s.restore(); }
});

test('10 — holiday → skipped', async () => {
  attnCfg.setDynamicHolidays([WORKING]);
  const s = stub({ employees: [emp('E1')], attendance: [], leaves: [] });
  try { const r = await exc.sweepAbsentNoLeave({ date: WORKING }); assert.strictEqual(r.skipped, 'non_working_day'); assert.strictEqual(s.sends.length, 0); }
  finally { s.restore(); attnCfg.setDynamicHolidays([]); }
});

test('11 — employee actually punched (present) → not absent → no email', async () => {
  const s = stub({ employees: [emp('E1')], attendance: [att('E1', ['09:00', '18:00'])], leaves: [] });
  try { assert.strictEqual((await exc.sweepAbsentNoLeave({ date: WORKING })).notified, 0); } finally { s.restore(); }
});

test('12 — employee not employed on that date (joined later) → no email', async () => {
  const s = stub({ employees: [emp('E1', { hr_joiningdate: '2026-09-01' })], attendance: [], leaves: [] });
  try { assert.strictEqual((await exc.sweepAbsentNoLeave({ date: WORKING })).notified, 0); } finally { s.restore(); }
  // (Truly INACTIVE employees are excluded upstream by the `hr_status eq active` query.)
});

test('15 — multiple employees → only the absent-without-leave one is emailed (once each)', async () => {
  const s = stub({
    employees: [emp('E1'), emp('E2'), emp('E3')],
    attendance: [att('E2')],                                   // E2 punched (present)
    leaves: [leave('E3', LV.pending, WORKING, WORKING)],       // E3 has pending leave
  });
  try {
    const r = await exc.sweepAbsentNoLeave({ date: WORKING }); // only E1 qualifies
    assert.strictEqual(r.notified, 1);
    assert.strictEqual(s.sends.length, 1);
    assert.strictEqual(s.sends[0].employeeId, 'E1');
  } finally { s.restore(); }
});

test('validLeaveEmployees — approved & pending count; rejected & cancelled do not', async () => {
  const s = stub({ leaves: [
    leave('E1', LV.approved, WORKING, WORKING),
    leave('E2', LV.pending, WORKING, WORKING),
    leave('E3', LV.rejected, WORKING, WORKING),
    leave('E4', LV.cancelled, WORKING, WORKING),
  ] });
  try {
    const set = await exc.validLeaveEmployees(WORKING);
    assert.ok(set.has('E1')); assert.ok(set.has('E2'));
    assert.ok(!set.has('E3')); assert.ok(!set.has('E4'));
  } finally { s.restore(); }
});
