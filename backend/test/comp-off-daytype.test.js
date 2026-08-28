/**
 * Comp Off Type (Full / Half day) — employee choice + approver override.
 *
 * Full = 1.0 day, Half = 0.5 day. The type is a semantic view over hr_days (the single
 * balance source of truth), so type and balance can never diverge. These tests lock:
 *   • employee's Full/Half choice, capped by hours actually earned (never inflates)
 *   • approver's Full↔Half change at approval → the FINAL credited days
 *   • backward compatibility (no type sent → previous Full behaviour)
 *   • the pending-only / RBAC guards (employees & unauthorized roles can't change type)
 * No network — d365 / leave-engine / payroll-settings are stubbed. No notifications sent.
 */
process.env.NODE_ENV = 'test';
process.env.AZURE_CLIENT_ID = process.env.AZURE_CLIENT_ID || 'x';
process.env.AZURE_CLIENT_SECRET = process.env.AZURE_CLIENT_SECRET || 'x';
process.env.AZURE_TENANT_ID = process.env.AZURE_TENANT_ID || 'x';

const { test } = require('node:test');
const assert = require('node:assert');
const compOff = require('../src/services/comp-off.service');
const d365 = require('../src/services/d365.service');
const leaveEngine = require('../src/services/leave-engine.service');
const payrollSettings = require('../src/services/payroll-settings.service');
const { hasPermission } = require('../src/config/permissions');

// ── Employee choice → requested days (capped by hours earned) ─────────────────
test('requestedDaysForType: Full → 1, Half → 0.5 when fully eligible', () => {
  assert.equal(compOff.requestedDaysForType('full', 1), 1);
  assert.equal(compOff.requestedDaysForType('half', 1), 0.5);
});

test('requestedDaysForType: default (no type) → Full = eligible max (backward compatible)', () => {
  assert.equal(compOff.requestedDaysForType(undefined, 1), 1);
  assert.equal(compOff.requestedDaysForType('', 0.5), 0.5);
});

test('requestedDaysForType: Full is CAPPED to what the hours earned (no inflation)', () => {
  // Worked only enough for a half day → choosing Full still yields 0.5, never 1.
  assert.equal(compOff.requestedDaysForType('full', 0.5), 0.5);
  assert.equal(compOff.requestedDaysForType('half', 0.5), 0.5);
});

// ── Approver override → final credited days ───────────────────────────────────
test('approvedDaysForType: manual request honours the approver (HR discretion)', () => {
  assert.equal(compOff.approvedDaysForType({ dayType: 'half', verifiedDays: 1, isAuto: false }), 0.5);   // Full → Half
  assert.equal(compOff.approvedDaysForType({ dayType: 'full', verifiedDays: 0.5, isAuto: false }), 1);   // Half → Full
});

test('approvedDaysForType: auto record is capped by verified attendance (reduce only)', () => {
  assert.equal(compOff.approvedDaysForType({ dayType: 'full', verifiedDays: 0.5, isAuto: true }), 0.5);  // can't inflate past attendance
  assert.equal(compOff.approvedDaysForType({ dayType: 'half', verifiedDays: 1, isAuto: true }), 0.5);    // can reduce
});

test('approvedDaysForType: no override → the verified amount (unchanged behaviour)', () => {
  assert.equal(compOff.approvedDaysForType({ dayType: '', verifiedDays: 1, isAuto: false }), 1);
  assert.equal(compOff.approvedDaysForType({ dayType: null, verifiedDays: 0.5, isAuto: true }), 0.5);
});

// ── dayType is a derived VIEW over hr_days (history/details) ──────────────────
test('shape: hr_days 1 → Full, 0.5 → Half (type visible in history)', () => {
  assert.equal(compOff.shape({ hr_days: '1' }).dayType, 'full');
  assert.equal(compOff.shape({ hr_days: '1' }).days, 1);
  assert.equal(compOff.shape({ hr_days: '0.5' }).dayType, 'half');
  assert.equal(compOff.shape({ hr_days: '0.5' }).days, 0.5);
});

