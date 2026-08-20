/**
 * Same-day Late Login notification timing.
 * Pure decision (shouldNotifyLateLogin) — Cases A/B/C/D/F + skips — and the sweep
 * (sweepTodayLateLogins): same-day send for the correct attendance date, dedup on
 * re-run, and skips for weekly-off/holiday and approved leave. No network.
 */
process.env.NODE_ENV = 'test';
process.env.AZURE_CLIENT_ID = process.env.AZURE_CLIENT_ID || 'test-client';
process.env.AZURE_CLIENT_SECRET = process.env.AZURE_CLIENT_SECRET || 'test-secret';
process.env.AZURE_TENANT_ID = process.env.AZURE_TENANT_ID || 'test-tenant';

const { test } = require('node:test');
const assert = require('node:assert');
const exc = require('../src/services/attendance-exception.service');
const d365 = require('../src/services/d365.service');
const time = require('../src/services/time.util');
const ledger = require('../src/services/notification-ledger.service');
const { shouldNotifyLateLogin } = exc;

const M = (hhmm) => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; };
const base = { isNight: false, isWorkingDay: true, onLeave: false, shiftStartMin: M('09:00'), grace: 5 };

// ── PURE decision ────────────────────────────────────────────────────────────
test('A — punch 09:04 (within grace) → no Late Login', () => {
  assert.strictEqual(shouldNotifyLateLogin({ ...base, hasPunch: true, lateEntryMinutes: 0 }).notify, false);
});
test('B — punch 09:06 → Late Login, Late By 6', () => {
  const r = shouldNotifyLateLogin({ ...base, hasPunch: true, lateEntryMinutes: 6 });
  assert.strictEqual(r.notify, true); assert.strictEqual(r.reason, 'late_punch'); assert.strictEqual(r.lateBy, 6);
});
test('C — no punch, now 09:06 (past 09:05 deadline) → Late Login', () => {
  const r = shouldNotifyLateLogin({ ...base, hasPunch: false, nowMin: M('09:06') });
  assert.strictEqual(r.notify, true); assert.strictEqual(r.reason, 'no_punch'); assert.strictEqual(r.lateBy, 6);
});
test('C-early — no punch, now 09:04 (before deadline) → do nothing', () => {
  assert.strictEqual(shouldNotifyLateLogin({ ...base, hasPunch: false, nowMin: M('09:04') }).notify, false);
});
test('deadline is exclusive at exactly 09:05 → not yet notified', () => {
  assert.strictEqual(shouldNotifyLateLogin({ ...base, hasPunch: false, nowMin: M('09:05') }).notify, false);
});
test('D — punch 09:30 → Late Login, Late By 30', () => {
  assert.strictEqual(shouldNotifyLateLogin({ ...base, hasPunch: true, lateEntryMinutes: 30 }).lateBy, 30);
});
test('F — a shift LATER today (14:00), now 09:15 → not yet (no premature notice)', () => {
  assert.strictEqual(shouldNotifyLateLogin({ ...base, shiftStartMin: M('14:00'), hasPunch: false, nowMin: M('09:15') }).notify, false);
});
test('skips: night / weekly-off·holiday / approved leave / already-submitted → never notify', () => {
  assert.strictEqual(shouldNotifyLateLogin({ ...base, isNight: true, hasPunch: false, nowMin: M('10:00') }).notify, false);
  assert.strictEqual(shouldNotifyLateLogin({ ...base, isWorkingDay: false, hasPunch: false, nowMin: M('10:00') }).notify, false);
  assert.strictEqual(shouldNotifyLateLogin({ ...base, onLeave: true, hasPunch: false, nowMin: M('10:00') }).notify, false);
  // Point 4: a Late Login request already submitted for the date → suppress BOTH notices.
  assert.strictEqual(shouldNotifyLateLogin({ ...base, alreadySubmitted: true, hasPunch: false, nowMin: M('10:00') }).notify, false);
  assert.strictEqual(shouldNotifyLateLogin({ ...base, alreadySubmitted: true, hasPunch: true, lateEntryMinutes: 30 }).notify, false);
});

