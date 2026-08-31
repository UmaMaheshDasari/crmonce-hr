/**
 * Attendance Correction — ADD or DELETE action.
 *
 * Employee chooses Add Punch / Delete Punch; the approver confirms a FINAL action (which may
 * differ) that is applied to attendance, after which computeSession recalculates the whole day
 * (effective hours / status / shortage / OT / LOP). Both actions are recorded in the audit.
 *
 * No network — d365 / activity / notify / shift-history are stubbed; the REAL approve handler
 * is pulled from the router and computeSession runs for real.
 */
process.env.NODE_ENV = 'test';
process.env.AZURE_CLIENT_ID = process.env.AZURE_CLIENT_ID || 'x';
process.env.AZURE_CLIENT_SECRET = process.env.AZURE_CLIENT_SECRET || 'x';
process.env.AZURE_TENANT_ID = process.env.AZURE_TENANT_ID || 'x';

const { test } = require('node:test');
const assert = require('node:assert');
const { deletePunchTime, insertPunchTime, PUNCH_TYPES } = require('../src/services/missing-punch.util');
const { computeSession } = require('../src/services/attendance.util');
const { toLabel } = require('../src/services/picklist');
const d365 = require('../src/services/d365.service');
const activity = require('../src/services/activity.service');
const notify = require('../src/services/request-notify.service');
const shiftHist = require('../src/services/shift-history.service');
const router = require('../src/modules/attendance/attendance-request.routes');

const ATT = d365.constructor.entities.attendance;

// ── deletePunchTime util (Cases 9, 15) ──
test('Case 9/15 — deletePunchTime removes ONLY the selected punch; others preserved', () => {
  assert.deepEqual(deletePunchTime(['09:00', '13:00', '13:35', '18:00'], '13:35'), ['09:00', '13:00', '18:00']);
});
test('deletePunchTime — a non-matching target removes nothing (no unrelated punch deleted)', () => {
  assert.deepEqual(deletePunchTime(['09:00', '18:00'], '13:35'), ['09:00', '18:00']);
});
test("Case 16 — after delete, computeSession recalculates: 09:00→13:00→18:00 = 09-13 pair + open → INCOMPLETE 4h", () => {
  const c = computeSession(deletePunchTime(['09:00', '13:00', '13:35', '18:00'], '13:35'), 'GEN', { date: '2026-08-18' });
  assert.strictEqual(c.count, 3);
  assert.strictEqual(c.effectiveHours, 4);
});
test('Case 14 — after ADD (missing OUT), computeSession recalculates to a complete 8h day', () => {
  const c = computeSession(insertPunchTime(['09:00', '13:00', '14:00'], '18:00'), 'GEN', { date: '2026-08-18' });
  assert.strictEqual(c.effectiveHours, 8);
  assert.strictEqual(c.status, 'present');
});
test('delete_punch is a recognised request type', () => {
  assert.strictEqual(PUNCH_TYPES.delete_punch, 'Delete Punch');
});

// ── Real approve handler (Cases 6,7,8,9,10,11,20) ──
function approveHandler() {
  const layer = router.stack.find((l) => l.route && l.route.path === '/:id/approve');
  return layer.route.stack[layer.route.stack.length - 1].handle;
}
async function approve({ request, punches, finalAction }) {
  const orig = { getById: d365.getById, getList: d365.getList, update: d365.update, rec: activity.record, email: notify.emailDecisionToEmployee, shift: shiftHist.resolveShiftForDate };
  const cap = { attUpdate: null, reqPatch: null, audit: null };
  d365.getById = async () => request;
  d365.getList = async () => ({ data: [{ hr_hrattendanceid: 'a1', hr_allpunches: JSON.stringify(punches), _hr_hremployee_value: request.hr_employeeid }] });
  d365.update = async (entity, id, payload) => { if (entity === ATT) cap.attUpdate = payload; else cap.reqPatch = { id, ...payload }; return { ...request, ...payload }; };
  activity.record = (p) => { cap.audit = p; };
  notify.emailDecisionToEmployee = () => {};
  shiftHist.resolveShiftForDate = async () => ({ code: 'GEN', name: 'General', start: '09:00', end: '18:00', durationHours: 9, grace: 5 });
  const handler = approveHandler();
  const req = { params: { id: request.hr_attendancerequestid }, user: { role: 'hr_manager', name: 'HR One', email: 'hr@x.io' }, body: { finalAction } };
  let body = null; const res = { status() { return this; }, json(b) { body = b; return this; } };
  try { await handler(req, res, (e) => { body = { _next: e && e.message }; }); }
  finally { Object.assign(d365, { getById: orig.getById, getList: orig.getList, update: orig.update }); activity.record = orig.rec; notify.emailDecisionToEmployee = orig.email; shiftHist.resolveShiftForDate = orig.shift; }
  return { body, cap };
}

