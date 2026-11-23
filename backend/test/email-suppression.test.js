/**
 * Centralized email suppression (Phase 6) — the single pipeline (notification.sendEmail, and the
 * ledger sendOnce that wraps it) suppresses a disabled category for the targeted employee, while
 * enabled categories and uncategorized/operational mail are always delivered. Fail-open on error.
 * Email is captured via setTransport; the preference lookup is stubbed. No network, no real email.
 */
process.env.NODE_ENV = 'test';
process.env.EMAIL_DRY_RUN = 'true';
process.env.AZURE_CLIENT_ID = process.env.AZURE_CLIENT_ID || 'x';
process.env.AZURE_CLIENT_SECRET = process.env.AZURE_CLIENT_SECRET || 'x';
process.env.AZURE_TENANT_ID = process.env.AZURE_TENANT_ID || 'x';

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const notif = require('../src/services/notification.service');
const ledger = require('../src/services/notification-ledger.service');
const emailPrefs = require('../src/services/email-preferences.service');

// Preference matrix: prefMap[employeeId][category] === false → disabled.
let prefMap, sent, origIsEnabled;
function memStore() {
  const rows = new Map();
  const k = (e, d, t) => `${e}|${d}|${t}`;
  return { rows, async hasSent(e, d, t) { return rows.get(k(e, d, t)) === 'sent'; }, async record(r) { rows.set(k(r.employeeId, r.date, r.type), r.status); } };
}

beforeEach(() => {
  prefMap = {};
  sent = [];
  origIsEnabled = emailPrefs.isCategoryEnabled;
  emailPrefs.isCategoryEnabled = async (empId, cat) => prefMap[empId]?.[cat] !== false;   // default enabled
  notif.setTransport((req) => { sent.push(req); });   // capture; no Graph
});
afterEach(() => { emailPrefs.isCategoryEnabled = origIsEnabled; notif.resetTransport(); notif.clearOutbox(); ledger.setStore(); });

const send = (opts) => notif.sendEmail('emp@crmonce.com', 'S', '<p>x</p>', opts);

// B: birthday disabled → suppressed
test('B: birthday disabled → birthday email suppressed (not sent)', async () => {
  prefMap = { E1: { birthday: false } };
  const r = await send({ employeeId: 'E1', meta: { type: 'celebration_birthday' } });
  assert.strictEqual(r.suppressed, true);
  assert.strictEqual(sent.length, 0, 'no email dispatched');
});

// C: birthday disabled, payroll enabled → birthday suppressed, payroll delivered
test('C: birthday disabled + payroll enabled → birthday suppressed, payroll delivered', async () => {
  prefMap = { E1: { birthday: false } };   // payroll defaults enabled
  const b = await send({ employeeId: 'E1', meta: { type: 'celebration_birthday' } });
  const p = await send({ employeeId: 'E1', meta: { type: 'payslip' } });
  assert.strictEqual(b.suppressed, true);
  assert.ok(!p.suppressed && p.success, 'payroll delivered');
  assert.strictEqual(sent.length, 1, 'only the payroll email went out');
});

// D: work anniversary disabled → suppressed
test('D: work anniversary disabled → suppressed', async () => {
  prefMap = { E1: { anniversary: false } };
  const r = await send({ employeeId: 'E1', meta: { type: 'celebration_work_anniversary' } });
  assert.strictEqual(r.suppressed, true);
  assert.strictEqual(sent.length, 0);
});

// F / G / H: enabled categories delivered
test('F: attendance enabled → delivered', async () => {
  const r = await send({ employeeId: 'E1', meta: { type: 'LATE_LOGIN' } });
  assert.ok(!r.suppressed && r.success);
  assert.strictEqual(sent.length, 1);
});
test('G: leave decision enabled → delivered', async () => {
  const r = await send({ employeeId: 'E1', meta: { type: 'leave_decision' } });
  assert.ok(!r.suppressed && r.success);
});
test('H: payroll enabled → delivered', async () => {
  const r = await send({ employeeId: 'E1', meta: { type: 'payslip' } });
  assert.ok(!r.suppressed && r.success);
});

// Operational mail (no employeeId) is NEVER suppressed — HR/Super Admin recipients preserved.
test('no employeeId (operational/HR email) → never suppressed even if category disabled', async () => {
  prefMap = { E1: { attendance: false } };
  const r = await send({ meta: { type: 'EARLY_LOGOUT_APPROVAL_REQUIRED' } });   // TO = HR, no employeeId
  assert.ok(!r.suppressed && r.success, 'HR approval email always delivered');
});

