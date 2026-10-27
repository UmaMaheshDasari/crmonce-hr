/**
 * Purpose-based email sender routing (spec §A–§E).
 *   HR-owned (HR approvals/rejections, ALL Late Login mail, HR notices) → HR_EMAIL_SENDER (HR@crmonce.com).
 *   INFO-owned (genuinely informational) → GRAPH_SENDER (info@crmonce.com).
 *   Employee submissions → employee's own mailbox, else INFO + Reply-To employee (no spoof).
 * No network: transport mocked / ledger stubbed; no real emails.
 */
process.env.NODE_ENV = 'test';
process.env.EMAIL_DRY_RUN = 'true';
process.env.TENANT_MAIL_DOMAINS = process.env.TENANT_MAIL_DOMAINS || 'crmonce.com';
process.env.AZURE_CLIENT_ID = process.env.AZURE_CLIENT_ID || 'x';
process.env.AZURE_CLIENT_SECRET = process.env.AZURE_CLIENT_SECRET || 'x';
process.env.AZURE_TENANT_ID = process.env.AZURE_TENANT_ID || 'x';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';   // approvalUrls (signApprovalToken) needs it

const { test, afterEach } = require('node:test');
const assert = require('node:assert');
const d365 = require('../src/services/d365.service');
const notif = require('../src/services/notification.service');
const ledger = require('../src/services/notification-ledger.service');
const sender = require('../src/services/email/sender');
const requestNotify = require('../src/services/request-notify.service');
const lateLogin = require('../src/services/late-login.service');
const goalNotify = require('../src/services/goal-notify.service');
const celebrations = require('../src/services/celebrations.service');
const PP = require('../src/services/permission-policy.service');

const toOf = (r) => r.body.message.toRecipients.map(x => x.emailAddress.address);
const ccOf = (r) => r.body.message.ccRecipients.map(x => x.emailAddress.address);

// ── Pure routing helpers ──────────────────────────────────────────────────────
test('hrSender(): defaults to HR@crmonce.com, honors HR_EMAIL_SENDER', () => {
  const prev = process.env.HR_EMAIL_SENDER; delete process.env.HR_EMAIL_SENDER;
  assert.strictEqual(sender.hrSender(), 'HR@crmonce.com');
  process.env.HR_EMAIL_SENDER = 'people@crmonce.com';
  assert.strictEqual(sender.hrSender(), 'people@crmonce.com');
  if (prev === undefined) delete process.env.HR_EMAIL_SENDER; else process.env.HR_EMAIL_SENDER = prev;
});

test('infoSender(): defaults to info@crmonce.com', () => {
  const prev = process.env.GRAPH_SENDER; delete process.env.GRAPH_SENDER;
  assert.strictEqual(sender.infoSender(), 'info@crmonce.com');
  if (prev === undefined) delete process.env.GRAPH_SENDER; else process.env.GRAPH_SENDER = prev;
});

test('employeeOrigin(): company mailbox → employee FROM; external → INFO + Reply-To; empty → INFO only (never spoof)', () => {
  assert.deepStrictEqual(sender.employeeOrigin('amy@crmonce.com'), { from: 'amy@crmonce.com' });
  assert.deepStrictEqual(sender.employeeOrigin('user@gmail.com'), { from: 'info@crmonce.com', replyTo: 'user@gmail.com' });
  assert.deepStrictEqual(sender.employeeOrigin(''), { from: 'info@crmonce.com' });
});

// ── INFO default: a caller that passes no `from` resolves to the INFO mailbox ──
test('INFO-owned (no explicit from) resolves the Graph sender to info@crmonce.com', () => {
  const req = notif.buildSendMailRequest({ to: 'x@crmonce.com', subject: 's', html: 'h' });
  assert.strictEqual(req.sender, 'info@crmonce.com');
});

// ── §C: Late Login policy stage email routes from HR ──────────────────────────
test('Late Login policy stage (4th → HR warning) routes FROM the HR sender', async () => {
  let captured;
  const o = { so: ledger.sendOnce, gio: d365.getByIdOptional, gl: d365.getList };
  ledger.sendOnce = async (opts) => { captured = opts; return { sent: true }; };
  d365.getByIdOptional = async () => ({ hr_email: 'emp@crmonce.com', hr_hremployee1: 'E', _hr_manager_value: null });
  d365.getList = async () => ({ data: [{ hr_email: 'hr@crmonce.com' }] });
  try {
    await lateLogin.notifyPolicyOutcome({ employeeId: 'E1', name: 'E', label: 'Late Login', requestType: 'late_login', date: '2026-11-05', decision: PP.decide(3), requested: false });
    assert.strictEqual(captured.type, 'LATE_LOGIN_HR_WARNING');
    assert.strictEqual(captured.from, 'HR@crmonce.com');
  } finally { ledger.sendOnce = o.so; d365.getByIdOptional = o.gio; d365.getList = o.gl; }
});

