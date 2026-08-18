/**
 * Approved-leave cancellation rule.
 *   Pure rule (computeEligibility): future = always; today/past = only if Present
 *   on that exact date; multi-day = every <=today date must be Present.
 *   IO (leaveCancellationStatus): only hr_status='present' counts as Present.
 *   Engine (requestCancellation): backend re-validates; owner-only; no attendance/
 *   leave mutation on the cancellation request; repeated request fails safely.
 * No network: d365 + time are stubbed; EMAIL_DRY_RUN blocks any send.
 */
process.env.NODE_ENV = 'test';
process.env.EMAIL_DRY_RUN = 'true';
process.env.AZURE_CLIENT_ID = process.env.AZURE_CLIENT_ID || 'test-client';
process.env.AZURE_CLIENT_SECRET = process.env.AZURE_CLIENT_SECRET || 'test-secret';
process.env.AZURE_TENANT_ID = process.env.AZURE_TENANT_ID || 'test-tenant';

const { test } = require('node:test');
const assert = require('node:assert');
const cancelUtil = require('../src/services/leave-cancel.util');
const { computeEligibility } = cancelUtil;
const d365 = require('../src/services/d365.service');
const time = require('../src/services/time.util');
const { toValue } = require('../src/services/picklist');
const lifecycle = require('../src/services/request-lifecycle.service');
require('../src/services/request-adapters');   // registers the leave adapter

const S = (...d) => new Set(d);

// ── PURE business rule ────────────────────────────────────────────────────────
test('RULE 1 — future approved leave → allowed (no attendance needed)', () => {
  assert.deepStrictEqual(computeEligibility({ fromDate: '2026-08-20', toDate: '2026-08-20', today: '2026-08-18', presentDates: S() }), { ok: true });
});
test("RULE 2 — today's leave + Present → allowed", () => {
  assert.strictEqual(computeEligibility({ fromDate: '2026-08-18', toDate: '2026-08-18', today: '2026-08-18', presentDates: S('2026-08-18') }).ok, true);
});
test("RULE 2 — today's leave + NOT Present → denied", () => {
  const r = computeEligibility({ fromDate: '2026-08-18', toDate: '2026-08-18', today: '2026-08-18', presentDates: S() });
  assert.strictEqual(r.ok, false); assert.match(r.reason, /today/i);
});
test('RULE 3 — past leave + Present on exact date → allowed', () => {
  assert.strictEqual(computeEligibility({ fromDate: '2026-08-15', toDate: '2026-08-15', today: '2026-08-18', presentDates: S('2026-08-15') }).ok, true);
});
test('RULE 3 — past leave + Absent → denied', () => {
  const r = computeEligibility({ fromDate: '2026-08-15', toDate: '2026-08-15', today: '2026-08-18', presentDates: S() });
  assert.strictEqual(r.ok, false); assert.match(r.reason, /Present attendance record.*15-08-2026/);
});
test('RULE 3 — past leave + Leave/Half-Day/Incomplete (not Present) → denied', () => {
  // presentDates ONLY holds strictly-'present' dates → a leave/half-day/incomplete date is absent from it.
  assert.strictEqual(computeEligibility({ fromDate: '2026-08-14', toDate: '2026-08-14', today: '2026-08-18', presentDates: S() }).ok, false);
});
test('RULE 3 — past leave + no attendance record → denied', () => {
  assert.strictEqual(computeEligibility({ fromDate: '2026-08-10', toDate: '2026-08-10', today: '2026-08-18', presentDates: S() }).ok, false);
});
test('MULTI-DAY — every past/today date Present → allowed', () => {
  assert.strictEqual(computeEligibility({ fromDate: '2026-08-15', toDate: '2026-08-17', today: '2026-08-18', presentDates: S('2026-08-15', '2026-08-16', '2026-08-17') }).ok, true);
});
test('MULTI-DAY — one interior past date NOT Present → whole leave denied (names that date)', () => {
  const r = computeEligibility({ fromDate: '2026-08-15', toDate: '2026-08-17', today: '2026-08-18', presentDates: S('2026-08-15', '2026-08-17') });
  assert.strictEqual(r.ok, false); assert.match(r.reason, /16-08-2026/);
});
test('MULTI-DAY — spans past→future: past Present + future free → allowed', () => {
  assert.strictEqual(computeEligibility({ fromDate: '2026-08-17', toDate: '2026-08-20', today: '2026-08-18', presentDates: S('2026-08-17', '2026-08-18') }).ok, true);
});
test('MULTI-DAY — spans past→future: a past date Absent → denied', () => {
  assert.strictEqual(computeEligibility({ fromDate: '2026-08-17', toDate: '2026-08-20', today: '2026-08-18', presentDates: S('2026-08-18') }).ok, false);
});
test('INVALID dates → denied safely (never throws)', () => {
  assert.strictEqual(computeEligibility({ fromDate: '', toDate: '', today: '2026-08-18', presentDates: S() }).ok, false);
  assert.strictEqual(computeEligibility({ fromDate: '2026-08-20', toDate: '2026-08-15', today: '2026-08-18', presentDates: S() }).ok, false);
});
test('TIMEZONE — civil date compare (no UTC drift): today boundary + prev-day', () => {
  assert.strictEqual(computeEligibility({ fromDate: '2026-01-01', toDate: '2026-01-01', today: '2026-01-01', presentDates: S('2026-01-01') }).ok, true);
  assert.strictEqual(computeEligibility({ fromDate: '2025-12-31', toDate: '2025-12-31', today: '2026-01-01', presentDates: S() }).ok, false);
});