// ── approve() end-to-end: the FINAL type drives the balance credit ────────────
function stubApprove({ status = 'pending', type = 'manual', days = '1' } = {}) {
  const orig = { getById: d365.getById, update: d365.update, addLedgerEntry: leaveEngine.addLedgerEntry, getResolved: payrollSettings.getResolved };
  const captured = { ledgerDays: null, updated: null };
  d365.getById = async () => ({
    hr_compoffid: 'C1', hr_employeeid: 'E1', hr_employeename: 'Emp', hr_year: '2026',
    hr_type: type, hr_workeddate: '2026-08-15', hr_days: days, hr_status: status, hr_ledgerlinked: 'false',
  });
  d365.update = async (_e, _id, body) => { captured.updated = body; return {}; };
  leaveEngine.addLedgerEntry = async (e) => { captured.ledgerDays = e.days; return {}; };
  payrollSettings.getResolved = async () => ({ compOff: { expiryDays: 45 } });
  const restore = () => {
    d365.getById = orig.getById; d365.update = orig.update;
    leaveEngine.addLedgerEntry = orig.addLedgerEntry; payrollSettings.getResolved = orig.getResolved;
  };
  return { captured, restore };
}

test('approve: employee requested Full, approver changes to Half → balance credit 0.5', async () => {
  const { captured, restore } = stubApprove({ days: '1', type: 'manual' });
  try {
    const out = await compOff.approve('C1', { name: 'HR' }, { dayType: 'half' });
    assert.equal(captured.ledgerDays, 0.5, 'ledger credited 0.5');
    assert.equal(captured.updated.hr_days, '0.5', 'stored days = 0.5');
    assert.equal(captured.updated.hr_status, 'approved');
    assert.equal(out.days, 0.5);
    assert.equal(out.dayType, 'half');
  } finally { restore(); }
});

test('approve: employee requested Half, approver changes to Full → balance credit 1.0', async () => {
  const { captured, restore } = stubApprove({ days: '0.5', type: 'manual' });
  try {
    const out = await compOff.approve('C1', { name: 'HR' }, { dayType: 'full' });
    assert.equal(captured.ledgerDays, 1, 'ledger credited 1');
    assert.equal(captured.updated.hr_days, '1');
    assert.equal(out.days, 1);
    assert.equal(out.dayType, 'full');
  } finally { restore(); }
});

test('approve: no override → credits the requested amount (backward compatible)', async () => {
  const { captured, restore } = stubApprove({ days: '1', type: 'manual' });
  try {
    const out = await compOff.approve('C1', { name: 'HR' }, {});
    assert.equal(captured.ledgerDays, 1);
    assert.equal(out.days, 1);
  } finally { restore(); }
});

// ── Guards: type can't change once finalized ─────────────────────────────────
test('approve: changing type on an already-approved request is rejected (409)', async () => {
  const { restore } = stubApprove({ status: 'approved', days: '1' });
  try {
    await assert.rejects(() => compOff.approve('C1', { name: 'HR' }, { dayType: 'half' }), /already approved/i);
  } finally { restore(); }
});

test('approve: changing type on a rejected request is rejected (pending only)', async () => {
  const { restore } = stubApprove({ status: 'rejected', days: '1' });
  try {
    await assert.rejects(() => compOff.approve('C1', { name: 'HR' }, { dayType: 'half' }), /only be changed while.*pending/i);
  } finally { restore(); }
});

// ── RBAC: only authorized approvers/HR/Super Admin may change the type ────────
test('RBAC: employees cannot approve or edit comp-off (so cannot change another\'s type)', () => {
  assert.equal(hasPermission('employee', 'compoff.approve'), false);
  assert.equal(hasPermission('employee', 'compoff.edit'), false);
  // employees CAN still create/view their own (unchanged).
  assert.equal(hasPermission('employee', 'compoff.create'), true);
});

test('RBAC: HR and Super Admin can approve comp-off; an unrelated role cannot', () => {
  assert.equal(hasPermission('hr_manager', 'compoff.approve'), true);
  assert.equal(hasPermission('super_admin', 'compoff.approve'), true);
  assert.equal(hasPermission('recruiter', 'compoff.approve'), false);
});
