/**
 * Revised Late Login email behaviour (spec §1–§3).
 *   1st–3rd qualifying event:
 *     • employee SUBMITTED a request (requested:true)  → a normal confirmation email (no warning).
 *     • NO request (punch-only, requested:false)       → a "late without a request" warning.
 *   4th → HR warning · 5th → Super Admin final warning · 6th+ → HR/manager escalation — ALWAYS,
 *   regardless of whether a request was submitted.
 * The 1st–3rd emails are keyed by the EVENT DATE (so the three distinct events are not collapsed
 * onto one monthly key); the 4th/5th are keyed per month; 6th+ per event count. A failed send
 * stays retryable (recorded 'failed', never 'sent'). NO leave/salary/CL is ever touched.
 * d365 / leave engine / notifications stubbed; no network.
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
const ledger = require('../src/services/notification-ledger.service');
const PP = require('../src/services/permission-policy.service');
const lateLogin = require('../src/services/late-login.service');

const EMP = d365.constructor.entities.employee;
const LATE = d365.constructor.entities.lateLogin;
const flushUntil = async (fn, tries = 100) => { for (let i = 0; i < tries; i++) { if (fn()) return; await new Promise(r => setImmediate(r)); } };

let orig, sent, ledgerWrites;
beforeEach(() => {
  orig = { gio: d365.getByIdOptional, gl: d365.getList, cr: d365.create, so: ledger.sendOnce, add: leaveEngine.addLedgerEntry, se: notif.sendEmail, nu: notif.notifyUser, bc: notif.broadcast };
  sent = [];
  ledgerWrites = 0;
  // Capture every email the policy tries to send (idempotency is exercised separately via the real ledger).
  ledger.sendOnce = async (o) => { sent.push(o); return { sent: true }; };
  leaveEngine.addLedgerEntry = async () => { ledgerWrites++; return {}; };   // must stay 0 at every tier
  notif.notifyUser = () => {}; notif.broadcast = () => {};
  // Employee + manager lookups; role-filtered recipient queries.
  d365.getByIdOptional = async (entity, id) => {
    if (entity !== EMP) return {};
    if (id === 'MGR') return { hr_email: 'boss@crmonce.com' };
    return { hr_email: 'emp@crmonce.com', hr_hremployee1: 'Emp', hr_department: 'Eng', _hr_manager_value: 'MGR', hr_employeeid: 'EMP1', hr_shiftstarttime: '09:00', hr_shiftendtime: '18:00' };
  };
  d365.getList = async (entity, opts) => {
    const f = String(opts?.filter || '');
    // Role filters carry NUMERIC option-set values, so distinguish by shape: hrEmails() ORs two
    // roles (super_admin OR hr_manager); superAdminEmails() queries a single role.
    if (entity === EMP && / or hr_role eq /.test(f)) return { data: [{ hr_email: 'hrteam@crmonce.com' }] };   // distinct from the HR@ sender
    if (entity === EMP) return { data: [{ hr_email: 'admin@crmonce.com' }] };
    return { data: [] };
  };
});
afterEach(() => { Object.assign(d365, { getByIdOptional: orig.gio, getList: orig.gl, create: orig.cr }); ledger.sendOnce = orig.so; leaveEngine.addLedgerEntry = orig.add; Object.assign(notif, { sendEmail: orig.se, notifyUser: orig.nu, broadcast: orig.bc }); });

const notify = (over) => lateLogin.notifyPolicyOutcome({ employeeId: 'E1', name: 'Emp', label: 'Late Login', requestType: 'late_login', date: '2026-11-05', decision: PP.decide(0), requested: false, ...over });

// ── 1st–3rd: confirmation when requested ─────────────────────────────────────
test('1st/2nd/3rd WITH a submitted request → confirmation email (no warning), keyed per event date', async () => {
  for (const [prior, date] of [[0, '2026-11-03'], [1, '2026-11-10'], [2, '2026-11-18']]) {
    sent = [];
    await notify({ date, decision: PP.decide(prior), requested: true });
    assert.strictEqual(sent.length, 1);
    assert.strictEqual(sent[0].type, 'LATE_LOGIN_CONFIRM');
    assert.strictEqual(sent[0].to, 'emp@crmonce.com');
    assert.deepStrictEqual(sent[0].cc, ['info@crmonce.com'], 'confirmation CC = INFO mailbox only (§E)');
    assert.strictEqual(sent[0].date, date, 'idempotency key is the EVENT date, not the month');
    assert.match(sent[0].subject, /Recorded/i);
  }
  assert.strictEqual(ledgerWrites, 0, 'no CL/leave write at any confirmation');
});

// ── 1st–3rd: no-request warning when NOT requested ───────────────────────────
test('1st/2nd/3rd WITHOUT a request → "late without a request" warning, keyed per event date', async () => {
  for (const [prior, date] of [[0, '2026-11-04'], [1, '2026-11-11'], [2, '2026-11-20']]) {
    sent = [];
    await notify({ date, decision: PP.decide(prior), requested: false });
    assert.strictEqual(sent.length, 1);
    assert.strictEqual(sent[0].type, 'LATE_LOGIN_NO_REQUEST');
    assert.strictEqual(sent[0].to, 'emp@crmonce.com');
    assert.deepStrictEqual(sent[0].cc, ['info@crmonce.com'], 'no-request nudge CC = INFO mailbox only (§E)');
    assert.strictEqual(sent[0].date, date);
    assert.match(sent[0].subject, /Without a Request/i);
  }
  assert.strictEqual(ledgerWrites, 0);
});

test('two different-date events are NOT collapsed onto one key (count alone is never the key)', async () => {
  await notify({ date: '2026-11-05', decision: PP.decide(0), requested: false });   // 1st
  await notify({ date: '2026-11-12', decision: PP.decide(1), requested: false });   // 2nd
  assert.deepStrictEqual(sent.map(s => s.date), ['2026-11-05', '2026-11-12']);
  assert.strictEqual(new Set(sent.map(s => `${s.type}|${s.date}`)).size, 2, 'distinct ledger keys');
});

// ── 4th / 5th / 6th: preserved escalations, regardless of request status ──────
for (const requested of [true, false]) {
  test(`4th → HR warning (cc HR) regardless of request status (requested=${requested}), keyed per month`, async () => {
    await notify({ date: '2026-11-21', decision: PP.decide(3), requested });
    assert.strictEqual(sent.length, 1);
    assert.strictEqual(sent[0].type, 'LATE_LOGIN_HR_WARNING');
    assert.strictEqual(sent[0].to, 'emp@crmonce.com');
    assert.deepStrictEqual(sent[0].cc, ['hrteam@crmonce.com', 'info@crmonce.com']);   // HR recipients + §E info@
    assert.strictEqual(sent[0].date, '2026-11-01', 'monthly key');
    assert.strictEqual(ledgerWrites, 0);
  });

  test(`5th → Super Admin FINAL warning regardless of request status (requested=${requested})`, async () => {
    await notify({ date: '2026-11-22', decision: PP.decide(4), requested });
    assert.strictEqual(sent[0].type, 'LATE_LOGIN_FINAL_WARNING');
    assert.deepStrictEqual(sent[0].cc, ['admin@crmonce.com', 'info@crmonce.com'], 'super_admin recipients + §E info@');
    assert.strictEqual(sent[0].date, '2026-11-01');
  });

  test(`6th → HR/manager escalation regardless of request status (requested=${requested})`, async () => {
    await notify({ date: '2026-11-23', decision: PP.decide(5), requested });
    assert.strictEqual(sent[0].type, 'LATE_LOGIN_ESCALATION_6');
    assert.ok(sent[0].cc.includes('boss@crmonce.com') && sent[0].cc.includes('hrteam@crmonce.com') && sent[0].cc.includes('info@crmonce.com'), 'manager + HR + §E info@ cc');
  });
}

test('6th and 7th use distinct per-count keys (no cross-event suppression)', async () => {
  await notify({ date: '2026-11-24', decision: PP.decide(5), requested: false });   // n=6
  await notify({ date: '2026-11-27', decision: PP.decide(6), requested: false });   // n=7
  assert.deepStrictEqual(sent.map(s => s.type), ['LATE_LOGIN_ESCALATION_6', 'LATE_LOGIN_ESCALATION_7']);
});

test('missing employee mailbox → the email is attempted with a null recipient (ledger then skips); never throws', async () => {
  d365.getByIdOptional = async () => ({ hr_email: '', hr_hremployee1: 'Emp' });
  await notify({ decision: PP.decide(0), requested: true });
  assert.strictEqual(sent[0].to, null);
});

// ── End-to-end wiring: create() = requested, recordPunchLateEvent() = not requested ──
test('create() wires requested:true → the 1st event sends a CONFIRMATION', async () => {
  d365.getByIdOptional = async (entity) => (entity === EMP
    ? { hr_hremployeeid: 'E1', hr_shiftstarttime: '09:00', hr_shiftendtime: '18:00', hr_email: 'emp@crmonce.com', hr_hremployee1: 'Emp' } : {});
  d365.getList = async (entity, opts) => {
    const f = String(opts?.filter || '');
    if (entity === LATE && /hr_date eq/.test(f)) return { data: [] };       // dup guard → none
    if (entity === LATE && /hr_month eq/.test(f)) return { data: [] };      // 0 prior → 1st
    return { data: [] };
  };
  d365.create = async () => ({ hr_lateloginid: 'REC1' });
  await lateLogin.create({ employeeId: 'E1', employeeName: 'Emp', date: '2026-11-06', actualTime: '09:30', reason: 'r', requestType: 'late_login' });
  await flushUntil(() => sent.length >= 1);
  assert.strictEqual(sent[0].type, 'LATE_LOGIN_CONFIRM');
  assert.strictEqual(ledgerWrites, 0);
});

test('recordPunchLateEvent() wires requested:false → the 1st punch event sends a NO-REQUEST warning', async () => {
  d365.getList = async (entity, opts) => {
    const f = String(opts?.filter || '');
    if (entity === LATE && /hr_date eq/.test(f)) return { data: [] };       // existingLateFor → none
    if (entity === LATE && /hr_month eq/.test(f)) return { data: [] };      // 0 prior
    if (entity === EMP) return { data: [{ hr_email: 'hr@crmonce.com' }] };
    return { data: [] };
  };
  d365.create = async () => ({ hr_lateloginid: 'AUTO1' });
  const r = await lateLogin.recordPunchLateEvent({ employeeId: 'E1', employeeName: 'Emp', date: '2026-11-06', firstPunch: '09:30', shiftStart: '09:00' });
  assert.strictEqual(r.status, PP.STATUS.AUTO_APPROVED);
  await flushUntil(() => sent.length >= 1);
  assert.strictEqual(sent[0].type, 'LATE_LOGIN_NO_REQUEST');
  assert.strictEqual(ledgerWrites, 0);
});

// ── §2: ambiguous / failed permission lookup must NOT produce a warning ───────
test('recordPunchLateEvent: a FAILED permission lookup aborts (no record, no warning) for retry', async () => {
  let created = 0;
  d365.getList = async (entity, opts) => {
    const f = String(opts?.filter || '');
    if (entity === LATE && /hr_date eq/.test(f)) throw new Error('dataverse 503');   // lookup FAILS
    return { data: [] };
  };
  d365.create = async () => { created++; return { hr_lateloginid: 'X' }; };
  await assert.rejects(() => lateLogin.recordPunchLateEvent({ employeeId: 'E1', employeeName: 'Emp', date: '2026-11-06', firstPunch: '09:30', shiftStart: '09:00' }), /503/);
  await new Promise(r => setImmediate(r));
  assert.strictEqual(created, 0, 'no record created on an ambiguous lookup');
  assert.strictEqual(sent.length, 0, 'no warning sent on an ambiguous lookup');
});

// ── §2: a late-arriving request after an auto record exists → duplicate-guarded (409), no contradiction ──
test('request submitted AFTER a punch auto record exists → rejected 409 (no duplicate/contradictory email)', async () => {
  d365.getByIdOptional = async (entity) => (entity === EMP
    ? { hr_hremployeeid: 'E1', hr_shiftstarttime: '09:00', hr_shiftendtime: '18:00', hr_email: 'emp@crmonce.com', hr_hremployee1: 'Emp' } : {});
  d365.getList = async (entity, opts) => {
    const f = String(opts?.filter || '');
    if (entity === LATE && /hr_date eq/.test(f)) return { data: [{ hr_lateloginid: 'AUTO1', hr_status: 'auto_approved' }] };   // auto record already present
    if (entity === LATE && /hr_month eq/.test(f)) return { data: [] };
    return { data: [] };
  };
  let created = 0; d365.create = async () => { created++; return { hr_lateloginid: 'REC' }; };
  await assert.rejects(() => lateLogin.create({ employeeId: 'E1', employeeName: 'Emp', date: '2026-11-06', actualTime: '09:30', reason: 'r', requestType: 'late_login' }), (e) => e.status === 409);
  await new Promise(r => setImmediate(r));
  assert.strictEqual(created, 0, 'the second record is never created');
  assert.strictEqual(sent.length, 0, 'no confirmation email for the rejected duplicate');
});