// ── IO: present-detection uses the EXISTING attendance status ─────────────────
test('leaveCancellationStatus — only hr_status=present counts (half_day is NOT present)', async () => {
  const orig = d365.getList;
  d365.getList = async () => ({ data: [
    { _hr_hremployee_value: 'E1', hr_date: '2026-08-15', hr_status: toValue('hr_attendance_status', 'present') },
    { _hr_hremployee_value: 'E1', hr_date: '2026-08-16', hr_status: toValue('hr_attendance_status', 'half_day') },
  ] });
  try {
    assert.strictEqual((await cancelUtil.leaveCancellationStatus({ employeeId: 'E1', fromDate: '2026-08-15', toDate: '2026-08-15', today: '2026-08-18' })).ok, true);
    assert.strictEqual((await cancelUtil.leaveCancellationStatus({ employeeId: 'E1', fromDate: '2026-08-16', toDate: '2026-08-16', today: '2026-08-18' })).ok, false);
  } finally { d365.getList = orig; }
});

// ── Engine: backend enforcement (owner-only, no mutation, dedupe) ─────────────
const LEAVE_ENT = d365.constructor.entities.leave;
const ATT_ENT = d365.constructor.entities.attendance;

function stubLeave({ status = 'approved', from, to, empId = 'E1', attendance = [], existingCancellation = null, today = '2026-08-18' } = {}) {
  const o = { g: d365.getByIdOptional, gb: d365.getById, l: d365.getList, c: d365.create, u: d365.update, t: time.istDateStr };
  const calls = { creates: [], updates: [] };
  time.istDateStr = () => today;
  const leaveRow = { hr_hrleaveid: 'L1', hr_status: toValue('hr_leave_status', status), hr_fromdate: from, hr_todate: to, hr_leavetype: 0, _hr_hremployee_value: empId, hr_l1status: 'approved', hr_l2status: '' };
  d365.getByIdOptional = async () => leaveRow;                 // leave get + (manager lookup → no _hr_manager_value)
  d365.getById = async () => ({});
  d365.getList = async (_e, opts) => {
    const f = String(opts?.filter || '');
    if (f.includes('hr_requesttype')) return { data: existingCancellation ? [existingCancellation] : [] };  // activeCancellation
    if (f.includes('hr_date ge')) return { data: attendance };                                              // attendance
    return { data: [] };                                                                                     // hrRecipients etc.
  };
  d365.create = async (e, b) => { calls.creates.push({ e, b }); return { hr_cancellationrequestid: 'C1', ...b }; };
  d365.update = async (e, id, b) => { calls.updates.push({ e, id, b }); return {}; };
  return { calls, restore() { d365.getByIdOptional = o.g; d365.getById = o.gb; d365.getList = o.l; d365.create = o.c; d365.update = o.u; time.istDateStr = o.t; } };
}

test('requestCancellation — DENIED: past approved leave, no Present (nothing created)', async () => {
  const s = stubLeave({ from: '2026-08-15', to: '2026-08-15', attendance: [] });
  try {
    await assert.rejects(
      lifecycle.requestCancellation({ type: 'leave', id: 'L1', reason: 'x', user: { id: 'E1', role: 'employee' } }),
      (e) => /Present attendance record/.test(e.message) && e.status === 400);
    assert.strictEqual(s.calls.creates.length, 0);
  } finally { s.restore(); }
});
test('requestCancellation — ALLOWED: past leave with Present; attendance & leave NOT mutated', async () => {
  const s = stubLeave({ from: '2026-08-15', to: '2026-08-15', attendance: [{ _hr_hremployee_value: 'E1', hr_date: '2026-08-15', hr_status: toValue('hr_attendance_status', 'present') }] });
  try {
    await lifecycle.requestCancellation({ type: 'leave', id: 'L1', reason: 'was present', user: { id: 'E1', role: 'employee' } });
    assert.ok(s.calls.creates.length >= 1);                                     // cancellation request row created
    assert.ok(s.calls.updates.every(u => u.e !== ATT_ENT), 'attendance never updated');
    assert.ok(s.calls.updates.every(u => u.e !== LEAVE_ENT), 'leave record not changed on the request');
  } finally { s.restore(); }
});
test('requestCancellation — ALLOWED: future leave regardless of attendance', async () => {
  const s = stubLeave({ from: '2026-08-25', to: '2026-08-25', attendance: [] });
  try {
    await lifecycle.requestCancellation({ type: 'leave', id: 'L1', reason: 'plans changed', user: { id: 'E1', role: 'employee' } });
    assert.ok(s.calls.creates.length >= 1);
  } finally { s.restore(); }
});
test('requestCancellation — unauthorized (non-owner, non-HR) → 403, nothing created', async () => {
  const s = stubLeave({ from: '2026-08-25', to: '2026-08-25' });
  try {
    await assert.rejects(
      lifecycle.requestCancellation({ type: 'leave', id: 'L1', reason: 'x', user: { id: 'STRANGER', role: 'employee' } }),
      (e) => /Access denied/.test(e.message) && e.status === 403);
    assert.strictEqual(s.calls.creates.length, 0);
  } finally { s.restore(); }
});
test('requestCancellation — repeated attempt fails safely (one already pending)', async () => {
  const s = stubLeave({ from: '2026-08-25', to: '2026-08-25', existingCancellation: { hr_cancellationrequestid: 'C0', hr_requestid: 'L1', hr_requesttype: 'leave', hr_status: 'pending' } });
  try {
    await assert.rejects(
      lifecycle.requestCancellation({ type: 'leave', id: 'L1', reason: 'again', user: { id: 'E1', role: 'employee' } }),
      (e) => /already pending/.test(e.message));
  } finally { s.restore(); }
});
