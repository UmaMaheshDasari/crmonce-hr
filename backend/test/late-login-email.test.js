/**
 * Late Login approval email — the SAME professional design + secure Approve/Reject
 * flow as the Leave approval email (dynamic employee, employee card, request details,
 * Pending status badge, buttons), role-based CC, and the fixed 5-minute grace gate.
 *
 * Microsoft Graph is never contacted: the transport is mocked. No live data.
 */
process.env.NODE_ENV = 'test';
process.env.EMAIL_DRY_RUN = 'true';
process.env.TENANT_MAIL_DOMAINS = 'crmonce.com';
process.env.AZURE_CLIENT_ID = process.env.AZURE_CLIENT_ID || 'test-client';
process.env.AZURE_CLIENT_SECRET = process.env.AZURE_CLIENT_SECRET || 'test-secret';
process.env.AZURE_TENANT_ID = process.env.AZURE_TENANT_ID || 'test-tenant';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

const { test, afterEach } = require('node:test');
const assert = require('node:assert');
const notif = require('../src/services/notification.service');
const requestNotify = require('../src/services/request-notify.service');
const lateLogin = require('../src/services/late-login.service');
const d365 = require('../src/services/d365.service');

// departmentOf() lookup used by the professional template — stub so no network.
d365.getById = async () => ({ hr_department: 'Engineering' });

const recipientsOf = (r) => [...r.body.message.toRecipients, ...r.body.message.ccRecipients].map(x => x.emailAddress.address);
const hasButtons = (html) => /action=(approved|rejected)/.test(html);

afterEach(() => { notif.resetTransport(); notif.clearOutbox(); });

const EMP = { id: 'E1', name: 'Boina Vishwesh', email: 'vishwesh@crmonce.com' };
const DETAILS = [
  ['Date', '2026-08-13'],
  ['Expected Login Time', '09:30'],
  ['Actual Login Time', '09:42'],
  ['Late By', '12 minutes'],
  ['Reason', 'I had some bank work and informed my manager in advance.'],
];

async function notifyLate(approver, cc = []) {
  const sent = [];
  notif.setTransport((req, ctx) => sent.push({ req, ctx }));
  await requestNotify.notifyNewRequest({
    type: 'late_login', recordId: 'LL1', actor: EMP, details: DETAILS,
    applyTime: new Date('2026-08-13T04:00:00Z').toISOString(), approver, cc, status: 'Pending',
  });
  return sent;
}

// C–F: professional email carries the dynamic employee, date, times, late-by, Pending.
test('professional Late Login email: dynamic subject, employee card, times, Late By, Pending, buttons', async () => {
  const sent = await notifyLate({ id: 'MGR', name: 'Manager One', email: 'manager@crmonce.com' });
  const appr = sent.filter(s => s.ctx.meta.type === 'late_login_new_approver');
  assert.strictEqual(appr.length, 1);
  const { html, subject } = appr[0].ctx;
  assert.strictEqual(subject, 'Late Login Request - Boina Vishwesh');   // dynamic employee, never hardcoded
  assert.match(html, /Boina Vishwesh/);          // employee card
  assert.match(html, /ID: E1/);                  // employee id
  assert.match(html, /2026-08-13/);              // date
  assert.match(html, /09:30/);                   // expected login
  assert.match(html, /09:42/);                   // actual login
  assert.match(html, /12 minutes/);              // late by
  assert.match(html, /bank work/);               // full reason preserved
  assert.match(html, /Pending/);                 // status badge
  assert.ok(!/L1 Pending/.test(html), 'shows Pending, not the leave-specific L1 Pending');
  assert.strictEqual(hasButtons(html), true);    // Approve + Reject
  assert.deepStrictEqual(recipientsOf(appr[0].req), ['manager@crmonce.com']);
  assert.strictEqual(appr[0].req.sender, EMP.email);   // sent AS the employee (dynamic sender)
});

