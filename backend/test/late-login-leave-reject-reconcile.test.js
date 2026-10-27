/**
 * L1 / L2 leave REJECTION must trigger Late Login reconciliation for the full leave date range
 * (closing the gap where only approval + HR-override reject/cancel reconciled). The reconcile is
 * non-blocking: a reconcile failure is logged (non-sensitive) and never breaks the decision
 * response. Real route handlers are invoked with all external services stubbed — no network,
 * no emails. Also asserts approval still reconciles and no duplicate/real email is sent here.
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
const requestNotify = require('../src/services/request-notify.service');
const eligibility = require('../src/services/late-login-eligibility.service');
const { toValue } = require('../src/services/picklist');
const router = require('../src/modules/attendance/leave.routes');

const handlerFor = (path) => {
  const layer = router.stack.find((l) => l.route && l.route.path === path && l.route.methods.patch);
  return layer.route.stack[layer.route.stack.length - 1].handle;
};
const invoke = async (handler, req) => {
  let body, code = 200; const res = { status(c) { code = c; return this; }, json(b) { body = b; return this; } };
  await handler(req, res, (e) => { if (e) throw e; });
  return { code, body };
};
const OLD = '2026-06-10';   // well outside any scanner lookback window → retrospective

let orig, reconcileCalls, warns;
beforeEach(() => {
  orig = { gbi: d365.getByIdOptional, gbid: d365.getById, up: d365.update, rlr: eligibility.reconcileLeaveRange, nla: notif.notifyLeaveApproval, bc: notif.broadcast, dec: requestNotify.emailDecisionToEmployee, warn: global.logger?.warn };
  reconcileCalls = []; warns = [];
  global.logger = { ...(global.logger || {}), warn: (m) => warns.push(String(m)), info: () => {}, error: () => {} };
  d365.getByIdOptional = async () => ({ hr_hrleaveid: 'LV1', _hr_hremployee_value: 'E1', hr_status: toValue('hr_leave_status', 'pending'), hr_l1status: 'approved', hr_l2status: '', hr_fromdate: OLD, hr_todate: OLD, hr_days: 1, hr_leavetype: toValue('hr_leave_type', 'Casual Leave') });
  d365.getById = async () => ({ hr_hremployeeid: 'E1', hr_hremployee1: 'Amy', _hr_manager_value: null });   // getManagerChain → no managers
  d365.update = async () => ({});
  notif.notifyLeaveApproval = async () => {}; notif.broadcast = () => {};
  requestNotify.emailDecisionToEmployee = async () => {};   // stubbed — proves NO real email is sent from here
  eligibility.reconcileLeaveRange = async (args) => { reconcileCalls.push(args); return []; };
});
afterEach(() => {
  Object.assign(d365, { getByIdOptional: orig.gbi, getById: orig.gbid, update: orig.up });
  eligibility.reconcileLeaveRange = orig.rlr; notif.notifyLeaveApproval = orig.nla; notif.broadcast = orig.bc; requestNotify.emailDecisionToEmployee = orig.dec;
  if (orig.warn) global.logger.warn = orig.warn;
});

const reqL1 = (action) => ({ params: { id: 'LV1' }, body: { action, remarks: 'x' }, user: { id: 'U1', name: 'HR One', role: 'super_admin', email: 'hr@crmonce.com' } });

test('1 L1 rejection reconciles the FULL leave date range (retrospective date outside the scanner window)', async () => {
  const { code } = await invoke(handlerFor('/:id/l1'), reqL1('rejected'));
  assert.strictEqual(code, 200);
  assert.strictEqual(reconcileCalls.length, 1);
  assert.strictEqual(reconcileCalls[0].employeeId, 'E1');
  assert.strictEqual(reconcileCalls[0].from, OLD);
  assert.strictEqual(reconcileCalls[0].to, OLD);
});

test('2 L2 rejection reconciles the full leave date range', async () => {
  const { code } = await invoke(handlerFor('/:id/l2'), reqL1('rejected'));
  assert.strictEqual(code, 200);
  assert.strictEqual(reconcileCalls.length, 1);
  assert.strictEqual(reconcileCalls[0].employeeId, 'E1');
  assert.strictEqual(reconcileCalls[0].from, OLD);
});

test('3 a reconcile FAILURE is logged safely and does NOT break the rejection response', async () => {
  eligibility.reconcileLeaveRange = async () => { throw new Error('dataverse down'); };
  const { code } = await invoke(handlerFor('/:id/l1'), reqL1('rejected'));
  assert.strictEqual(code, 200, 'leave decision still succeeds despite reconcile failure (non-blocking)');
  await new Promise((r) => setImmediate(r));   // let the fire-and-forget .catch run
  assert.ok(warns.some((w) => /late-login reconcile failed/.test(w)), 'failure logged');
  assert.ok(!warns.some((w) => /dataverse down/.test(w) && /reason|type|name/.test(w)), 'no personal leave details leaked');
});

test('4 L1 APPROVAL (final, no L2) still reconciles — existing behavior intact', async () => {
  // No L2 manager (getManagerChain → null) → L1 approval is final.
  const { code } = await invoke(handlerFor('/:id/l1'), reqL1('approved'));
  assert.strictEqual(code, 200);
  assert.ok(reconcileCalls.length >= 1, 'approval path reconciled');
  assert.strictEqual(reconcileCalls[0].employeeId, 'E1');
});

test('5 L2 APPROVAL still reconciles — existing behavior intact', async () => {
  const { code } = await invoke(handlerFor('/:id/l2'), reqL1('approved'));
  assert.strictEqual(code, 200);
  assert.ok(reconcileCalls.length >= 1);
});

test('6 reconciliation does not itself send email (it cancels/creates records only)', async () => {
  // The leave decision email is sent by emailDecisionToEmployee (stubbed here); the reconcile hook
  // calls reconcileLeaveRange only. Assert reconcile received no email-sending responsibility.
  await invoke(handlerFor('/:id/l1'), reqL1('rejected'));
  assert.strictEqual(reconcileCalls.length, 1);
  assert.ok(!('sendEmail' in reconcileCalls[0]) && !('notify' in reconcileCalls[0]));
});
