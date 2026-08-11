/**
 * Shared Request-Lifecycle EDIT (pending-only, owner-only) — the reusable security core
 * used by Attendance Correction, Leave, etc. An employee may edit their OWN PENDING
 * request's content; a non-owner is 403; a request that has left 'pending' is 409;
 * status/approval fields are never touched (only the adapter's mapped content fields).
 *
 * No network: d365 get/update/create stubbed. Adapters are the real registered ones.
 */
process.env.NODE_ENV = 'test';
process.env.AZURE_CLIENT_ID = process.env.AZURE_CLIENT_ID || 'test-client';
process.env.AZURE_CLIENT_SECRET = process.env.AZURE_CLIENT_SECRET || 'test-secret';
process.env.AZURE_TENANT_ID = process.env.AZURE_TENANT_ID || 'test-tenant';

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const d365 = require('../src/services/d365.service');
const { toValue } = require('../src/services/picklist');
const lifecycle = require('../src/services/request-lifecycle.service');
require('../src/services/request-adapters');   // registers leave / attendance_correction / … adapters

const OWNER = { id: 'emp-1', role: 'employee', name: 'Vishwesh' };
const OTHER = { id: 'emp-2', role: 'employee', name: 'Someone' };
const HR = { id: 'hr-1', role: 'hr_manager', name: 'HR' };

let orig;
beforeEach(() => { orig = { gid: d365.getById, gio: d365.getByIdOptional, upd: d365.update, cr: d365.create }; d365.create = async () => ({}); });
afterEach(() => { d365.getById = orig.gid; d365.getByIdOptional = orig.gio; d365.update = orig.upd; d365.create = orig.cr; });

// attendance_correction adapter uses d365.getById; row fields per its get() select.
function acRow(over = {}) { return { hr_attendancerequestid: 'r1', hr_employeeid: OWNER.id, hr_employeename: 'Vishwesh', hr_status: 'pending', hr_date: '2026-05-29', ...over }; }
function stubAC(row) { let patch; d365.getById = async () => row; d365.update = async (_e, _id, p) => { patch = p; return {}; }; return () => patch; }

test('owner edits own PENDING attendance correction → content fields patched', async () => {
  const getPatch = stubAC(acRow());
  await lifecycle.edit({ type: 'attendance_correction', id: 'r1', edits: { reason: 'Forgot to punch out', requestedTime: '19:05', punchType: 'missing_check_out', date: '2026-05-30' }, user: OWNER });
  const p = getPatch();
  assert.strictEqual(p.hr_reason, 'Forgot to punch out');
  assert.strictEqual(p.hr_requestedtime, '19:05');
  assert.strictEqual(p.hr_punchtype, 'missing_check_out');
  assert.strictEqual(p.hr_attendancedate, '2026-05-30');
  assert.ok(!('hr_status' in p), 'status is never touched by an edit');
});

test('a NON-owner employee cannot edit → 403', async () => {
  stubAC(acRow());
  await assert.rejects(() => lifecycle.edit({ type: 'attendance_correction', id: 'r1', edits: { reason: 'x' }, user: OTHER }), /Access denied/);
});

test('editing a non-PENDING (rejected) request → 409 cannot be modified', async () => {
  let updated = false; d365.getById = async () => acRow({ hr_status: 'rejected' }); d365.update = async () => { updated = true; return {}; };
  await assert.rejects(() => lifecycle.edit({ type: 'attendance_correction', id: 'r1', edits: { reason: 'x' }, user: OWNER }), (e) => e.status === 409 && /can no longer be modified/i.test(e.message));
  assert.strictEqual(updated, false, 'no write on a locked request');
});

test('editing an approved request → 409 (locked)', async () => {
  d365.getById = async () => acRow({ hr_status: 'approved' });
  await assert.rejects(() => lifecycle.edit({ type: 'attendance_correction', id: 'r1', edits: { reason: 'x' }, user: OWNER }), (e) => e.status === 409);
});

test('HR bypasses ownership but the pending-only lock still applies', async () => {
  const getPatch = stubAC(acRow());
  await lifecycle.edit({ type: 'attendance_correction', id: 'r1', edits: { reason: 'HR tweak' }, user: HR });   // pending → ok
  assert.strictEqual(getPatch().hr_reason, 'HR tweak');
  d365.getById = async () => acRow({ hr_status: 'approved' });
  await assert.rejects(() => lifecycle.edit({ type: 'attendance_correction', id: 'r1', edits: { reason: 'x' }, user: HR }), (e) => e.status === 409);
});

// Historical Attendance adapter (text status; more_info counts as pending).
test('owner edits own PENDING historical attendance → date/time/reason patched', async () => {
  const row = { hr_histattendanceid: 'h1', hr_employeeid: OWNER.id, hr_employeename: 'V', hr_status: 'pending', hr_date: '2026-05-20' };
  let patch; d365.getById = async () => row; d365.update = async (_e, _id, p) => { patch = p; return {}; };
  await lifecycle.edit({ type: 'historical_attendance', id: 'h1', edits: { date: '2026-05-21', inTime: '09:00', outTime: '18:00', reason: 'was present' }, user: OWNER });
  assert.strictEqual(patch.hr_date, '2026-05-21');
  assert.strictEqual(patch.hr_intime, '09:00');
  assert.strictEqual(patch.hr_reason, 'was present');
  assert.ok(!('hr_status' in patch), 'status never touched');
});
test('approved historical attendance cannot be edited → 409', async () => {
  d365.getById = async () => ({ hr_histattendanceid: 'h1', hr_employeeid: OWNER.id, hr_status: 'approved', hr_date: '2026-05-20' });
  await assert.rejects(() => lifecycle.edit({ type: 'historical_attendance', id: 'h1', edits: { reason: 'x' }, user: OWNER }), (e) => e.status === 409);
});
test('a non-owner cannot edit a historical attendance → 403', async () => {
  d365.getById = async () => ({ hr_histattendanceid: 'h1', hr_employeeid: OWNER.id, hr_status: 'pending', hr_date: '2026-05-20' });
  await assert.rejects(() => lifecycle.edit({ type: 'historical_attendance', id: 'h1', edits: { reason: 'x' }, user: OTHER }), /Access denied/);
});

// Leave adapter uses getByIdOptional + numeric option-set status; edit maps dates/days/reason.
test('owner edits own PENDING leave → dates/days/reason patched, type/status untouched', async () => {
  const leaveRow = { hr_hrleaveid: 'l1', _hr_hremployee_value: OWNER.id, hr_status: toValue('hr_leave_status', 'pending'), hr_l1status: 'pending', hr_leavetype: toValue('hr_leave_type', 'Casual Leave'), hr_startdate: '2026-05-10', hr_enddate: '2026-05-12' };
  let patch; d365.getByIdOptional = async () => leaveRow; d365.update = async (_e, _id, p) => { patch = p; return {}; };
  await lifecycle.edit({ type: 'leave', id: 'l1', edits: { fromDate: '2026-05-11', toDate: '2026-05-13', days: 3, reason: 'updated' }, user: OWNER });
  assert.strictEqual(patch.hr_fromdate, '2026-05-11');
  assert.strictEqual(patch.hr_todate, '2026-05-13');
  assert.strictEqual(patch.hr_days, '3');
  assert.strictEqual(patch.hr_reason, 'updated');
  assert.ok(!('hr_leavetype' in patch) && !('hr_status' in patch), 'type + status never edited');
});
