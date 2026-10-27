/**
 * Attendance Correction (missing_punch) submission email — audit fix.
 * Validates: FROM = employee's own company mailbox (a REAL Graph sender, not just a
 * header), TO = ALL active authorized HR + Super Admin on ONE email, CC = the INFO
 * mailbox (spec §B), the submission subject wording, no fake fallback when the
 * employee has no mailbox, and no duplicate sends. The decision email keeps its own
 * "Missing Punch" wording.
 *
 * No network: transport is mocked (setTransport) + EMAIL_DRY_RUN; the payload
 * builder is pure. No production data.
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
const d365 = require('../src/services/d365.service');

// Employee-card lookup → department + the HUMAN Employee ID (no network).
d365.getByIdOptional = async () => ({ hr_department: 'Engineering', hr_employeeid: 'EMP1039' });

// getApprovers() rows: active Super Admin + HR Managers (from Dataverse roles).
const HR_ROWS = [
  { hr_hremployeeid: 'A1', hr_hremployee1: 'HR One', hr_email: 'hr1@crmonce.com' },
  { hr_hremployeeid: 'A2', hr_hremployee1: 'HR Two', hr_email: 'hr2@crmonce.com' },
  { hr_hremployeeid: 'A3', hr_hremployee1: 'Super Admin', hr_email: 'admin@crmonce.com' },
];
const stubApprovers = (rows) => { d365.getList = async () => ({ data: rows }); };

const toOf = (r) => r.body.message.toRecipients.map(x => x.emailAddress.address);
const ccOf = (r) => r.body.message.ccRecipients.map(x => x.emailAddress.address);
const hasButtons = (html) => /action=(approved|rejected)/.test(html);

afterEach(() => { notif.resetTransport(); notif.clearOutbox(); });

const EMP = { id: 'E1', name: 'Vishwesh Boina', email: 'vishwesh.b@crmonce.com' };

async function submitCorrection(actor = EMP, rows = HR_ROWS) {
  stubApprovers(rows);
  const sent = [];
  notif.setTransport((req, ctx) => sent.push({ req, ctx }));
  await requestNotify.emailCorrectionRequestToHR({
    recordId: 'AC1', actor,
    details: [['Date', '18-08-2026'], ['Punch Type', 'Missing Check Out'], ['Requested Time', '18:30'], ['Reason', 'Forgot to punch out']],
    applyTime: new Date('2026-08-18T06:00:00Z').toISOString(),
  });
  return sent;
}

test('correction: ONE email, FROM employee mailbox (real Graph sender), TO all HR+Super Admin, CC info@ (§B)', async () => {
  const sent = await submitCorrection();
  assert.strictEqual(sent.length, 1);                                     // single email, not one-per-recipient
  assert.strictEqual(sent[0].req.sender, EMP.email);                      // actual Graph sender = employee
  assert.ok(sent[0].req.url.includes(encodeURIComponent(EMP.email)));     // sent AS the employee mailbox, not a From header
  assert.deepStrictEqual(toOf(sent[0].req).sort(), ['admin@crmonce.com', 'hr1@crmonce.com', 'hr2@crmonce.com']);  // ALL HR on TO
  assert.deepStrictEqual(ccOf(sent[0].req), ['info@crmonce.com']);        // §B: INFO mailbox CC'd on the submission
});

test('correction: INFO-fallback send (employee has no company mailbox) does NOT self-CC info@', async () => {
  const sent = await submitCorrection({ id: 'E1', name: 'No Email', email: '' });
  assert.strictEqual(sent[0].req.sender, 'info@crmonce.com');             // fallback sender IS info@
  assert.deepStrictEqual(ccOf(sent[0].req), []);                          // mergeCc drops a CC equal to the sender
});

test('correction: subject "Attendance Correction Request - {name}", actionable, details present', async () => {
  const sent = await submitCorrection();
  assert.strictEqual(sent[0].ctx.subject, 'Attendance Correction Request - Vishwesh Boina');
  assert.strictEqual(hasButtons(sent[0].ctx.html), true);                 // all HR are authorized approvers
  assert.ok(/EMP1039/.test(sent[0].ctx.html));                            // human Employee ID
  assert.ok(/Missing Check Out/.test(sent[0].ctx.html));                  // Punch Type
  assert.ok(/18:30/.test(sent[0].ctx.html));                              // Requested Time
});

test('correction: employee with NO email → §A fallback: ONE email from INFO system mailbox, NO Reply-To (no address to use), still TO HR', async () => {
  const sent = await submitCorrection({ id: 'E1', name: 'No Email', email: '' });
  assert.strictEqual(sent.length, 1);                                     // no longer skipped — safe fallback send
  assert.strictEqual(sent[0].req.sender, 'info@crmonce.com');             // system INFO sender (never spoofed)
  assert.ok(!sent[0].req.body.message.replyTo);                           // empty address → no Reply-To
  assert.deepStrictEqual(toOf(sent[0].req).sort(), ['admin@crmonce.com', 'hr1@crmonce.com', 'hr2@crmonce.com']);  // recipients unchanged
});

test('correction: employee with an EXTERNAL (non-company) email → §A fallback: from INFO, Reply-To = employee (no spoof)', async () => {
  const sent = await submitCorrection({ id: 'E1', name: 'Gmail User', email: 'user@gmail.com' });
  assert.strictEqual(sent.length, 1);
  assert.strictEqual(sent[0].req.sender, 'info@crmonce.com');             // cannot send AS an external address
  assert.strictEqual(sent[0].req.body.message.replyTo?.[0]?.emailAddress?.address, 'user@gmail.com');  // replies route to the employee
});

test('correction: no HR recipients configured → nothing sent (safe, no crash)', async () => {
  const sent = await submitCorrection(EMP, []);
  assert.strictEqual(sent.length, 0);
});

test('correction: no duplicate — one email, each HR address once, employee never a recipient', async () => {
  const sent = await submitCorrection();
  const recips = toOf(sent[0].req);
  assert.strictEqual(new Set(recips).size, recips.length);                // no address twice
  assert.ok(!recips.includes(EMP.email));                                 // employee is not a recipient of the HR request
});