// Uncategorized mail always delivered.
test('uncategorized email (generic) → always delivered', async () => {
  prefMap = { E1: { birthday: false } };
  const r = await send({ employeeId: 'E1', meta: { type: 'generic' } });
  assert.ok(!r.suppressed && r.success);
});

// O: preference lookup failure → fail-open (delivered)
test('O: preference lookup throws → fail-open, email delivered', async () => {
  emailPrefs.isCategoryEnabled = async () => { throw new Error('dataverse down'); };
  const r = await send({ employeeId: 'E1', meta: { type: 'celebration_birthday' } });
  assert.ok(!r.suppressed && r.success, 'delivered despite lookup failure');
  assert.strictEqual(sent.length, 1);
});

// E: reminder disabled via the ledger path → suppressed (recorded 'suppressed', not 'sent')
test('E: ledger path — reminders disabled → suppressed, recorded suppressed (re-enable re-sends)', async () => {
  const store = memStore();
  ledger.setStore(store);
  prefMap = { E1: { reminders: false } };
  const r = await ledger.sendOnce({ employeeId: 'E1', date: '2026-11-23', type: 'PROFILE_REMINDER', to: 'emp@crmonce.com', subject: 'S', html: '<p>x</p>' });
  assert.deepStrictEqual(r, { skipped: true, reason: 'category_disabled' });
  assert.strictEqual(sent.length, 0);
  assert.strictEqual(store.rows.get('E1|2026-11-23|PROFILE_REMINDER'), 'suppressed', 'not marked sent → re-enabling re-sends');
});

// Newly-wired employee-directed paths: advance / profile / historical-attendance / lifecycle.
// Each: disabled category → suppressed; enabled → delivered; no employeeId (operational) → delivered.
for (const [name, type, category] of [
  ['advance salary decision', 'advance', 'other'],
  ['profile-change decision', 'profile_decision', 'other'],
  ['historical-attendance decision', 'hist_attendance', 'attendance'],
  ['request-lifecycle cancellation decision', 'lifecycle', 'other'],
]) {
  test(`wired path: ${name} — disabled '${category}' → suppressed`, async () => {
    prefMap = { E1: { [category]: false } };
    const r = await send({ employeeId: 'E1', meta: { type } });
    assert.strictEqual(r.suppressed, true);
    assert.strictEqual(sent.length, 0);
  });
  test(`wired path: ${name} — enabled → delivered`, async () => {
    const r = await send({ employeeId: 'E1', meta: { type } });
    assert.ok(!r.suppressed && r.success);
  });
  test(`wired path: ${name} — operational (no employeeId) → delivered (HR/approver preserved)`, async () => {
    prefMap = { E1: { [category]: false } };
    const r = await notif.sendEmail('hr@crmonce.com', 'S', '<p>x</p>', { meta: { type } });   // no employeeId
    assert.ok(!r.suppressed && r.success);
  });
}

// Payroll "please apply for leave" reminder — explicit category=leave + employeeId.
test('payroll leave reminder (explicit category=leave) — disabled → suppressed; enabled → delivered', async () => {
  prefMap = { E1: { leave: false } };
  const off = await notif.sendEmail('e1@crmonce.com', 'Please apply for leave', '<p>x</p>', { employeeId: 'E1', category: 'leave', meta: { type: 'leave_remind' } });
  assert.strictEqual(off.suppressed, true, 'suppressed when employee disabled leave');
  const on = await notif.sendEmail('e2@crmonce.com', 'Please apply for leave', '<p>x</p>', { employeeId: 'E2', category: 'leave', meta: { type: 'leave_remind' } });
  assert.ok(!on.suppressed && on.success, 'delivered when leave enabled');
});

// I: bulk loop — disabled employee skipped, enabled employees receive (per-recipient)
test('I: bulk per-employee loop → disabled recipient skipped, enabled recipients delivered', async () => {
  prefMap = { E_OFF: { birthday: false } };   // E_ON, E_ON2 default enabled
  const recipients = [
    { id: 'E_ON', email: 'a@crmonce.com' },
    { id: 'E_OFF', email: 'b@crmonce.com' },
    { id: 'E_ON2', email: 'c@crmonce.com' },
  ];
  const results = [];
  for (const emp of recipients) {
    results.push(await notif.sendEmail(emp.email, 'Happy Birthday', '<p>🎂</p>', { employeeId: emp.id, meta: { type: 'celebration_birthday' } }));
  }
  assert.ok(!results[0].suppressed && results[0].success, 'E_ON delivered');
  assert.strictEqual(results[1].suppressed, true, 'E_OFF skipped');
  assert.ok(!results[2].suppressed && results[2].success, 'E_ON2 delivered');
  assert.strictEqual(sent.length, 2, 'exactly the two enabled employees received the email');
});
