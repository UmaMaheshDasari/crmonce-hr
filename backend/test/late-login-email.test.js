/**
 * Late Login (manual request) — now an INFORMATION record, NOT an approval workflow.
 *   • Submission → information-only HR email (no Approve/Reject, no token), FROM the
 *     employee's own mailbox.
 *   • Daily verification job → if the employee checked in, mark 'completed'; else mark
 *     'absent_leave_required' and email the employee to apply Leave (deduped by ledger).
 *
 * Microsoft Graph is never contacted (mock transport). No live data.
 */
process.env.NODE_ENV = 'test';
process.env.EMAIL_DRY_RUN = 'true';
process.env.TENANT_MAIL_DOMAINS = 'crmonce.com';
process.env.AZURE_CLIENT_ID = process.env.AZURE_CLIENT_ID || 'test-client';
process.env.AZURE_CLIENT_SECRET = process.env.AZURE_CLIENT_SECRET || 'test-secret';
process.env.AZURE_TENANT_ID = process.env.AZURE_TENANT_ID || 'test-tenant';

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const notif = require('../src/services/notification.service');
const ledger = require('../src/services/notification-ledger.service');
const T = require('../src/services/email/templates');
const lateLogin = require('../src/services/late-login.service');
const d365 = require('../src/services/d365.service');

const LATE = d365.constructor.entities.lateLogin;
const ATT = d365.constructor.entities.attendance;
const EMP = d365.constructor.entities.employee;

const recipientsOf = (r) => [...r.body.message.toRecipients, ...r.body.message.ccRecipients].map(x => x.emailAddress.address);
const hasButtons = (html) => /action=(approved|rejected)|>Approve<|>Reject</.test(html);

// In-memory ledger store (mirrors the Dataverse key semantics) for dedup assertions.
function memStore() {
  const rows = [];
  const key = (e, d, t) => `${e}|${String(d ?? '').slice(0, 10)}|${t}`;
  return {
    rows,
    async hasSent(e, d, t) { return rows.some(r => r.k === key(e, d, t) && r.status === 'sent'); },
    async record(rec) { rows.push({ k: key(rec.employeeId, rec.date, rec.type), ...rec }); },
  };
}

let orig;
beforeEach(() => {
  orig = { gio: d365.getByIdOptional, gl: d365.getList, glo: d365.getListOptional, up: d365.update };
  notif.clearOutbox();
  notif.setTransport(() => {});
});
afterEach(() => {
  d365.getByIdOptional = orig.gio; d365.getList = orig.gl; d365.getListOptional = orig.glo; d365.update = orig.up;
  notif.resetTransport(); notif.clearOutbox(); ledger.setStore(null);
});

// ── Templates (pure, no network) ────────────────────────────────────────────
test('lateLoginInfo template: information-only HR email — no Approve/Reject, full details', () => {
  const { subject, html } = T.lateLoginInfo({
    employeeName: 'Boina Vishwesh', employeeId: 'E1', department: 'Engineering',
    date: '14 August 2026', expectedTime: '09:00 AM', actualTime: '10:15 AM', lateBy: 75, reason: 'Bank work', remarks: 'nil',
  });
  assert.strictEqual(subject, 'Late Login Information - Boina Vishwesh - 14 August 2026');
  assert.match(html, /Dear HR/);
  assert.match(html, /Boina Vishwesh/);
  assert.match(html, /E1/);                          // employee id
  assert.match(html, /09:00 AM/);                    // expected
  assert.match(html, /10:15 AM/);                    // actual
  assert.match(html, /75 minutes/);                  // late by
  assert.match(html, /Bank work/);                   // reason (full)
  assert.match(html, /No approval is required/i);
  assert.strictEqual(hasButtons(html), false);       // NO approve/reject
});

test('lateLoginLeaveRequired template: guidance to apply Leave — no buttons', () => {
  const { subject, html } = T.lateLoginLeaveRequired({ employeeName: 'Boina Vishwesh', date: '15 August 2026' });
  assert.strictEqual(subject, 'Leave Request Required - 15 August 2026');
  assert.match(html, /no Check-In was recorded/i);
  assert.match(html, /apply for Leave/i);
  assert.strictEqual(hasButtons(html), false);
});

test('lateByMinutes: actual − expected, no grace subtracted', () => {
  assert.strictEqual(lateLogin.lateByMinutes('09:00', '10:15'), 75);
  assert.strictEqual(lateLogin.lateByMinutes('09:30', '09:42'), 12);
  assert.strictEqual(lateLogin.lateByMinutes('09:00', '09:03'), 3);   // still recorded; not gated away
  assert.strictEqual(lateLogin.lateByMinutes('', ''), null);
});