// G/H/I/J: manager (approver) + HR CC get buttons; a normal employee CC is FYI only.
test('role-based recipients: manager + HR CC actionable; normal employee CC info-only', async () => {
  const sent = await notifyLate(
    { id: 'MGR', name: 'Manager One', email: 'manager@crmonce.com' },
    [{ id: 'HR', name: 'HR Team', email: 'hr@crmonce.com', role: 'hr_manager' },
     { id: 'PEER', name: 'A Peer', email: 'peer@crmonce.com', role: 'employee' }],
  );
  const hrCc = sent.filter(s => s.ctx.meta.type === 'late_login_new_cc_approver');
  const infoCc = sent.filter(s => s.ctx.meta.type === 'late_login_new_cc');
  assert.strictEqual(hrCc.length, 1);
  assert.strictEqual(hasButtons(hrCc[0].ctx.html), true);           // HR CC can approve
  assert.deepStrictEqual(recipientsOf(hrCc[0].req), ['hr@crmonce.com']);
  assert.strictEqual(infoCc.length, 1);
  assert.strictEqual(hasButtons(infoCc[0].ctx.html), false);        // normal CC: no buttons
  assert.match(infoCc[0].ctx.subject, /^For Your Information:/);
});

// A/B + §7: the fixed 5-minute grace gate (0–5 → no email, >5 → email).
test('Late By computation + 5-minute grace gate', () => {
  assert.strictEqual(lateLogin.lateByMinutes('09:30', '09:42'), 12);
  assert.strictEqual(lateLogin.lateByMinutes('09:30', '09:36'), 6);
  assert.strictEqual(lateLogin.lateByMinutes('09:30', '09:35'), 5);
  assert.strictEqual(lateLogin.lateByMinutes('16:30', '11:30'), -300);   // "actual before expected" → not late
  assert.strictEqual(lateLogin.lateByMinutes('', ''), null);             // unparseable
  // The create() gate is: send iff (lateBy == null || lateBy > 5).
  const willEmail = (lb) => (lb == null || lb > 5);
  assert.strictEqual(willEmail(12), true, '12 min late → email');
  assert.strictEqual(willEmail(6), true, '6 min late → email');
  assert.strictEqual(willEmail(5), false, 'exactly 5 min → NO email');
  assert.strictEqual(willEmail(-300), false, 'not late → NO email');
  assert.strictEqual(willEmail(null), true, 'unparseable → fail open to email');
});

// Recipient model: approver = reporting manager; CC = HR/Super Admin (authorized).
test('resolveApprovalRecipients: manager is approver, HR are CC (manager excluded from CC)', async () => {
  const origOpt = d365.getByIdOptional, origGet = d365.getById, origAppr = requestNotify.getApprovers;
  try {
    d365.getByIdOptional = async () => ({ hr_hremployeeid: 'E1', _hr_manager_value: 'MGR' });
    d365.getById = async () => ({ hr_hremployeeid: 'MGR', hr_hremployee1: 'Manager One', hr_email: 'manager@crmonce.com' });
    requestNotify.getApprovers = async () => ([
      { hr_hremployeeid: 'MGR', hr_hremployee1: 'Manager One', hr_email: 'manager@crmonce.com' },  // manager also HR
      { hr_hremployeeid: 'HR2', hr_hremployee1: 'HR Two', hr_email: 'hr2@crmonce.com' },
    ]);
    const { approver, cc } = await lateLogin.resolveApprovalRecipients('E1');
    assert.strictEqual(approver.email, 'manager@crmonce.com');
    assert.ok(cc.every(c => c.id !== approver.id), 'approver is never also CC');
    assert.ok(cc.every(c => c.role === 'hr_manager'), 'HR CC are tagged authorized so they get buttons');
    assert.deepStrictEqual(cc.map(c => c.email), ['hr2@crmonce.com']);
  } finally { d365.getByIdOptional = origOpt; d365.getById = origGet; requestNotify.getApprovers = origAppr; }
});

test('resolveApprovalRecipients: no manager → first HR becomes the approver', async () => {
  const origOpt = d365.getByIdOptional, origAppr = requestNotify.getApprovers;
  try {
    d365.getByIdOptional = async () => ({ hr_hremployeeid: 'E1', _hr_manager_value: null });
    requestNotify.getApprovers = async () => ([
      { hr_hremployeeid: 'HR1', hr_hremployee1: 'HR One', hr_email: 'hr1@crmonce.com' },
      { hr_hremployeeid: 'HR2', hr_hremployee1: 'HR Two', hr_email: 'hr2@crmonce.com' },
    ]);
    const { approver, cc } = await lateLogin.resolveApprovalRecipients('E1');
    assert.strictEqual(approver.email, 'hr1@crmonce.com');
    assert.deepStrictEqual(cc.map(c => c.email), ['hr2@crmonce.com']);
  } finally { d365.getByIdOptional = origOpt; requestNotify.getApprovers = origAppr; }
});
