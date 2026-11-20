/**
 * Early Logout — HR approval WORKFLOW (scenarios D–K):
 *   • HR Manager AND Super Admin can both Approve and Reject (route guard + managerDecision).
 *   • Employee (or any non-HR role) is 403 at the route guard.
 *   • First valid decision wins; a second/conflicting decision → 409.
 *   • Approver id + role + decision + timestamp are recorded (record + audit).
 *   • The employee is emailed the decision; an email failure never corrupts the status.
 * d365 / notifications / audit stubbed — no network, no real email.
 */
process.env.NODE_ENV = 'test';
process.env.EMAIL_DRY_RUN = 'true';
process.env.AZURE_CLIENT_ID = process.env.AZURE_CLIENT_ID || 'x';
process.env.AZURE_CLIENT_SECRET = process.env.AZURE_CLIENT_SECRET || 'x';
process.env.AZURE_TENANT_ID = process.env.AZURE_TENANT_ID || 'x';

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const d365 = require('../src/services/d365.service');
const notif = require('../src/services/notification.service');
const activity = require('../src/services/activity.service');
const lateLogin = require('../src/services/late-login.service');
const router = require('../src/modules/attendance/late-login.routes');

const EMP = d365.constructor.entities.employee;
const LATE = d365.constructor.entities.lateLogin;

// Drive the REAL express router with a mock req/res (the inline isHR guard runs as in production).
function callRoute(method, url, user) {
  return new Promise((resolve) => {
    const req = { method, url, originalUrl: url, headers: {}, user, params: {}, body: {}, query: {} };
    const res = {
      statusCode: 200,
      status(c) { this.statusCode = c; return this; },
      json(obj) { resolve({ status: this.statusCode, body: obj }); return this; },
    };
    router(req, res, (err) => resolve({ status: err?.status || 500, body: { error: err?.message } }));
  });
}

let orig, updates, mailed, audits;
beforeEach(() => {
  orig = { gio: d365.getByIdOptional, up: d365.update, se: notif.sendEmail, nu: notif.notifyUser, bc: notif.broadcast, ar: activity.record };
  updates = []; mailed = []; audits = [];
  notif.notifyUser = () => {}; notif.broadcast = () => {};
  notif.sendEmail = async (to, subject, html, opts) => { mailed.push({ to, subject, opts }); return { success: true }; };
  activity.record = (p) => { audits.push(p); };
  const row = { hr_lateloginid: 'REC1', hr_employeeid: 'E1', hr_employeename: 'Emp', hr_status: 'manager_pending', hr_requesttype: 'early_logout', hr_date: '2026-11-21', '@odata.etag': 'W/"1"' };
  d365.getByIdOptional = async (entity, id) => {
    if (entity === EMP) return { hr_email: 'emp@crmonce.com', hr_hremployee1: 'Emp' };
    return { ...row };   // LATE row (always manager_pending + a valid ETag for the decision tests)
  };
  d365.update = async (_e, id, patch) => { updates.push(patch); return {}; };
});
afterEach(() => { Object.assign(d365, { getByIdOptional: orig.gio, update: orig.up }); Object.assign(notif, { sendEmail: orig.se, notifyUser: orig.nu, broadcast: orig.bc }); activity.record = orig.ar; });

const flush = async () => { for (let i = 0; i < 20; i++) await new Promise(r => setImmediate(r)); };

// ── D / E: both HR roles can APPROVE via the route ───────────────────────────
for (const role of ['hr_manager', 'super_admin']) {
  test(`${role} approves via route → manager_approved, approver id+role recorded, employee emailed`, async () => {
    const res = await callRoute('PATCH', '/REC1/approve', { id: `U-${role}`, name: 'Approver', role });
    assert.strictEqual(res.status, 200, 'authorized → not 403');
    assert.strictEqual(res.body.status, 'manager_approved');
    assert.strictEqual(updates[0].hr_status, 'manager_approved');
    assert.strictEqual(updates[0].hr_managerstatus, 'approved');
    assert.ok(updates[0].hr_approvedby, 'approver name recorded on the record');
    assert.ok(updates[0].hr_approveddate, 'decision timestamp recorded');
    const a = audits.find(x => x.type === 'permission_approved');
    assert.ok(a && a.meta.byId === `U-${role}` && a.meta.byRole === role, 'approver id + role in the audit trail');
    await flush();
    assert.ok(mailed.some(m => m.to === 'emp@crmonce.com' && /Approved/i.test(m.subject)), 'employee notified of approval');
  });
}

