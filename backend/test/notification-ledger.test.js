/**
 * Notification ledger — idempotency + failed-retry + CC rules (§8–§11, §20 D–K).
 *
 * Uses the notification test transport (no network) + an in-memory ledger store, so
 * we assert EXACTLY how many emails leave and how each send is recorded.
 */
process.env.NODE_ENV = 'test';
process.env.AZURE_CLIENT_ID = process.env.AZURE_CLIENT_ID || 'test-client';
process.env.AZURE_CLIENT_SECRET = process.env.AZURE_CLIENT_SECRET || 'test-secret';
process.env.AZURE_TENANT_ID = process.env.AZURE_TENANT_ID || 'test-tenant';

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const notification = require('../src/services/notification.service');
const ledger = require('../src/services/notification-ledger.service');
const exceptions = require('../src/services/attendance-exception.service');
const T = require('../src/services/email/templates');

// In-memory store mirroring the Dataverse store's key semantics.
function memStore() {
  const rows = [];
  const key = (e, d, t) => `${e}|${String(d ?? '').slice(0, 10)}|${t}`;
  return {
    rows,
    async hasSent(e, d, t) { return rows.some(r => r.k === key(e, d, t) && r.status === 'sent'); },
    async record(rec) { rows.push({ k: key(rec.employeeId, rec.date, rec.type), ...rec }); },
  };
}

let store;
beforeEach(() => {
  store = memStore();
  ledger.setStore(store);
  notification.clearOutbox();
  notification.setTransport(() => {});   // capture every send into the outbox; NEVER hit Graph
});
afterEach(() => { notification.resetTransport(); ledger.setStore(null); notification.clearOutbox(); });

const send = (over = {}) => ledger.sendOnce({
  employeeId: 'EMP1039', date: '2026-08-10', type: 'MISSING_PUNCH',
  to: 'a@crmonce.com', subject: 'Missing Punch - 10 Aug 2026', html: '<p>x</p>', entity: 'attendance', ...over,
});

// ── §8/§10: one employee + one date + one type = ONE email ──
test('sendOnce sends the first time, SKIPS every repeat (recalc/refresh/payroll)', async () => {
  const r1 = await send();
  assert.strictEqual(r1.sent, true);
  for (let i = 0; i < 4; i++) {                 // 10:05, 10:30, dashboard, payroll…
    const r = await send();
    assert.strictEqual(r.skipped, true);
    assert.strictEqual(r.reason, 'already_sent');
  }
  assert.strictEqual(notification.getOutbox().length, 1, 'exactly ONE email left the system');
  assert.strictEqual(store.rows.filter(r => r.status === 'sent').length, 1);
});

// ── §20 I: same employee, another DATE → allowed ──
test('a different date is a new notification (allowed)', async () => {
  await send({ date: '2026-08-10' });
  const r = await send({ date: '2026-08-11' });
  assert.strictEqual(r.sent, true);
  assert.strictEqual(notification.getOutbox().length, 2);
});

// ── §20 J: different employee → separate notification ──
test('a different employee is a separate notification', async () => {
  await send({ employeeId: 'EMP1039', to: 'a@crmonce.com' });
  const r = await send({ employeeId: 'EMP1040', to: 'b@crmonce.com' });
  assert.strictEqual(r.sent, true);
  assert.strictEqual(notification.getOutbox().length, 2);
});

// ── §11/§20 K: a failed send is recorded 'failed' (NOT 'sent') and can retry ──
test('failed send is recorded failed, retried later, then deduped after success', async () => {
  notification.setTransport(() => { throw new Error('graph down'); });   // force failure
  const r1 = await send();
  assert.strictEqual(r1.sent, false);
  assert.strictEqual(store.rows.filter(r => r.status === 'sent').length, 0, 'never marked sent on failure');
  assert.strictEqual(store.rows.filter(r => r.status === 'failed').length, 1);

  notification.setTransport(() => {});           // transport recovers
  const r2 = await send();                        // retry allowed (no prior success)
  assert.strictEqual(r2.sent, true);

  const r3 = await send();                        // now deduped
  assert.strictEqual(r3.skipped, true);
  // Exactly ONE successful send is recorded, and no further send happens after it.
  assert.strictEqual(store.rows.filter(r => r.status === 'sent').length, 1, 'exactly one successful send recorded');
});

// ── no recipient → skipped, nothing sent ──
test('no recipient → skipped, no send, no record', async () => {
  const r = await send({ to: '' });
  assert.strictEqual(r.skipped, true);
  assert.strictEqual(notification.getOutbox().length, 0);
  assert.strictEqual(store.rows.length, 0);
});

// ── §7/§9: templates carry the required fields ──
test('missingPunch template: subject + all §7 fields', () => {
  const { subject, html } = T.missingPunch({ employeeName: 'Vishwesh', date: '10 Aug 2026', shift: 'General', inTime: '10:05 AM', outTime: '—', raiseUrl: 'https://x/attendance-requests' });
  assert.strictEqual(subject, 'Missing Punch - 10 Aug 2026');
  assert.match(html, /Missing Punch/);
  assert.match(html, /General/);
  assert.match(html, /10:05 AM/);
});

test('lateLoginNotice template: subject + expected/actual', () => {
  const { subject, html } = T.lateLoginNotice({ employeeName: 'Vishwesh', date: '10 Aug 2026', shift: 'General', expectedTime: '09:00', actualTime: '09:45 AM' });
  assert.strictEqual(subject, 'Late Login - 10 Aug 2026');
  assert.match(html, /09:45 AM/);
  assert.match(html, /Late Login/);
});

// ── §7/§14: missing-punch email goes to the EMPLOYEE ONLY (no CC) and once ──
test('notifyException emails the employee ONLY (no CC) and is not re-sent', async () => {
  const emp = { hr_hremployeeid: 'EMP1039', hr_hremployee1: 'Vishwesh', hr_email: 'v@crmonce.com', hr_shiftname: 'General' };
  const alert = { code: 'missing_check_out', label: 'Missing Check Out', date: '2026-08-10', punches: ['10:05'] };
  await exceptions.notifyException(emp, alert, { cc: [], shift: 'General', inTime: '10:05 AM', outTime: '—' });
  await exceptions.notifyException(emp, alert, { cc: [], shift: 'General', inTime: '10:05 AM', outTime: '—' });   // rescan
  const box = notification.getOutbox();
  assert.strictEqual(box.length, 1, 'one email despite two scans');
  assert.strictEqual(box[0].to, 'v@crmonce.com');
  assert.ok(!box[0].cc || (Array.isArray(box[0].cc) && box[0].cc.length === 0), 'no HR/manager CC by default');
});
