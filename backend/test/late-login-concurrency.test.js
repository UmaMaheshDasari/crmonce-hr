/**
 * Concurrency, recovery, and effective-date defense-in-depth for the punch-only Late Login path.
 *  • withKeyLock serialises same-key work within the process.
 *  • recordPunchLateEvent re-checks existence under the lock (same-process dedupe) and self-gates
 *    the effective date.
 *  • The CL debit is event-keyed + delta-reconciled → a retry after a failed record-create does
 *    NOT double-debit, and a transient double-debit converges to −0.5.
 * d365 + leave engine + notifications stubbed; no network.
 */
process.env.NODE_ENV = 'test';
process.env.EMAIL_DRY_RUN = 'true';
process.env.TENANT_MAIL_DOMAINS = 'crmonce.com';
process.env.AZURE_CLIENT_ID = process.env.AZURE_CLIENT_ID || 'x';
process.env.AZURE_CLIENT_SECRET = process.env.AZURE_CLIENT_SECRET || 'x';
process.env.AZURE_TENANT_ID = process.env.AZURE_TENANT_ID || 'x';

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const d365 = require('../src/services/d365.service');
const leaveEngine = require('../src/services/leave-engine.service');
const notif = require('../src/services/notification.service');
const { withKeyLock } = require('../src/services/concurrency.util');
const PP = require('../src/services/permission-policy.service');
const lateLogin = require('../src/services/late-login.service');

const LATE = d365.constructor.entities.lateLogin;
const NOV = '2026-11-20';
const isQ = (s) => !['cancelled', 'rejected', 'manager_rejected'].includes(s);

let orig;
beforeEach(() => {
  orig = { gl: d365.getList, cr: d365.create, up: d365.update, rl: leaveEngine.readLedger, gb: leaveEngine.getBalance, add: leaveEngine.addLedgerEntry, se: notif.sendEmail, nu: notif.notifyUser, bc: notif.broadcast, gio: d365.getByIdOptional };
  notif.sendEmail = async () => ({ success: true }); notif.notifyUser = () => {}; notif.broadcast = () => {};
  d365.getByIdOptional = async () => ({ hr_email: 'v@crmonce.com', hr_hremployee1: 'V' });
});
afterEach(() => { Object.assign(d365, { getList: orig.gl, create: orig.cr, update: orig.up, getByIdOptional: orig.gio }); Object.assign(leaveEngine, { readLedger: orig.rl, getBalance: orig.gb, addLedgerEntry: orig.add }); Object.assign(notif, { sendEmail: orig.se, notifyUser: orig.nu, broadcast: orig.bc }); });

// A stateful hr_lateLogin store + a ledger sim with real reconciliation math.
function harness({ priorQualifying = 0, failCreateTimes = 0, clRemaining = 10 } = {}) {
  const records = [];
  for (let i = 0; i < priorQualifying; i++) records.push({ hr_lateloginid: `seed${i}`, hr_employeeid: 'E1', hr_date: `2026-11-0${i + 1}`, hr_month: '2026-11', hr_requesttype: 'late_login', hr_status: 'auto_approved' });
  const ledger = [];
  let failsLeft = failCreateTimes;
  d365.getList = async (entity, opts) => {
    if (entity !== LATE) return { data: [] };
    const f = String(opts.filter || '');
    if (/hr_date eq/.test(f)) {   // existingLateFor
      const d = (f.match(/hr_date eq '([^']+)'/) || [])[1];
      return { data: records.filter(r => r.hr_date === d && r.hr_requesttype === 'late_login' && r.hr_status !== 'cancelled') };
    }
    if (/hr_month eq/.test(f)) {  // qualifyingCount
      return { data: records.filter(r => r.hr_month === '2026-11' && r.hr_requesttype === 'late_login' && isQ(r.hr_status)) };
    }
    return { data: [] };
  };
  d365.create = async (_e, payload) => {
    if (failsLeft > 0) { failsLeft--; const e = new Error('create failed'); throw e; }
    const rec = { hr_lateloginid: `r${records.length}`, ...payload };
    records.push(rec); return { hr_lateloginid: rec.hr_lateloginid };
  };
  leaveEngine.readLedger = async () => ledger.slice();
  leaveEngine.getBalance = async () => ({ casual: { remaining: clRemaining } });
  leaveEngine.addLedgerEntry = async (e) => { ledger.push({ hr_reason: e.reason, hr_days: String(e.days) }); return {}; };
  const net = () => Math.round(ledger.reduce((s, r) => s + Number(r.hr_days), 0) * 100) / 100;
  return { records, ledger, net };
}
const rec = (over = {}) => lateLogin.recordPunchLateEvent({ employeeId: 'E1', employeeName: 'V', date: NOV, firstPunch: '09:30', shiftStart: '09:00', ...over });

