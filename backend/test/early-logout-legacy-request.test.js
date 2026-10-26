/**
 * LEGACY Early Logout attendance-requests (punchType 'early_logout', created by the OLD
 * correction flow before Early Logout became a 2-hour permission record) must stay fully
 * serviceable:
 *   • GET /attendance-requests returns them (no server-side exclusion) → the UI can show them.
 *   • Approve / Reject work via the existing workflow and NEVER insert or modify an attendance
 *     punch (early_logout is a NON_PUNCH type) — only the request status changes.
 *
 * Real route handlers are pulled from the router; d365 / activity / notify are stubbed. No network.
 */
process.env.NODE_ENV = 'test';
process.env.AZURE_CLIENT_ID = process.env.AZURE_CLIENT_ID || 'x';
process.env.AZURE_CLIENT_SECRET = process.env.AZURE_CLIENT_SECRET || 'x';
process.env.AZURE_TENANT_ID = process.env.AZURE_TENANT_ID || 'x';

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const d365 = require('../src/services/d365.service');
const activity = require('../src/services/activity.service');
const requestNotify = require('../src/services/request-notify.service');
const router = require('../src/modules/attendance/attendance-request.routes');

const REQ = d365.constructor.entities.attendanceRequest;
const ATT = d365.constructor.entities.attendance;

// Pull the last handler (after guards) for a given method+path from the router stack.
function handlerFor(method, path) {
  const layer = router.stack.find((l) => l.route && l.route.path === path && l.route.methods[method]);
  assert.ok(layer, `${method.toUpperCase()} ${path} route must be registered`);
  const stack = layer.route.stack;
  return stack[stack.length - 1].handle;
}
const HR = { role: 'hr_manager', id: 'hr1', name: 'HR One', email: 'hr@crmonce.com' };
// A legacy pending Early Logout request (mirrors the production record: Samrin Shaik, 2026-10-15).
const legacyRow = (over = {}) => ({ hr_attendancerequestid: 'el-legacy', hr_status: 'pending', hr_employeeid: 'EMP-SAMRIN', hr_employeename: 'Samrin Shaik', hr_punchtype: 'early_logout', hr_attendancedate: '2026-10-15', hr_requestedtime: '16:00', hr_adjustmenthours: '2', hr_reason: 'personal', ...over });

let orig;
beforeEach(() => {
  orig = { gid: d365.getById, upd: d365.update, gl: d365.getList, rec: activity.record, mail: requestNotify.emailDecisionToEmployee };
  activity.record = () => {};
  requestNotify.emailDecisionToEmployee = () => {};   // best-effort email → no-op (no network)
});
afterEach(() => { d365.getById = orig.gid; d365.update = orig.upd; d365.getList = orig.gl; activity.record = orig.rec; requestNotify.emailDecisionToEmployee = orig.mail; });

async function invoke(method, path, { params = {}, body = {}, user = HR }) {
  const req = { params, body, user, query: {}, headers: {} };
  let status = 200, out = null;
  const res = { status(c) { status = c; return this; }, json(b) { out = b; return this; } };
  await handlerFor(method, path)(req, res, (e) => { out = { _next: e && e.message }; status = e?.status || 500; });
  return { status, body: out };
}

// ── Visibility: the list endpoint returns legacy early_logout rows (no server-side filter) ──
test('GET /attendance-requests returns legacy early_logout rows (UI can display them)', async () => {
  d365.getList = async () => ({ data: [
    legacyRow(),
    { hr_attendancerequestid: 'c1', hr_status: 'pending', hr_employeeid: 'E2', hr_employeename: 'Other', hr_punchtype: 'missing_check_out', hr_attendancedate: '2026-10-14', hr_requestedtime: '19:00' },
  ] });
  const { status, body } = await invoke('get', '/', {});
  assert.strictEqual(status, 200);
  const types = body.data.map(r => r.punchType);
  assert.ok(types.includes('early_logout'), 'legacy early logout is returned by the API');
  assert.ok(types.includes('missing_check_out'), 'corrections are returned too');
  const el = body.data.find(r => r.punchType === 'early_logout');
  assert.strictEqual(el.employeeName, 'Samrin Shaik');
  assert.strictEqual(el.status, 'pending');
});

// ── Approve: status flips to approved; NO attendance punch is inserted/modified ──
test('approve legacy early_logout → status approved, attendance record NEVER touched', async () => {
  const touched = [];
  d365.getById = async (entity, id) => { touched.push({ op: 'getById', entity }); return legacyRow(); };
  d365.update = async (entity, id, patch) => { touched.push({ op: 'update', entity, patch }); return { ...legacyRow(), ...patch }; };
  const { status, body } = await invoke('patch', '/:id/approve', { params: { id: 'el-legacy' }, body: { comment: 'ok', finalAction: 'add' } });
  assert.strictEqual(status, 200);
  assert.strictEqual(body.data.status, 'approved');
  // The only write is to the request entity; the attendance entity is never read or updated.
  assert.ok(touched.some(t => t.op === 'update' && t.entity === REQ), 'request status updated');
  assert.ok(!touched.some(t => t.entity === ATT), 'attendance record never touched (no punch inserted)');
});

// ── Reject: status flips to rejected; no attendance write ──
test('reject legacy early_logout → status rejected, no attendance write', async () => {
  const touched = [];
  d365.getById = async () => legacyRow();
  d365.update = async (entity, id, patch) => { touched.push({ entity, patch }); return { ...legacyRow(), ...patch }; };
  const { status, body } = await invoke('patch', '/:id/reject', { params: { id: 'el-legacy' }, body: { comment: 'no' } });
  assert.strictEqual(status, 200);
  assert.strictEqual(body.data.status, 'rejected');
  assert.ok(touched.every(t => t.entity === REQ), 'only the request row is written');
  assert.ok(!touched.some(t => t.entity === ATT), 'attendance untouched on reject');
});
