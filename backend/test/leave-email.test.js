/**
 * Leave Email workflow — validates Sender / Recipients / CC / Subject / Body /
 * Attachments / Approval Links WITHOUT sending any email.
 *
 * Microsoft Graph is never contacted: the transport is mocked (setTransport) and
 * the payload builder is pure. No real leave requests, no production data.
 */
process.env.NODE_ENV = 'test';
process.env.EMAIL_DRY_RUN = 'true';          // never send; mock only
process.env.TENANT_MAIL_DOMAINS = 'crmonce.com';
// Non-empty dummy creds so the MSAL client constructs; the startup token probe is
// skipped in NODE_ENV=test, so nothing hits the network.
process.env.AZURE_CLIENT_ID = process.env.AZURE_CLIENT_ID || 'test-client';
process.env.AZURE_CLIENT_SECRET = process.env.AZURE_CLIENT_SECRET || 'test-secret';
process.env.AZURE_TENANT_ID = process.env.AZURE_TENANT_ID || 'test-tenant';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';   // signs approval links

const { test, afterEach } = require('node:test');
const assert = require('node:assert');

const { resolveSender, validateCompanyEmail } = require('../src/services/email/sender');
const notif = require('../src/services/notification.service');
const T = require('../src/services/email/templates');
const requestNotify = require('../src/services/request-notify.service');
const d365 = require('../src/services/d365.service');

// Stub the only D365 read the apply-notify path makes (department lookup) so no
// network is touched. Mailbox verification is skipped under the mock transport.
d365.getById = async () => ({ hr_department: 'Engineering' });

// Helpers to read a captured Graph request.
const recipientsOf = (r) => [...r.body.message.toRecipients, ...r.body.message.ccRecipients].map(x => x.emailAddress.address);
const hasButtons = (html) => /action=(approved|rejected)/.test(html);

afterEach(() => { notif.resetTransport(); notif.clearOutbox(); });

// ── Sender resolution (dynamic, no fallback) ────────────────────────────────
test('sender: employee company mailbox is valid', () => {
  assert.deepStrictEqual(resolveSender({ email: 'vishwesh@crmonce.com' }), { ok: true, sender: 'vishwesh@crmonce.com' });
});

test('sender: missing email → "Employee email not configured"', () => {
  const r = resolveSender({ email: '', label: 'Employee' });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'Employee email not configured');
});

test('sender: external (gmail) mailbox rejected with exact reason (no fallback)', () => {
  const r = resolveSender({ email: 'teja99835@gmail.com' });
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /company mailbox/);
  assert.match(r.reason, /crmonce\.com/);
});

test('sender: placeholder domain rejected', () => {
  assert.strictEqual(resolveSender({ email: 'admin@yourcompany.com' }).ok, false);
});

test('security: HR and Super Admin resolve to their own tenant mailboxes', () => {
  assert.strictEqual(resolveSender({ email: 'hr@crmonce.com' }).sender, 'hr@crmonce.com');
  assert.strictEqual(resolveSender({ email: 'umamahesh@crmonce.com' }).sender, 'umamahesh@crmonce.com');
});

test('security: sender is ALWAYS the input mailbox — no impersonation path', () => {
  for (const e of ['vishwesh@crmonce.com', 'hr@crmonce.com', 'umamahesh@crmonce.com']) {
    const r = resolveSender({ email: e });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.sender, e);   // never resolves to a different mailbox
  }
});

// ── Company-email validation (HR create/edit + apply) ───────────────────────
test('validateCompanyEmail: accepts @crmonce.com, rejects external/empty/malformed', () => {
  assert.strictEqual(validateCompanyEmail('vishwesh@crmonce.com').ok, true);
  assert.strictEqual(validateCompanyEmail('').ok, false);
  assert.match(validateCompanyEmail('').reason, /not configured/);
  assert.match(validateCompanyEmail('vishwesh@gmail.com').reason, /company mailbox/);
  assert.match(validateCompanyEmail('foo@yahoo.com').reason, /company mailbox/);
  assert.match(validateCompanyEmail('foo@outlook.com').reason, /company mailbox/);
  assert.match(validateCompanyEmail('not-an-email').reason, /format is invalid/);
});

// ── Mailbox verification is skipped offline (no Graph in dev/test) ──────────
test('verifyMailbox: skipped (ok) under dry-run/test — never hits Graph', async () => {
  const r = await notif.verifyMailbox('vishwesh@crmonce.com');
  assert.deepStrictEqual(r, { ok: true, skipped: true });
});

