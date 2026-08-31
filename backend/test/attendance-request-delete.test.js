/**
 * DELETE /api/attendance-requests/:id — HR/Admin delete/cancel a PENDING request.
 *
 * Rules: only HR/Admin (approve/reject permission) may delete; employees cannot; only a
 * PENDING request is deletable (approved/rejected → 409); it removes ONLY the request row
 * (never the attendance / punch record); an audit entry is written.
 *
 * No network — d365 + activity are stubbed; the real route handler is pulled from the router.
 */
process.env.NODE_ENV = 'test';
process.env.AZURE_CLIENT_ID = process.env.AZURE_CLIENT_ID || 'x';
process.env.AZURE_CLIENT_SECRET = process.env.AZURE_CLIENT_SECRET || 'x';
process.env.AZURE_TENANT_ID = process.env.AZURE_TENANT_ID || 'x';

const { test } = require('node:test');
const assert = require('node:assert');
const { requireAnyPermission } = require('../src/middleware/auth.middleware');
const d365 = require('../src/services/d365.service');
const activity = require('../src/services/activity.service');
const router = require('../src/modules/attendance/attendance-request.routes');

const REQ = d365.constructor.entities.attendanceRequest;   // 'hr_attendancerequests'
const ATT = d365.constructor.entities.attendance;           // the attendance record entity

// ── Rules 1 & 2 — authorization: HR/Admin may delete; employees cannot ──
function guard(role) {
  const mw = requireAnyPermission('attendance.approve_request', 'attendance.reject_request');
  const req = { user: { role, id: 'u1', name: 'T' } };
  let status = 200, passed = false;
  const res = { status(c) { status = c; return this; }, json() { return this; } };
  mw(req, res, () => { passed = true; });
  return { passed, status };
}
test('Rule 1/2 — only HR/Super Admin can delete; employee & recruiter are denied (403)', () => {
  assert.deepEqual(guard('super_admin'), { passed: true, status: 200 });
  assert.deepEqual(guard('hr_manager'), { passed: true, status: 200 });
  assert.equal(guard('employee').passed, false);
  assert.equal(guard('employee').status, 403);
  assert.equal(guard('recruiter').passed, false);
});

// Pull the real DELETE /:id handler (last fn in its route stack — after the guard).
function deleteHandler() {
  const layer = router.stack.find((l) => l.route && l.route.path === '/:id' && l.route.methods.delete);
  assert.ok(layer, 'DELETE /:id route must be registered');
  const stack = layer.route.stack;
  return stack[stack.length - 1].handle;
}
async function invokeDelete({ id = 'r1', row }) {
  const orig = { getById: d365.getById, del: d365.delete, record: activity.record };
  const captured = { deletedEntity: null, deletedId: null, audit: null };
  d365.getById = async () => row;
  d365.delete = async (entity, rid) => { captured.deletedEntity = entity; captured.deletedId = rid; return {}; };
  activity.record = (p) => { captured.audit = p; };
  const req = { params: { id }, user: { role: 'hr_manager', id: 'hr1', name: 'HR One' } };
  let status = 200, body = null;
  const res = { status(c) { status = c; return this; }, json(b) { body = b; return this; } };
  try { await deleteHandler()(req, res, (e) => { body = { _next: e && e.message }; }); }
  finally { d365.getById = orig.getById; d365.delete = orig.del; activity.record = orig.record; }
  return { status, body, captured };
}

test('Rules 4 & 7 — deletes ONLY the request row (never the attendance record) + writes an audit entry', async () => {
  const row = { hr_attendancerequestid: 'r1', hr_status: 'pending', hr_employeename: 'Alice', hr_punchtype: 'missing_check_out', hr_attendancedate: '2026-08-20' };
  const { status, body, captured } = await invokeDelete({ id: 'r1', row });
  assert.equal(status, 200);
  assert.deepEqual(body, { deleted: true, id: 'r1' });
  assert.strictEqual(captured.deletedEntity, REQ, 'delete targets the request entity');
  assert.notStrictEqual(captured.deletedEntity, ATT, 'the attendance/punch record is NEVER deleted');
  assert.strictEqual(captured.deletedId, 'r1');
  assert.equal(captured.audit.type, 'correction_deleted', 'audit records the deletion');
  assert.match(captured.audit.meta, /deleted by HR One/);
});

test('Rule 5 — an APPROVED request cannot be deleted (409, nothing removed)', async () => {
  const { status, body, captured } = await invokeDelete({ row: { hr_attendancerequestid: 'r2', hr_status: 'approved' } });
  assert.equal(status, 409);
  assert.match(body.error, /already approved/i);
  assert.strictEqual(captured.deletedEntity, null, 'no delete performed');
});

test('Rule 6 — a REJECTED request is kept as history (not deletable → 409)', async () => {
  const { status, captured } = await invokeDelete({ row: { hr_attendancerequestid: 'r3', hr_status: 'rejected' } });
  assert.equal(status, 409);
  assert.strictEqual(captured.deletedEntity, null);
});
