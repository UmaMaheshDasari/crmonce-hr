/**
 * Early Logout — HR-approval-required notification (scenario B) and email-failure safety
 * (scenario G). When an Early Logout record needs HR approval (status manager_pending),
 * notifyEarlyLogoutApprovalRequired() emails the configured HR (TO) with Super Admin (CC),
 * both resolved by ROLE query (no hardcoding), with all the required request fields.
 * d365 + ledger stubbed; no network, no real email.
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
const ledger = require('../src/services/notification-ledger.service');
const { toValue } = require('../src/services/picklist');
const lateLogin = require('../src/services/late-login.service');

const EMP = d365.constructor.entities.employee;
const HR_MGR = `hr_role eq ${toValue('hr_role', 'hr_manager')}`;
const SUPER = `hr_role eq ${toValue('hr_role', 'super_admin')}`;

let orig, sent;
beforeEach(() => {
  orig = { gio: d365.getByIdOptional, gl: d365.getList, so: ledger.sendOnce };
  sent = [];
  ledger.sendOnce = async (o) => { sent.push(o); return { sent: true }; };
  d365.getByIdOptional = async (entity, id) => (entity === EMP
    ? { hr_email: 'vishwesh@crmonce.com', hr_hremployee1: 'Vishwesh Boina', hr_department: 'Engineering', hr_employeecode: 'EMP1039', hr_employeeid: 'EMP1039', _hr_manager_value: 'MGR' }
    : {});
  // Role-filtered recipient resolution — distinct emails per role (no hardcoding).
  d365.getList = async (entity, opts) => {
    const f = String(opts?.filter || '');
    if (entity === EMP && f.includes(HR_MGR)) return { data: [{ hr_email: 'hrmanager@crmonce.com' }] };
    if (entity === EMP && f.includes(SUPER)) return { data: [{ hr_email: 'superadmin@crmonce.com' }] };
    return { data: [] };
  };
});
afterEach(() => { Object.assign(d365, { getByIdOptional: orig.gio, getList: orig.gl }); ledger.sendOnce = orig.so; });

const REC = {
  employeeId: 'EMP1039', employeeName: 'Vishwesh Boina', requestType: 'early_logout',
  date: '2026-11-21', actualTime: '16:30', reason: 'Doctor appointment',
  status: 'manager_pending', createdon: '2026-11-21T06:05:00Z',
};

// ── Scenario B: HR in TO, Super Admin in CC, with all required fields ─────────
test('HR-approval-required email: TO = HR (role query), CC = Super Admin (role query)', async () => {
  await lateLogin.notifyEarlyLogoutApprovalRequired(REC);
  assert.strictEqual(sent.length, 1, 'one approval-required email');
  const m = sent[0];
  assert.strictEqual(m.type, 'EARLY_LOGOUT_APPROVAL_REQUIRED');
  assert.deepStrictEqual(m.to, ['hrmanager@crmonce.com'], 'TO = HR manager role recipients');
  assert.ok(m.cc.includes('superadmin@crmonce.com'), 'CC includes the Super Admin role recipient');
  assert.ok(!m.to.includes('superadmin@crmonce.com'), 'Super Admin is CC, not TO');
});

test('subject and body carry the required request details', async () => {
  await lateLogin.notifyEarlyLogoutApprovalRequired(REC);
  const m = sent[0];
  assert.match(m.subject, /^Early Logout Approval Required — Vishwesh Boina — /);
  const h = m.html;
  assert.ok(h.includes('Vishwesh Boina') && h.includes('EMP1039'), 'employee name + id');
  assert.ok(h.includes('Engineering'), 'department');
  assert.ok(h.includes('16:30'), 'requested logout time');
  assert.ok(h.includes('Doctor appointment'), 'reason');
  assert.ok(/Current Status/.test(h) && h.includes('manager_pending'), 'current status');
  assert.ok(/[Aa]pprove/.test(h) && /[Rr]eject/.test(h), 'approve/reject call to action');
});

test('idempotency key is per (employee, event date)', async () => {
  await lateLogin.notifyEarlyLogoutApprovalRequired(REC);
  assert.strictEqual(sent[0].employeeId, 'EMP1039');
  assert.strictEqual(sent[0].date, '2026-11-21');
});

test('approval link uses the configured APP_URL / FRONTEND_URL / BASE_URL', async () => {
  const prev = process.env.APP_URL;
  process.env.APP_URL = 'https://hr.example.test/';   // trailing slash should be trimmed
  try {
    await lateLogin.notifyEarlyLogoutApprovalRequired(REC);
    assert.ok(sent[0].html.includes('href="https://hr.example.test/early-logout"'), 'link honours the configured base URL');
  } finally { if (prev === undefined) delete process.env.APP_URL; else process.env.APP_URL = prev; }
});

test('falls back to Super Admin as TO when no HR manager is configured', async () => {
  d365.getList = async (entity, opts) => {
    const f = String(opts?.filter || '');
    if (entity === EMP && f.includes(HR_MGR)) return { data: [] };                     // no HR manager
    if (entity === EMP && f.includes(SUPER)) return { data: [{ hr_email: 'superadmin@crmonce.com' }] };
    return { data: [] };
  };
  await lateLogin.notifyEarlyLogoutApprovalRequired(REC);
  assert.deepStrictEqual(sent[0].to, ['superadmin@crmonce.com'], 'TO never empty — falls back to Super Admin');
});

// ── Scenario G: email failure must not throw (request/approval state unaffected) ──
test('email send failure is swallowed (best-effort) — never throws', async () => {
  ledger.sendOnce = async () => { throw new Error('graph 500'); };
  await assert.doesNotReject(() => lateLogin.notifyEarlyLogoutApprovalRequired(REC));
});

test('no employeeId → no-op, never throws', async () => {
  await assert.doesNotReject(() => lateLogin.notifyEarlyLogoutApprovalRequired({}));
  assert.strictEqual(sent.length, 0);
});