// DYNAMIC deadline = employee shift start + grace (never a fixed 09:05).
test('DYNAMIC deadline per shift: 08:30→08:35, 09:30→09:35, 10:00→10:05 (no hardcoded time)', () => {
  const noPunch = (shift, now) => shouldNotifyLateLogin({ ...base, shiftStartMin: M(shift), hasPunch: false, nowMin: M(now) }).notify;
  assert.strictEqual(noPunch('08:30', '08:34'), false); assert.strictEqual(noPunch('08:30', '08:36'), true);   // deadline 08:35
  assert.strictEqual(noPunch('09:30', '09:34'), false); assert.strictEqual(noPunch('09:30', '09:36'), true);   // deadline 09:35
  assert.strictEqual(noPunch('10:00', '10:04'), false); assert.strictEqual(noPunch('10:00', '10:06'), true);   // deadline 10:05
  // late-by is measured from the shift start, not a fixed clock
  assert.strictEqual(shouldNotifyLateLogin({ ...base, shiftStartMin: M('08:30'), hasPunch: false, nowMin: M('08:40') }).lateBy, 10);
});

// ── sweep integration (d365 + ledger stubbed) ────────────────────────────────
const EMP = { hr_hremployeeid: 'E1', hr_hremployee1: 'Test One', hr_email: 'e1@crmonce.com', hr_shiftname: 'Day', hr_shiftstarttime: '09:00', hr_shiftendtime: '18:00' };
const att = (punches, id = 'E1', date = '2026-08-18') => ({ _hr_hremployee_value: id, hr_date: date, hr_allpunches: JSON.stringify(punches) });

function stub({ today = '2026-08-18', now = '09:15', employees = [EMP], attendance = [], approvedLeaves = [], submittedLateLogins = [] } = {}) {
  const o = { glo: d365.getListOptional, gl: d365.getList, ds: time.istDateStr, hm: time.istHHMM, so: ledger.sendOnce };
  const sends = []; const seen = new Set();
  time.istDateStr = () => today;
  time.istHHMM = () => now;
  d365.getListOptional = async () => ({ data: employees });
  d365.getList = async (_e, opts) => {
    const f = String(opts?.filter || '');
    if (f.includes("hr_date eq '")) return { data: submittedLateLogins };   // late-login (quoted date)
    if (f.includes('hr_date eq')) return { data: attendance };              // attendance (unquoted date)
    return { data: approvedLeaves };                                        // approved leaves
  };
  // Simulate the ledger's dedup so re-runs / a later punch never double-send.
  ledger.sendOnce = async (p) => { const k = `${p.employeeId}|${p.date}|${p.type}`; if (seen.has(k)) return { skipped: true, reason: 'already_sent' }; seen.add(k); sends.push(p); return { skipped: false }; };
  return { sends, restore() { d365.getListOptional = o.glo; d365.getList = o.gl; time.istDateStr = o.ds; time.istHHMM = o.hm; ledger.sendOnce = o.so; } };
}