// ── withKeyLock ──
test('withKeyLock: same key runs serially (no interleave); different keys run concurrently', async () => {
  const order = [];
  const slow = (tag, ms) => () => new Promise(r => setTimeout(() => { order.push(tag); r(); }, ms));
  await Promise.all([withKeyLock('k', slow('a', 20)), withKeyLock('k', slow('b', 1))]);
  assert.deepStrictEqual(order, ['a', 'b'], 'same key: first finishes before second starts');
  const order2 = [];
  const push = (t) => () => new Promise(r => setTimeout(() => { order2.push(t); r(); }, 5));
  await Promise.all([withKeyLock('x', push('x')), withKeyLock('y', push('y'))]);
  assert.strictEqual(order2.length, 2, 'different keys both ran');
});

test('withKeyLock: a rejecting fn does not wedge the key (next call still runs)', async () => {
  await assert.rejects(() => withKeyLock('z', async () => { throw new Error('boom'); }));
  const r = await withKeyLock('z', async () => 'ok');
  assert.strictEqual(r, 'ok');
});

// ── Effective-date defense in depth (Issue 3) ──
test('recordPunchLateEvent: a PRE-effective date is skipped (no record, no debit)', async () => {
  const H = harness({ priorQualifying: 3, clRemaining: 10 });
  const r = await rec({ date: '2026-10-31' });
  assert.strictEqual(r.skipped, 'pre_effective');
  assert.strictEqual(H.records.length, 3, 'no record created');
  assert.strictEqual(H.net(), 0, 'no CL debit');
});

test('recordPunchLateEvent: on/after the effective date creates a record', async () => {
  const H = harness({ priorQualifying: 0 });
  const r = await rec();
  assert.strictEqual(r.status, 'auto_approved');
  assert.strictEqual(H.records.length, 1);
});

// ── Same-process concurrency: two parallel calls for ONE event → exactly one record, NO CL ──
test('two CONCURRENT recordPunchLateEvent for the same event → exactly one record, never a CL debit', async () => {
  const H = harness({ priorQualifying: 5, clRemaining: 10 });   // 6th event (escalation) — still no CL
  const [a, b] = await Promise.all([rec(), rec()]);
  const created = [a, b].filter(x => !x.skipped);
  const skipped = [a, b].filter(x => x.skipped === 'exists');
  assert.strictEqual(created.length, 1, 'only one call created the record');
  assert.strictEqual(skipped.length, 1, 'the other was deduped under the lock');
  assert.strictEqual(H.records.length, 6, 'exactly one new record (5 seed + 1)');
  assert.strictEqual(H.net(), 0, 'the revised policy NEVER debits CL');
});

// ── Recovery: record-create fails, then a retry creates it; never any CL ──
test('record-create FAILS once → retry creates the record (no duplicate, no CL)', async () => {
  const H = harness({ priorQualifying: 5, clRemaining: 10, failCreateTimes: 1 });
  await assert.rejects(() => rec(), /create failed/);     // first attempt throws on create
  assert.strictEqual(H.records.length, 5, 'no record yet');
  assert.strictEqual(H.net(), 0, 'no CL written');
  const r2 = await rec();                                  // retry
  assert.strictEqual(r2.status, 'auto_approved');
  assert.strictEqual(H.records.length, 6, 'record now exists');
  assert.strictEqual(H.net(), 0, 'still no CL');
});

// ── reconcileEventCL remains a correct ledger UTILITY (retained, no longer used by the policy) ──
test('reconcileEventCL utility still converges a net (unused by the revised policy, kept for legacy detection math)', async () => {
  const H = harness({ priorQualifying: 0, clRemaining: 10 });
  H.ledger.push({ hr_reason: PP.clReason('late_login', 'E1', NOV), hr_days: '-0.5' });
  H.ledger.push({ hr_reason: PP.clReason('late_login', 'E1', NOV), hr_days: '-0.5' });
  assert.strictEqual(H.net(), -1.0);
  await PP.reconcileEventCL({ employeeId: 'E1', employeeName: 'V', date: NOV, requestType: 'late_login', desiredNet: -0.5 });
  assert.strictEqual(H.net(), -0.5, 'utility converges; NOT invoked by the policy flow anymore');
});
