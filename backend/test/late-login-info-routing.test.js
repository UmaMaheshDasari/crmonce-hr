/**
 * Late Login — employee-submission INFO email routing (emailLateLoginInfoToHR).
 *
 * Verifies the approved routing WITHOUT sending any email (mock transport; Graph is never
 * contacted; verifyMailbox is skipped under the mock):
 *   • FROM the submitting employee's VERIFIED company mailbox; safe INFO + Reply-To fallback
 *     when the mailbox is invalid/unavailable (never spoof).
 *   • TO = active HR/Super Admin, EXCLUDING the submitter and info@ (normalized + de-duped).
 *   • CC = info@ ONLY (never the submitter; never info@ when it is already the sender or in TO).
 *   • No HR left after excluding the submitter → TO = info@, CC empty (never skipped).
 *   • Automatic HR-owned Late Login mail (Leave Required) stays FROM HR@ (unchanged).
 * No real emails, no HR records, no production data.
 */
process.env.NODE_ENV = 'test';
process.env.TENANT_MAIL_DOMAINS = 'crmonce.com';
process.env.AZURE_CLIENT_ID = process.env.AZURE_CLIENT_ID || 'test-client';
process.env.AZURE_CLIENT_SECRET = process.env.AZURE_CLIENT_SECRET || 'test-secret';
process.env.AZURE_TENANT_ID = process.env.AZURE_TENANT_ID || 'test-tenant';
process.env.GRAPH_SENDER = 'info@crmonce.com';
process.env.HR_EMAIL_SENDER = 'HR@crmonce.com';

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const notif = require('../src/services/notification.service');
const d365 = require('../src/services/d365.service');
const lateLogin = require('../src/services/late-login.service');

const toOf = (r) => r.body.message.toRecipients.map(x => x.emailAddress.address);
const ccOf = (r) => r.body.message.ccRecipients.map(x => x.emailAddress.address);
const lc = (a) => a.map(x => x.toLowerCase());

let origGet, origList;
beforeEach(() => { origGet = d365.getByIdOptional; origList = d365.getList; });
afterEach(() => { d365.getByIdOptional = origGet; d365.getList = origList; notif.resetTransport(); notif.clearOutbox(); });

// Stub the two reads emailLateLoginInfoToHR makes (employee + HR list), mock the transport,
// invoke it, and return the captured { req, ctx } (null if nothing was sent).
async function runInfo({ employeeEmail, employeeName = 'Test Emp', hrList = [] }) {
  d365.getByIdOptional = async () => ({ hr_email: employeeEmail, hr_hremployee1: employeeName, hr_department: 'Engineering', hr_employeeid: 'EMP1039' });
  d365.getList = async () => ({ data: hrList.map(e => ({ hr_email: e })) });
  let captured = null;
  notif.setTransport((req, ctx) => { captured = { req, ctx }; });
  await lateLogin.emailLateLoginInfoToHR({ employeeId: 'E1', employeeName, date: '2026-11-04', expectedTime: '09:00', actualTime: '09:30', reason: 'Traffic', remarks: '' });
  return captured;
}

test('regular employee → FROM employee mailbox, TO = HR (minus submitter), CC = info@ only', async () => {
  const c = await runInfo({ employeeEmail: 'teja@crmonce.com', hrList: ['hr@crmonce.com', 'umamahesh@crmonce.com'] });
  assert.ok(c, 'an email was sent');
  assert.strictEqual(c.req.sender, 'teja@crmonce.com');                                  // verified employee sender
  assert.deepStrictEqual(toOf(c.req).sort(), ['hr@crmonce.com', 'umamahesh@crmonce.com']);
  assert.deepStrictEqual(ccOf(c.req), ['info@crmonce.com']);                             // CC info@ only
  assert.ok(!lc(toOf(c.req)).includes('teja@crmonce.com'));                              // submitter not in TO
  assert.ok(!lc(ccOf(c.req)).includes('teja@crmonce.com'));                              // submitter not in CC
  assert.ok(!lc(toOf(c.req)).includes('info@crmonce.com'));                              // info@ not in TO
  assert.strictEqual(c.ctx.meta.type, 'late_login_info');
});

test('HR/Super Admin submitter is excluded from TO and CC; FROM their own mailbox', async () => {
  const c = await runInfo({ employeeEmail: 'umamahesh@crmonce.com', hrList: ['hr@crmonce.com', 'umamahesh@crmonce.com'] });
  assert.strictEqual(c.req.sender, 'umamahesh@crmonce.com');
  assert.deepStrictEqual(toOf(c.req), ['hr@crmonce.com']);                               // submitter excluded
  assert.deepStrictEqual(ccOf(c.req), ['info@crmonce.com']);
  assert.ok(!lc([...toOf(c.req), ...ccOf(c.req)]).includes('umamahesh@crmonce.com'));    // never To or CC
});