test('sweep B — late punch (09:06) → 1 email today, correct date/recipient/type (G)', async () => {
  const s = stub({ attendance: [att(['09:06'])] });
  try {
    const r = await exc.sweepTodayLateLogins();
    assert.strictEqual(r.notified, 1);
    assert.strictEqual(s.sends.length, 1);
    assert.strictEqual(s.sends[0].date, '2026-08-18');          // the ATTENDANCE date, not the run date
    assert.strictEqual(s.sends[0].type, 'LATE_LOGIN');
    assert.strictEqual(s.sends[0].to, 'e1@crmonce.com');
    assert.match(s.sends[0].subject, /Late Login/i);
  } finally { s.restore(); }
});
test('sweep A — on-time punch (09:04) → no email', async () => {
  const s = stub({ attendance: [att(['09:04'])] });
  try { assert.strictEqual((await exc.sweepTodayLateLogins()).notified, 0); assert.strictEqual(s.sends.length, 0); }
  finally { s.restore(); }
});
test('sweep C — no punch by deadline (now 09:15) → 1 email today', async () => {
  const s = stub({ attendance: [] });
  try { const r = await exc.sweepTodayLateLogins(); assert.strictEqual(r.notified, 1); assert.strictEqual(s.sends[0].date, '2026-08-18'); }
  finally { s.restore(); }
});
test('sweep F — shift 14:00 not yet reached (now 09:15) → no email', async () => {
  const s = stub({ employees: [{ ...EMP, hr_shiftstarttime: '14:00' }], attendance: [] });
  try { assert.strictEqual((await exc.sweepTodayLateLogins()).notified, 0); }
  finally { s.restore(); }
});
test('sweep — employee on approved leave today → no email', async () => {
  const s = stub({ attendance: [], approvedLeaves: [{ _hr_hremployee_value: 'E1', hr_fromdate: '2026-08-18', hr_todate: '2026-08-18', hr_status: 1 }] });
  try { assert.strictEqual((await exc.sweepTodayLateLogins()).notified, 0); }
  finally { s.restore(); }
});
test('2 vs 3 — no punch → "Please apply for Late Login"; late punch → "You logged in late"', async () => {
  const noPunch = stub({ attendance: [] });
  try { const r = await exc.sweepTodayLateLogins(); assert.strictEqual(r.notified, 1); assert.match(noPunch.sends[0].subject, /Late Login Required/); }
  finally { noPunch.restore(); }
  const latePunch = stub({ attendance: [att(['09:06'])] });
  try { const r = await exc.sweepTodayLateLogins(); assert.strictEqual(r.notified, 1); assert.match(latePunch.sends[0].subject, /Late Login Notification/); }
  finally { latePunch.restore(); }
});
test('4 — a Late Login request already submitted today → BOTH auto notices suppressed', async () => {
  const noPunch = stub({ attendance: [], submittedLateLogins: [{ hr_employeeid: 'E1', hr_status: 'submitted' }] });
  try { assert.strictEqual((await exc.sweepTodayLateLogins()).notified, 0); assert.strictEqual(noPunch.sends.length, 0); }
  finally { noPunch.restore(); }
  const latePunch = stub({ attendance: [att(['09:30'])], submittedLateLogins: [{ hr_employeeid: 'E1', hr_status: 'completed' }] });
  try { assert.strictEqual((await exc.sweepTodayLateLogins()).notified, 0); }
  finally { latePunch.restore(); }
});
test('sweep DYNAMIC deadline — shift 08:30, no punch, now 08:40 → sends (deadline 08:35, not 09:05)', async () => {
  const s = stub({ employees: [{ ...EMP, hr_shiftstarttime: '08:30' }], attendance: [], now: '08:40' });
  try { assert.strictEqual((await exc.sweepTodayLateLogins()).notified, 1); }
  finally { s.restore(); }
});
test('E — running the sweep TWICE sends only ONE email (dedup via ledger)', async () => {
  const s = stub({ attendance: [att(['09:06'])] });
  try {
    const a = await exc.sweepTodayLateLogins();
    const b = await exc.sweepTodayLateLogins();
    assert.strictEqual(a.notified, 1);
    assert.strictEqual(b.notified, 0);          // second run: already sent
    assert.strictEqual(s.sends.length, 1);
  } finally { s.restore(); }
});
test('sweep — weekly-off / holiday (Sunday) → skipped, no reads/sends', async () => {
  const s = stub({ today: '2026-08-23' });      // Sunday
  try { const r = await exc.sweepTodayLateLogins(); assert.strictEqual(r.skipped, 'non_working_day'); assert.strictEqual(s.sends.length, 0); }
  finally { s.restore(); }
});