// ── Payload builder (pure — no network) ─────────────────────────────────────
test('buildSendMailRequest: FROM employee, TO approver, real CC line', () => {
  const req = notif.buildSendMailRequest({
    from: 'vishwesh@crmonce.com',
    to: 'hr@crmonce.com',
    cc: ['peer1@crmonce.com', { email: 'peer2@crmonce.com', name: 'Peer Two' }],
    subject: 'Leave Request - Vishwesh Boina',
    html: '<p>body</p>',
  });
  assert.strictEqual(req.sender, 'vishwesh@crmonce.com');
  assert.strictEqual(req.url, 'https://graph.microsoft.com/v1.0/users/vishwesh%40crmonce.com/sendMail');
  assert.deepStrictEqual(req.body.message.toRecipients, [{ emailAddress: { address: 'hr@crmonce.com' } }]);
  assert.deepStrictEqual(req.body.message.ccRecipients, [
    { emailAddress: { address: 'peer1@crmonce.com' } },
    { emailAddress: { address: 'peer2@crmonce.com', name: 'Peer Two' } },
  ]);
  assert.strictEqual(req.body.message.subject, 'Leave Request - Vishwesh Boina');
  assert.strictEqual(req.body.message.body.content, '<p>body</p>');
});

test('buildSendMailRequest: no CC → empty ccRecipients (never auto-CC info@/HR@)', () => {
  const req = notif.buildSendMailRequest({ from: 'a@crmonce.com', to: 'b@crmonce.com', subject: 's', html: 'h' });
  assert.deepStrictEqual(req.body.message.ccRecipients, []);
});

test('buildSendMailRequest: attachments mapped to Graph fileAttachment', () => {
  const req = notif.buildSendMailRequest({
    from: 'hr@crmonce.com', to: 'emp@crmonce.com', subject: 's', html: 'h',
    attachments: [{ name: 'leave.ics', contentType: 'text/calendar', contentBytes: 'AAAA' }],
  });
  assert.strictEqual(req.body.message.attachments[0]['@odata.type'], '#microsoft.graph.fileAttachment');
  assert.strictEqual(req.body.message.attachments[0].name, 'leave.ics');
});

test('buildSendMailRequest: from defaults to GRAPH_SENDER when omitted (backward compat)', () => {
  const req = notif.buildSendMailRequest({ to: 'x@crmonce.com', subject: 's', html: 'h' });
  assert.strictEqual(req.sender, notif.GRAPH_SENDER);
});

// ── sendEmail through a MOCK transport — never calls Graph ───────────────────
test('sendEmail(mock): captures request, sends nothing to Graph', async () => {
  const captured = [];
  notif.setTransport((req) => { captured.push(req); });   // intercept — no network

  const res = await notif.sendEmail('hr@crmonce.com', 'Leave Request - Vishwesh Boina', '<p>hi</p>', {
    from: 'vishwesh@crmonce.com',
    cc: ['peer@crmonce.com'],
    meta: { type: 'leave_new_approver' },
  });

  assert.strictEqual(res.success, true);
  assert.strictEqual(res.mocked, true);                    // did NOT hit Graph
  assert.strictEqual(captured.length, 1);
  assert.strictEqual(captured[0].sender, 'vishwesh@crmonce.com');
  assert.deepStrictEqual(captured[0].body.message.toRecipients, [{ emailAddress: { address: 'hr@crmonce.com' } }]);
  assert.deepStrictEqual(captured[0].body.message.ccRecipients, [{ emailAddress: { address: 'peer@crmonce.com' } }]);

  const outbox = notif.getOutbox();
  assert.strictEqual(outbox.length, 1);
  assert.strictEqual(outbox[0].from, 'vishwesh@crmonce.com');
  assert.strictEqual(outbox[0].type, 'leave_new_approver');
});

test('sendEmail(mock): decision email FROM approver mailbox, CC original recipients', async () => {
  notif.setTransport(() => {});
  const res = await notif.sendEmail('vishwesh@crmonce.com', 'Leave Approved', '<p>ok</p>', {
    from: 'hr@crmonce.com',
    cc: ['peer@crmonce.com'],
    meta: { type: 'leave_decision' },
  });
  assert.strictEqual(res.request.sender, 'hr@crmonce.com');
  assert.strictEqual(res.request.url, 'https://graph.microsoft.com/v1.0/users/hr%40crmonce.com/sendMail');
  assert.deepStrictEqual(res.request.body.message.toRecipients, [{ emailAddress: { address: 'vishwesh@crmonce.com' } }]);
});

// ── Template: approval links present in the body ────────────────────────────
test('approver template: subject + Approve/Reject links present in body', () => {
  const { subject, html } = T.newRequestApprover({
    moduleTitle: 'Leave',
    employee: { name: 'Vishwesh Boina', department: 'Engineering', email: 'vishwesh@crmonce.com' },
    rows: [['Leave Type', 'Casual Leave'], ['From Date', '2026-07-20']],
    applyTime: new Date('2026-07-14T06:00:00Z').toISOString(),
    approverName: 'Uma Mahesh',
    approveUrl: 'https://app.example/approve?type=leave&id=123&action=approved&t=TOKENA',
    rejectUrl: 'https://app.example/approve?type=leave&id=123&action=rejected&t=TOKENR',
  });
  assert.strictEqual(subject, 'Leave Request - Vishwesh Boina');
  // & is HTML-escaped to &amp; inside href (correct HTML) — assert token + action.
  assert.match(html, /action=approved(&|&amp;)t=TOKENA/);
  assert.match(html, /action=rejected(&|&amp;)t=TOKENR/);
});