test('no HR left after excluding the submitter → TO = info@, CC empty (not skipped)', async () => {
  const c = await runInfo({ employeeEmail: 'umamahesh@crmonce.com', hrList: ['umamahesh@crmonce.com'] });
  assert.ok(c, 'still sent (fallback), not skipped');
  assert.strictEqual(c.req.sender, 'umamahesh@crmonce.com');
  assert.deepStrictEqual(toOf(c.req), ['info@crmonce.com']);                             // explicit fallback
  assert.deepStrictEqual(ccOf(c.req), []);                                              // no CC (TO already is info@)
});

test('invalid/external employee mailbox → FROM info@ + Reply-To employee, never self-CC info@', async () => {
  const c = await runInfo({ employeeEmail: 'teja99@gmail.com', hrList: ['hr@crmonce.com'] });
  assert.strictEqual(c.req.sender, 'info@crmonce.com');                                  // safe fallback sender
  assert.strictEqual(c.ctx.replyTo, 'teja99@gmail.com');                                 // Reply-To = employee (valid format)
  assert.deepStrictEqual(toOf(c.req), ['hr@crmonce.com']);
  assert.deepStrictEqual(ccOf(c.req), []);                                              // NEVER CC info@ when it is the sender
});

test('missing employee mailbox → FROM info@, no Reply-To, still delivered to HR', async () => {
  const c = await runInfo({ employeeEmail: '', hrList: ['hr@crmonce.com'] });
  assert.strictEqual(c.req.sender, 'info@crmonce.com');
  assert.strictEqual(c.ctx.replyTo, undefined);                                          // no valid address → no Reply-To
  assert.deepStrictEqual(toOf(c.req), ['hr@crmonce.com']);
  assert.deepStrictEqual(ccOf(c.req), []);
});

test('dedupe + exclusions: duplicate HR (case), submitter, and info@ in the HR list', async () => {
  const c = await runInfo({
    employeeEmail: 'teja@crmonce.com',
    hrList: ['hr@crmonce.com', 'HR@CRMONCE.COM', 'teja@crmonce.com', 'info@crmonce.com', ' umamahesh@crmonce.com '],
  });
  assert.strictEqual(c.req.sender, 'teja@crmonce.com');
  const to = lc(toOf(c.req));
  assert.deepStrictEqual([...to].sort(), ['hr@crmonce.com', 'umamahesh@crmonce.com']);   // deduped + trimmed
  assert.strictEqual(to.filter(x => x === 'hr@crmonce.com').length, 1);                  // no duplicate
  assert.ok(!to.includes('teja@crmonce.com'));                                           // submitter excluded
  assert.ok(!to.includes('info@crmonce.com'));                                           // info@ not in TO
  assert.deepStrictEqual(ccOf(c.req), ['info@crmonce.com']);
});

test('self-send guard: unusable employee mailbox + NO valid HR → NOT sent (info@ never emails itself)', async () => {
  // Employee mailbox unusable → sender falls back to info@; HR list empty → the only fallback
  // recipient would also be info@. Must skip (no info@→info@ self-send).
  const c = await runInfo({ employeeEmail: 'someone@gmail.com', hrList: [] });
  assert.strictEqual(c, null, 'skipped — info@ would otherwise be both sender and sole recipient');
});

test('self-send guard does NOT over-skip: unusable employee mailbox but a valid HR exists → still sent to HR', async () => {
  const c = await runInfo({ employeeEmail: 'someone@gmail.com', hrList: ['hr@crmonce.com'] });
  assert.ok(c, 'still sent — a valid recipient exists');
  assert.strictEqual(c.req.sender, 'info@crmonce.com');       // safe fallback sender
  assert.deepStrictEqual(toOf(c.req), ['hr@crmonce.com']);    // delivered to HR
  assert.deepStrictEqual(ccOf(c.req), []);                    // never CC info@ when it is the sender
});

test('automatic HR-owned Late Login email (Leave Required) is UNCHANGED → FROM HR@, CC info@', async () => {
  const ledger = require('../src/services/notification-ledger.service');
  const origSendOnce = ledger.sendOnce;
  let captured;
  ledger.sendOnce = async (args) => { captured = args; return { sent: true }; };
  d365.getByIdOptional = async () => ({ hr_email: 'teja@crmonce.com', hr_hremployee1: 'Teja' });
  try {
    await lateLogin.emailLeaveRequired({ employeeId: 'E1', date: '2026-11-04', employeeName: 'Teja' });
    assert.strictEqual(captured.from, 'HR@crmonce.com');          // still HR-owned sender (unchanged)
    assert.strictEqual(captured.to, 'teja@crmonce.com');
    assert.deepStrictEqual(captured.cc, ['info@crmonce.com']);
  } finally { ledger.sendOnce = origSendOnce; }
});