// ── §B: HR approval/rejection decision routes from HR (not the approver, not INFO) ──
test('HR decision email routes FROM the HR sender (not the approver mailbox, not INFO)', async () => {
  const o = { gbi: d365.getById };
  d365.getById = async () => ({ hr_hremployee1: 'Emp', hr_email: 'emp@crmonce.com' });
  const sent = []; notif.setTransport((req, ctx) => sent.push({ req, ctx }));
  try {
    await requestNotify.emailDecisionToEmployee({ type: 'missing_punch', employeeId: 'E1', decision: 'approved', approver: { name: 'HR One', email: 'hr1@crmonce.com' }, status: 'Approved' });
    assert.strictEqual(sent.length, 1);
    assert.strictEqual(sent[0].req.sender, 'HR@crmonce.com');
  } finally { notif.resetTransport(); notif.clearOutbox(); d365.getById = o.gbi; }
});

// ── mergeCc (pure) — dedupe, exclude TO, exclude sender (no self-CC), drop placeholders ──
test('mergeCc(): de-dupes (case-insensitive), excludes TO + sender, drops placeholder domains', () => {
  assert.deepStrictEqual(
    sender.mergeCc([['info@crmonce.com', 'HR@crmonce.com', 'info@CRMONCE.com'], 'admin@yourcompany.com'],
      { excludeTo: ['hr@crmonce.com'], from: 'HR@crmonce.com' }),
    ['info@crmonce.com']);   // HR@ dropped (==from, case-insensitive), yourcompany.com placeholder dropped, dupe collapsed
  assert.deepStrictEqual(sender.mergeCc([sender.infoSender()], { excludeTo: [], from: 'info@crmonce.com' }), []);   // never CC the sender itself
});

// ── §C/§D decisionRouting (pure) — derived from the approver identity, not a body field ──
test('decisionRouting(): HR/Super Admin/manager approver → From HR@, CC info@ (§C)', () => {
  assert.deepStrictEqual(sender.decisionRouting({ email: 'umamahesh@crmonce.com', role: 'super_admin' }), { from: 'HR@crmonce.com', cc: 'info@crmonce.com' });
  assert.deepStrictEqual(sender.decisionRouting({ email: 'hr@crmonce.com', role: 'hr_manager' }), { from: 'HR@crmonce.com', cc: 'info@crmonce.com' });
  assert.deepStrictEqual(sender.decisionRouting({}), { from: 'HR@crmonce.com', cc: 'info@crmonce.com' });   // unknown approver → HR default
});
test('decisionRouting(): INFO mailbox approver → From info@, CC HR@ (§D)', () => {
  assert.deepStrictEqual(sender.decisionRouting({ email: 'INFO@crmonce.com' }), { from: 'info@crmonce.com', cc: 'HR@crmonce.com' });
});

// ── §C: HR decision — FROM HR@, TO employee, CC info@ (real CC line in the Graph payload) ──
test('HR decision email: FROM HR@, TO employee, CC info@ (§C) — CC present in the Graph payload', async () => {
  const o = { gbi: d365.getById };
  d365.getById = async () => ({ hr_hremployee1: 'Emp', hr_email: 'emp@crmonce.com' });
  const sent = []; notif.setTransport((req) => sent.push(req));
  try {
    await requestNotify.emailDecisionToEmployee({ type: 'missing_punch', employeeId: 'E1', decision: 'approved', approver: { name: 'HR One', email: 'hr1@crmonce.com', role: 'hr_manager' }, status: 'Approved' });
    assert.strictEqual(sent.length, 1);                                  // exactly one email (no duplicate)
    assert.strictEqual(sent[0].sender, 'HR@crmonce.com');
    assert.deepStrictEqual(toOf(sent[0]), ['emp@crmonce.com']);
    assert.deepStrictEqual(ccOf(sent[0]), ['info@crmonce.com']);         // §C CC — real ccRecipients in the payload
  } finally { notif.resetTransport(); notif.clearOutbox(); d365.getById = o.gbi; }
});

// ── §D: Info-mailbox approver decision — FROM info@, TO employee, CC HR@ ──
test('INFO-approver decision email: FROM info@, TO employee, CC HR@ (§D)', async () => {
  const o = { gbi: d365.getById };
  d365.getById = async () => ({ hr_hremployee1: 'Emp', hr_email: 'emp@crmonce.com' });
  const sent = []; notif.setTransport((req) => sent.push(req));
  try {
    await requestNotify.emailDecisionToEmployee({ type: 'missing_punch', employeeId: 'E1', decision: 'rejected', approver: { name: 'Info Desk', email: 'info@crmonce.com' }, status: 'Rejected' });
    assert.strictEqual(sent[0].sender, 'info@crmonce.com');
    assert.deepStrictEqual(ccOf(sent[0]), ['HR@crmonce.com']);
  } finally { notif.resetTransport(); notif.clearOutbox(); d365.getById = o.gbi; }
});