// ── F / G: both HR roles can REJECT via the route ────────────────────────────
for (const role of ['hr_manager', 'super_admin']) {
  test(`${role} rejects via route → manager_rejected, employee emailed`, async () => {
    const res = await callRoute('PATCH', '/REC1/reject', { id: `U-${role}`, name: 'Approver', role });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.status, 'manager_rejected');
    assert.strictEqual(updates[0].hr_managerstatus, 'rejected');
    await flush();
    assert.ok(mailed.some(m => m.to === 'emp@crmonce.com' && /Rejected/i.test(m.subject)), 'employee notified of rejection');
  });
}

// ── H: an ordinary employee is 403 at the route guard (no decision made) ──────
test('employee attempts approval → 403, no status change', async () => {
  const res = await callRoute('PATCH', '/REC1/approve', { id: 'E1', name: 'Emp', role: 'employee' });
  assert.strictEqual(res.status, 403);
  assert.strictEqual(updates.length, 0, 'no record update for an unauthorized caller');
});

test('recruiter attempts reject → 403', async () => {
  const res = await callRoute('PATCH', '/REC1/reject', { id: 'R1', name: 'Rec', role: 'recruiter' });
  assert.strictEqual(res.status, 403);
});

// ── I: duplicate / conflicting decision → 409 (first valid decision wins) ─────
test('a second decision on an already-decided request → 409', async () => {
  d365.getByIdOptional = async (entity) => (entity === EMP
    ? { hr_email: 'emp@crmonce.com', hr_hremployee1: 'Emp' }
    : { hr_lateloginid: 'REC1', hr_employeeid: 'E1', hr_status: 'manager_approved', hr_requesttype: 'early_logout', hr_date: '2026-11-21' });
  const res = await callRoute('PATCH', '/REC1/reject', { id: 'U1', name: 'HR', role: 'hr_manager' });
  assert.strictEqual(res.status, 409, 'conflicting decision rejected');
  assert.strictEqual(updates.length, 0, 'status not changed by the conflicting attempt');
});

// ── K: an email failure during the decision must not corrupt the status ───────
test('decision email failure → status still updated (best-effort email)', async () => {
  notif.sendEmail = async () => { throw new Error('graph 500'); };
  const r = await lateLogin.managerDecision('REC1', 'approved', { id: 'U1', name: 'HR', role: 'hr_manager' });
  assert.strictEqual(r.status, 'manager_approved', 'the record transition is committed regardless of email');
  assert.strictEqual(updates[0].hr_status, 'manager_approved');
  await flush();   // detached email IIFE rejects internally; must never throw out
});

// ── Mandatory ETag: refuse the write when concurrency validation is unavailable ──
test('missing @odata.etag → 503 refused; no update, no audit, no email', async () => {
  d365.getByIdOptional = async (entity) => (entity === EMP
    ? { hr_email: 'emp@crmonce.com', hr_hremployee1: 'Emp' }
    : { hr_lateloginid: 'REC1', hr_employeeid: 'E1', hr_employeename: 'Emp', hr_status: 'manager_pending', hr_requesttype: 'early_logout', hr_date: '2026-11-21' });   // NO etag
  await assert.rejects(
    () => lateLogin.managerDecision('REC1', 'approved', { id: 'U1', name: 'HR', role: 'hr_manager' }),
    (e) => e.status === 503,
  );
  await flush();
  assert.strictEqual(updates.length, 0, 'no record update');
  assert.ok(!audits.some(a => /permission_(approved|rejected)/.test(a.type)), 'no approval audit event');
  assert.strictEqual(mailed.length, 0, 'no employee decision email');
});