// ── HR information email: FROM employee mailbox, TO HR, no buttons ──────────
test('emailLateLoginInfoToHR: FROM the employee mailbox, TO HR, information-only', async () => {
  d365.getByIdOptional = async (entity) => (entity === EMP
    ? { hr_email: 'vishwesh@crmonce.com', hr_hremployee1: 'Boina Vishwesh', hr_department: 'Engineering' } : {});
  d365.getList = async (entity) => (entity === EMP
    ? { data: [{ hr_email: 'hr@crmonce.com' }, { hr_email: 'admin@crmonce.com' }] } : { data: [] });

  const sent = [];
  notif.setTransport((req, ctx) => sent.push({ req, ctx }));
  await lateLogin.emailLateLoginInfoToHR({
    employeeId: 'E1', employeeName: 'Boina Vishwesh', date: '2026-08-14',
    expectedTime: '09:00', actualTime: '10:15', reason: 'Bank work', remarks: '',
  });
  assert.strictEqual(sent.length, 1, 'one HR information email');
  assert.strictEqual(sent[0].req.sender, 'vishwesh@crmonce.com');           // FROM employee mailbox
  assert.deepStrictEqual(recipientsOf(sent[0].req).sort(), ['admin@crmonce.com', 'hr@crmonce.com']);   // TO HR
  assert.strictEqual(sent[0].ctx.meta.type, 'late_login_info');
  assert.strictEqual(hasButtons(sent[0].ctx.html), false);
  assert.match(sent[0].ctx.subject, /^Late Login Information - Boina Vishwesh/);
});

test('emailLateLoginInfoToHR: employee without a company mailbox → skipped, no throw', async () => {
  d365.getByIdOptional = async () => ({ hr_email: 'someone@gmail.com', hr_hremployee1: 'X' });
  d365.getList = async () => ({ data: [{ hr_email: 'hr@crmonce.com' }] });
  const sent = [];
  notif.setTransport((req, ctx) => sent.push({ req, ctx }));
  await lateLogin.emailLateLoginInfoToHR({ employeeId: 'E1', employeeName: 'X', date: '2026-08-14', expectedTime: '09:00', actualTime: '10:00', reason: 'r' });
  assert.strictEqual(sent.length, 0, 'external mailbox → nothing sent, submission not broken');
});

// ── Daily verification job ──────────────────────────────────────────────────
function stubForVerify({ status = 'submitted', punches = null } = {}) {
  const updates = [];
  const row = { hr_lateloginid: 'LL1', hr_employeeid: 'E1', hr_employeename: 'Boina Vishwesh', hr_date: '2026-08-15', hr_status: status };
  d365.getListOptional = async (entity) => (entity === LATE ? { data: [row] } : { data: [] });
  d365.getByIdOptional = async (entity) => (entity === EMP ? { hr_email: 'vishwesh@crmonce.com', hr_hremployee1: 'Boina Vishwesh' } : {});
  d365.getList = async (entity) => {
    if (entity === ATT) return { data: punches ? [{ hr_allpunches: JSON.stringify(punches) }] : [] };
    if (entity === EMP) return { data: [{ hr_email: 'hr@crmonce.com' }] };
    return { data: [] };
  };
  d365.update = async (_e, id, patch) => { updates.push({ id, patch }); return {}; };
  return updates;
}

test('verify: employee checked in → record marked completed, NO leave email', async () => {
  ledger.setStore(memStore());
  const updates = stubForVerify({ punches: [{ t: '10:15', d: 'in' }] });
  const sent = [];
  notif.setTransport((req, ctx) => sent.push({ req, ctx }));
  const r = await lateLogin.verifyTodaysAttendance();
  assert.strictEqual(r.attended, 1);
  assert.strictEqual(r.absent, 0);
  assert.deepStrictEqual(updates.map(u => u.patch.hr_status), ['completed']);
  assert.strictEqual(sent.length, 0, 'no leave email when present');
});

test('verify: no check-in → marked absent_leave_required + ONE leave email to employee', async () => {
  ledger.setStore(memStore());
  const updates = stubForVerify({ punches: null });
  const sent = [];
  notif.setTransport((req, ctx) => sent.push({ req, ctx }));
  const r = await lateLogin.verifyTodaysAttendance();
  assert.strictEqual(r.absent, 1);
  assert.deepStrictEqual(updates.map(u => u.patch.hr_status), ['absent_leave_required']);
  assert.strictEqual(sent.length, 1, 'one leave-required email');
  assert.deepStrictEqual(recipientsOf(sent[0].req), ['vishwesh@crmonce.com']);   // TO the employee
  assert.match(sent[0].ctx.subject, /^Leave Request Required/);
  assert.strictEqual(hasButtons(sent[0].ctx.html), false);
});

test('verify: re-run (or a second PM2 worker) → the leave email is NOT sent twice (ledger dedup)', async () => {
  const store = memStore();
  ledger.setStore(store);
  const sent = [];
  notif.setTransport((req, ctx) => sent.push({ req, ctx }));

  stubForVerify({ punches: null });
  await lateLogin.verifyTodaysAttendance();      // worker A
  stubForVerify({ punches: null });              // worker B sees the same (unpunched) day
  await lateLogin.verifyTodaysAttendance();

  assert.strictEqual(sent.length, 1, 'exactly ONE leave email across both runs');
  assert.strictEqual(store.rows.filter(r => r.status === 'sent' && r.type === 'LATE_LOGIN_LEAVE_REQUIRED').length, 1);
});