// ── req 11: a decision for an employee with NO email is skipped safely (no send, no throw) ──
test('decision with a missing employee email → nothing sent, no throw (safe)', async () => {
  const o = { gbi: d365.getById };
  d365.getById = async () => ({ hr_hremployee1: 'Emp', hr_email: '' });
  const sent = []; notif.setTransport((req) => sent.push(req));
  try {
    await requestNotify.emailDecisionToEmployee({ type: 'missing_punch', employeeId: 'E1', decision: 'approved', approver: { name: 'HR', email: 'hr1@crmonce.com' } });
    assert.strictEqual(sent.length, 0);
  } finally { notif.resetTransport(); notif.clearOutbox(); d365.getById = o.gbi; }
});

// ── req 13: a Graph transport failure is handled without throwing into the caller ──
test('Graph send failure is handled safely (sendEmail resolves { success:false }, never throws)', async () => {
  notif.setTransport(() => { throw new Error('graph 503'); });
  try {
    const r = await notif.sendEmail('emp@crmonce.com', 's', '<p>h</p>', { from: sender.hrSender(), cc: [sender.infoSender()] });
    assert.strictEqual(r.success, false);
  } finally { notif.resetTransport(); notif.clearOutbox(); }
});

// ── §A: leave submission — approver email CC's info@ (once), real ccRecipients in the payload ──
test('leave submission (notifyNewRequest): approver on TO, INFO mailbox on CC (§A)', async () => {
  const o = { gio: d365.getByIdOptional };
  d365.getByIdOptional = async () => ({ hr_department: 'Eng', hr_employeeid: 'EMP1001' });
  const sent = []; notif.setTransport((req) => sent.push(req));
  try {
    await requestNotify.notifyNewRequest({
      type: 'leave', recordId: 'LV1',
      actor: { id: 'E1', name: 'Amy', email: 'amy@crmonce.com' },
      details: [['Type', 'Casual Leave']], applyTime: new Date('2026-11-01T04:00:00Z').toISOString(),
      approver: { id: 'A1', name: 'Mgr', email: 'mgr@crmonce.com' }, cc: [], status: 'L1 Pending',
    });
    const approverMail = sent.find(r => toOf(r).includes('mgr@crmonce.com'));
    assert.ok(approverMail, 'approver email sent');
    assert.strictEqual(approverMail.sender, 'amy@crmonce.com');           // §A FROM employee
    assert.deepStrictEqual(ccOf(approverMail), ['info@crmonce.com']);     // §A CC info@ (real payload CC)
  } finally { notif.resetTransport(); notif.clearOutbox(); d365.getByIdOptional = o.gio; }
});

// ── §E: goal assignment — FROM HR@, TO employee, CC includes info@ ──
test('goal assignment notification: FROM HR@, TO employee, CC includes info@ (§E)', async () => {
  const o = { gbi: d365.getById, up: d365.update };
  d365.getById = async (_e, id) => (String(id) === 'E1'
    ? { hr_hremployee1: 'Amy', hr_email: 'amy@crmonce.com', _hr_manager_value: null } : {});
  d365.update = async () => ({});
  const sent = []; notif.setTransport((req) => sent.push(req));
  try {
    await goalNotify.notifyGoalAssigned({ goal: { hr_hrgoalid: `G-${Date.now()}`, hr_hrgoal1: 'Q4 Target' }, assigner: { name: 'Mgr', email: 'mgr@crmonce.com' }, employeeId: 'E1' });
    assert.strictEqual(sent.length, 1);
    assert.strictEqual(sent[0].sender, 'HR@crmonce.com');
    assert.deepStrictEqual(toOf(sent[0]), ['amy@crmonce.com']);
    assert.ok(ccOf(sent[0]).includes('info@crmonce.com'), 'INFO mailbox is CC\'d on the goal email');
  } finally { notif.resetTransport(); notif.clearOutbox(); d365.getById = o.gbi; d365.update = o.up; }
});

// ── §E: holiday/celebration wish — FROM HR@, TO employee, CC info@ ──
test('celebration wish (sendOne): FROM HR@, TO employee, CC info@ (§E)', async () => {
  const sent = []; notif.setTransport((req) => sent.push(req));
  try {
    const settings = { ccRecipients: '', templates: { birthday: { subject: '🎉 {name}', body: 'Dear {firstName}', notif: 'hi' } } };
    await celebrations.sendOne('birthday', { id: 'E1', name: 'Amy', firstName: 'Amy', email: 'amy@crmonce.com' }, settings);
    assert.strictEqual(sent.length, 1);
    assert.strictEqual(sent[0].sender, 'HR@crmonce.com');
    assert.deepStrictEqual(toOf(sent[0]), ['amy@crmonce.com']);
    assert.deepStrictEqual(ccOf(sent[0]), ['info@crmonce.com']);
  } finally { notif.resetTransport(); notif.clearOutbox(); }
});

afterEach(() => { try { notif.resetTransport(); notif.clearOutbox(); } catch (_) {} });