test('empty @odata.etag → 503 refused; no update, no audit, no email', async () => {
  d365.getByIdOptional = async (entity) => (entity === EMP
    ? { hr_email: 'emp@crmonce.com', hr_hremployee1: 'Emp' }
    : { hr_lateloginid: 'REC1', hr_employeeid: 'E1', hr_employeename: 'Emp', hr_status: 'manager_pending', hr_requesttype: 'early_logout', hr_date: '2026-11-21', '@odata.etag': '' });   // empty etag
  await assert.rejects(
    () => lateLogin.managerDecision('REC1', 'rejected', { id: 'U1', name: 'HR', role: 'hr_manager' }),
    (e) => e.status === 503,
  );
  await flush();
  assert.strictEqual(updates.length, 0);
  assert.ok(!audits.some(a => /permission_/.test(a.type)));
  assert.strictEqual(mailed.length, 0);
});

test('valid @odata.etag → conditional update succeeds (If-Match sent)', async () => {
  let sentIfMatch;
  d365.update = async (_e, _id, patch, opts) => { sentIfMatch = opts?.ifMatch; updates.push(patch); return {}; };
  const r = await lateLogin.managerDecision('REC1', 'approved', { id: 'U1', name: 'HR', role: 'hr_manager' });
  assert.strictEqual(r.status, 'manager_approved');
  assert.strictEqual(sentIfMatch, 'W/"1"', 'the row ETag was sent as If-Match');
  assert.strictEqual(updates.length, 1);
});

// ── Atomic concurrency: two competing decisions → exactly one wins (ETag If-Match) ──
test('two competing HR decisions race → exactly one succeeds; loser 409; first decision kept; one email', async () => {
  let currentEtag = 'W/"1"';
  const pending = { hr_lateloginid: 'REC1', hr_employeeid: 'E1', hr_employeename: 'Emp', hr_status: 'manager_pending', hr_requesttype: 'early_logout', hr_date: '2026-11-21' };
  // Both approvers read the SAME pending row + ETag "1" (simulating a true race before either writes).
  d365.getByIdOptional = async (entity) => (entity === EMP
    ? { hr_email: 'emp@crmonce.com', hr_hremployee1: 'Emp' }
    : { ...pending, '@odata.etag': 'W/"1"' });
  // Conditional update: a stale If-Match (the row already advanced) → 412.
  d365.update = async (_e, _id, patch, opts) => {
    if (opts?.ifMatch && opts.ifMatch !== currentEtag) { const e = new Error('precondition failed'); e.response = { status: 412 }; throw e; }
    currentEtag = 'W/"2"';          // the first writer advances the ETag atomically
    updates.push(patch);
    return {};
  };
  const [a, b] = await Promise.allSettled([
    lateLogin.managerDecision('REC1', 'approved', { id: 'U-hr', name: 'HR', role: 'hr_manager' }),
    lateLogin.managerDecision('REC1', 'rejected', { id: 'U-sa', name: 'SA', role: 'super_admin' }),
  ]);
  const fulfilled = [a, b].filter(x => x.status === 'fulfilled');
  const rejected = [a, b].filter(x => x.status === 'rejected');
  assert.strictEqual(fulfilled.length, 1, 'exactly one decision succeeds');
  assert.strictEqual(rejected.length, 1, 'the competing decision is rejected');
  assert.strictEqual(rejected[0].reason.status, 409, 'the loser gets HTTP 409');
  assert.strictEqual(updates.length, 1, 'only ONE write — the first decision is never overwritten');
  await flush();
  assert.strictEqual(mailed.filter(m => m.to === 'emp@crmonce.com').length, 1, 'employee emailed exactly once (only the winning decision)');
});
