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

const { test, afterEach } = require('node:test');
const assert = require('node:assert');

const { resolveSender, validateCompanyEmail } = require('../src/services/email/sender');
const notif = require('../src/services/notification.service');
const T = require('../src/services/email/templates');

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