const addReq = { hr_attendancerequestid: 'r1', hr_employeeid: 'E1', hr_employeename: 'Alice', hr_attendancedate: '2026-08-18', hr_punchtype: 'missing_check_out', hr_requestedtime: '18:00', hr_status: 'pending' };
const delReq = { hr_attendancerequestid: 'r2', hr_employeeid: 'E1', hr_employeename: 'Alice', hr_attendancedate: '2026-08-18', hr_punchtype: 'delete_punch', hr_requestedtime: '13:35', hr_status: 'pending' };

test('Case 8 — approver ADD: requested time inserted, day recomputed, status APPROVED', async () => {
  const { cap } = await approve({ request: addReq, punches: ['09:00', '13:00', '14:00'], finalAction: 'add' });
  assert.deepEqual(JSON.parse(cap.reqPatch.hr_correctedpunches), ['09:00', '13:00', '14:00', '18:00']);
  assert.strictEqual(Number(cap.attUpdate.hr_effectivehours), 8);          // recalculated
  assert.strictEqual(toLabel('hr_attendance_status', cap.attUpdate.hr_status), 'present');
  assert.strictEqual(cap.reqPatch.hr_status, 'approved');
  assert.match(cap.audit.meta, /Approved action: add/);
});

test('Case 9 — approver DELETE: selected punch removed, day recomputed', async () => {
  const { cap } = await approve({ request: delReq, punches: ['09:00', '13:00', '13:35', '18:00'], finalAction: 'delete' });
  assert.deepEqual(JSON.parse(cap.reqPatch.hr_correctedpunches), ['09:00', '13:00', '18:00']);
  assert.match(cap.audit.meta, /Requested: delete · Approved action: delete/);
});

test('Case 10/20 — approver may choose a DIFFERENT final action; audit records requested + approved', async () => {
  // Employee requested ADD, approver finalAction = delete → the 18:00 punch is removed instead.
  const { cap } = await approve({ request: addReq, punches: ['09:00', '13:00', '18:00'], finalAction: 'delete' });
  assert.deepEqual(JSON.parse(cap.reqPatch.hr_correctedpunches), ['09:00', '13:00']);
  assert.match(cap.audit.meta, /Requested: add · Approved action: delete/);
});

test('Case 7 fallback — no finalAction supplied → applies the REQUESTED action (delete request → delete)', async () => {
  const { cap } = await approve({ request: delReq, punches: ['09:00', '13:00', '13:35', '18:00'], finalAction: undefined });
  assert.deepEqual(JSON.parse(cap.reqPatch.hr_correctedpunches), ['09:00', '13:00', '18:00']);
});

// ── Reject leaves attendance unchanged (Case 11) ──
function rejectHandler() {
  const layer = router.stack.find((l) => l.route && l.route.path === '/:id/reject');
  return layer.route.stack[layer.route.stack.length - 1].handle;
}
test('Case 11 — REJECT: no punch added/deleted, attendance record NEVER updated, status rejected', async () => {
  const orig = { getById: d365.getById, update: d365.update, rec: activity.record, email: notify.emailDecisionToEmployee };
  const cap = { attTouched: false, reqPatch: null };
  d365.getById = async () => addReq;
  d365.update = async (entity, id, payload) => { if (entity === ATT) cap.attTouched = true; else cap.reqPatch = payload; return { ...addReq, ...payload }; };
  activity.record = () => {}; notify.emailDecisionToEmployee = () => {};
  try {
    const req = { params: { id: 'r1' }, user: { role: 'hr_manager', name: 'HR', email: 'h@x.io' }, body: {} };
    const res = { status() { return this; }, json() { return this; } };
    await rejectHandler()(req, res, () => {});
  } finally { Object.assign(d365, { getById: orig.getById, update: orig.update }); activity.record = orig.rec; notify.emailDecisionToEmployee = orig.email; }
  assert.strictEqual(cap.attTouched, false, 'attendance record must not be touched on reject');
  assert.strictEqual(cap.reqPatch.hr_status, 'rejected');
});