// ── Full apply workflow: one ack, one approver mail, informational CC, no dupes ─
const EMP = { id: 'E1', name: 'Vishwesh Boina', email: 'vishwesh@crmonce.com' };
const DETAILS = [['Leave Type', 'Casual Leave'], ['From Date', '2026-07-20']];
const APPLY_TIME = new Date('2026-07-14T06:00:00Z').toISOString();

async function runApply(approver, cc = []) {
  const sent = [];
  notif.setTransport((req, ctx) => sent.push({ req, ctx }));
  await requestNotify.notifyNewRequest({
    type: 'leave', recordId: 'L1', actor: EMP, details: DETAILS, applyTime: APPLY_TIME, approver, cc,
  });
  return sent;
}

test('employee acknowledgement: exactly ONE email, no buttons, not saved to Sent', async () => {
  const sent = [];
  notif.setTransport((req, ctx) => sent.push({ req, ctx }));
  await requestNotify.emailApplyAcknowledgement({
    type: 'leave', toEmail: EMP.email, employeeName: EMP.name, approverName: 'Uma Mahesh',
  });
  assert.strictEqual(sent.length, 1);                                   // exactly one
  assert.strictEqual(sent[0].ctx.subject, 'Leave Request Submitted');
  assert.deepStrictEqual(recipientsOf(sent[0].req), [EMP.email]);       // only the applicant
  assert.strictEqual(hasButtons(sent[0].ctx.html), false);             // NO action buttons
  assert.strictEqual(sent[0].req.body.saveToSentItems, false);
});

test('HR approver: ONE buttoned email, TO=HR only, employee never a recipient/sender copy', async () => {
  const sent = await runApply({ id: 'A1', name: 'HR Team', email: 'hr@crmonce.com' });
  const approver = sent.filter(s => s.ctx.meta.type === 'leave_new_approver');
  assert.strictEqual(approver.length, 1);                               // exactly one approval email
  assert.deepStrictEqual(recipientsOf(approver[0].req), ['hr@crmonce.com']);   // TO = HR only
  assert.strictEqual(hasButtons(approver[0].ctx.html), true);          // has Approve/Reject
  assert.strictEqual(approver[0].req.sender, EMP.email);               // sent AS the employee
  assert.strictEqual(approver[0].req.body.saveToSentItems, false);     // no copy in employee mailbox
  // employee is NOT a recipient of ANY message in this apply.
  for (const s of sent) assert.ok(!recipientsOf(s.req).includes(EMP.email));
});

test('Super Admin approver: ONE buttoned approval email to the Super Admin', async () => {
  const sent = await runApply({ id: 'A2', name: 'Uma Mahesh', email: 'umamahesh@crmonce.com' });
  const approver = sent.filter(s => s.ctx.meta.type === 'leave_new_approver');
  assert.strictEqual(approver.length, 1);
  assert.deepStrictEqual(recipientsOf(approver[0].req), ['umamahesh@crmonce.com']);
  assert.strictEqual(hasButtons(approver[0].ctx.html), true);
});

test('CC recipient: informational email only — NO action buttons, not the approver copy', async () => {
  const sent = await runApply(
    { id: 'A1', name: 'HR Team', email: 'hr@crmonce.com' },
    [{ id: 'C1', name: 'Peer One', email: 'peer@crmonce.com' }],
  );
  const cc = sent.filter(s => s.ctx.meta.type === 'leave_new_cc');
  assert.strictEqual(cc.length, 1);                                     // one FYI email
  assert.deepStrictEqual(recipientsOf(cc[0].req), ['peer@crmonce.com']);
  assert.strictEqual(hasButtons(cc[0].ctx.html), false);               // NO buttons for CC
  assert.match(cc[0].ctx.html, /information only/i);
});

test('no duplicate sends & employee never receives approval buttons', async () => {
  const sent = await runApply(
    { id: 'A1', name: 'HR Team', email: 'hr@crmonce.com' },
    [{ id: 'C1', name: 'Peer', email: 'peer@crmonce.com' }],
  );
  // Exactly 2 emails: 1 approver + 1 CC. No second approver / duplicate.
  assert.strictEqual(sent.length, 2);
  assert.strictEqual(sent.filter(s => s.ctx.meta.type === 'leave_new_approver').length, 1);
  assert.strictEqual(sent.filter(s => s.ctx.meta.type === 'leave_new_cc').length, 1);
  // Any message that carries buttons must NOT be addressed to the employee, and
  // must not be saved to the employee's mailbox.
  for (const s of sent) {
    if (hasButtons(s.ctx.html)) {
      assert.ok(!recipientsOf(s.req).includes(EMP.email));
      assert.strictEqual(s.req.body.saveToSentItems, false);
    }
  }
});

test('CC that is the applicant or approver is dropped (never self/loop CC)', async () => {
  const sent = await runApply(
    { id: 'A1', name: 'HR Team', email: 'hr@crmonce.com' },
    [{ id: 'E1', name: 'Vishwesh Boina', email: 'vishwesh@crmonce.com' },   // applicant
     { id: 'A1', name: 'HR Team', email: 'hr@crmonce.com' }],               // approver
  );
  assert.strictEqual(sent.filter(s => s.ctx.meta.type === 'leave_new_cc').length, 0);
});
