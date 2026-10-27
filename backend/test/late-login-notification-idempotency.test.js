/**
 * Late Login notification idempotency + retry (spec §3), driven through the REAL notification
 * ledger with an in-memory store (no network, no Dataverse):
 *   • A failed send is recorded 'failed' (retryable) — never reported as delivered.
 *   • A later retry re-sends exactly once, then a successful send is never duplicated (re-scan /
 *     scheduler retry / second worker all collapse to one delivery per (employee, date, type)).
 *   • Distinct events (different dates) are NOT suppressed by one another.
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
const notif = require('../src/services/notification.service');
const ledger = require('../src/services/notification-ledger.service');
const PP = require('../src/services/permission-policy.service');
const lateLogin = require('../src/services/late-login.service');

const EMP = d365.constructor.entities.employee;

function memStore() {
  const rows = new Map();   // key → status
  const k = (e, d, t) => `${e}|${String(d).slice(0, 10)}|${t}`;
  return {
    rows,
    async hasSent(e, d, t) { return rows.get(k(e, d, t)) === 'sent'; },
    async record(rec) { rows.set(k(rec.employeeId, rec.date, rec.type), rec.status); },
  };
}

let orig, store, sendCalls, nextResults;
beforeEach(() => {
  orig = { gio: d365.getByIdOptional, gl: d365.getList, se: notif.sendEmail, nu: notif.notifyUser, bc: notif.broadcast };
  store = memStore();
  ledger.setStore(store);
  sendCalls = [];
  nextResults = [];   // queued sendEmail outcomes (true = success)
  notif.notifyUser = () => {}; notif.broadcast = () => {};
  notif.sendEmail = async (to, subject, html, opts) => { sendCalls.push({ to, subject, type: opts?.meta?.type }); const ok = nextResults.length ? nextResults.shift() : true; return ok ? { success: true } : { success: false, error: 'graph 500' }; };
  d365.getByIdOptional = async (entity) => (entity === EMP ? { hr_email: 'emp@crmonce.com', hr_hremployee1: 'Emp', _hr_manager_value: null } : {});
  d365.getList = async () => ({ data: [{ hr_email: 'hr@crmonce.com' }] });
});
afterEach(() => { ledger.setStore(); Object.assign(d365, { getByIdOptional: orig.gio, getList: orig.gl }); Object.assign(notif, { sendEmail: orig.se, notifyUser: orig.nu, broadcast: orig.bc }); });

const confirm1st = (date) => lateLogin.notifyPolicyOutcome({ employeeId: 'E1', name: 'Emp', label: 'Late Login', requestType: 'late_login', date, decision: PP.decide(0), requested: true });

test('a failed send is recorded failed (retryable), NOT sent', async () => {
  nextResults = [false];                                  // first attempt fails
  await confirm1st('2026-11-05');
  assert.strictEqual(sendCalls.length, 1);
  assert.strictEqual(store.rows.get('E1|2026-11-05|LATE_LOGIN_CONFIRM'), 'failed', 'kept retryable, never false-"sent"');
});

test('retry after a failure sends exactly once more, then never duplicates', async () => {
  nextResults = [false, true];                            // fail, then succeed
  await confirm1st('2026-11-05');                         // attempt 1 → failed
  await confirm1st('2026-11-05');                         // attempt 2 → sent
  await confirm1st('2026-11-05');                         // attempt 3 → suppressed (already sent)
  await confirm1st('2026-11-05');                         // attempt 4 → suppressed
  assert.strictEqual(sendCalls.length, 2, 'one failed + one successful delivery; no duplicate after success');
  assert.strictEqual(store.rows.get('E1|2026-11-05|LATE_LOGIN_CONFIRM'), 'sent');
});

test('distinct events (different dates) each deliver — one is never suppressed by the other', async () => {
  await confirm1st('2026-11-05');
  await confirm1st('2026-11-12');
  assert.strictEqual(sendCalls.length, 2);
  assert.strictEqual(store.rows.get('E1|2026-11-05|LATE_LOGIN_CONFIRM'), 'sent');
  assert.strictEqual(store.rows.get('E1|2026-11-12|LATE_LOGIN_CONFIRM'), 'sent');
});
