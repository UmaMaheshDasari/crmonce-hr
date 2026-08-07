/**
 * Request Lifecycle — adapter registration, canonical status derivation and
 * per-module capability flags (pure logic, no network).
 */
process.env.NODE_ENV = 'test';
process.env.AZURE_CLIENT_ID = process.env.AZURE_CLIENT_ID || 'test-client';
process.env.AZURE_CLIENT_SECRET = process.env.AZURE_CLIENT_SECRET || 'test-secret';
process.env.AZURE_TENANT_ID = process.env.AZURE_TENANT_ID || 'test-tenant';

const { test } = require('node:test');
const assert = require('node:assert');
require('../src/services/request-adapters');   // registers adapters
const lc = require('../src/services/request-lifecycle.service');
const { toValue } = require('../src/services/picklist');

test('all expected adapters are registered', () => {
  const t = lc.knownTypes();
  for (const type of ['leave', 'late_login', 'comp_off', 'attendance_correction', 'document']) assert.ok(t.includes(type), `${type} registered`);
});

test('unknown type throws a 400', () => {
  assert.throws(() => lc.getAdapter('nope'), (e) => e.status === 400);
});

test('leave: numeric picklist → canonical status (incl. L1 manager_approved)', () => {
  const a = lc.getAdapter('leave');
  assert.strictEqual(a.status({ hr_status: toValue('hr_leave_status', 'approved') }), 'approved');
  assert.strictEqual(a.status({ hr_status: toValue('hr_leave_status', 'rejected') }), 'rejected');
  assert.strictEqual(a.status({ hr_status: toValue('hr_leave_status', 'cancelled') }), 'cancelled');
  assert.strictEqual(a.status({ hr_status: toValue('hr_leave_status', 'pending') }), 'pending');
  assert.strictEqual(a.status({ hr_status: toValue('hr_leave_status', 'pending'), hr_l1status: 'approved' }), 'manager_approved');
});

test('late_login: text status + manager stage', () => {
  const a = lc.getAdapter('late_login');
  assert.strictEqual(a.status({ hr_status: 'approved' }), 'approved');
  assert.strictEqual(a.status({ hr_status: 'cancelled' }), 'cancelled');
  assert.strictEqual(a.status({ hr_status: 'pending', hr_managerstatus: 'approved' }), 'manager_approved');
  assert.strictEqual(a.status({ hr_status: 'pending', hr_managerstatus: 'pending' }), 'pending');
});

test('comp_off: expired collapses to cancelled (view-only)', () => {
  const a = lc.getAdapter('comp_off');
  assert.strictEqual(a.status({ hr_status: 'expired' }), 'cancelled');
  assert.strictEqual(a.status({ hr_status: 'cancelled' }), 'cancelled');
  assert.strictEqual(a.status({ hr_status: 'approved' }), 'approved');
  // Comp Off owns its cancellation effect (ledger reversal) via onCancelled.
  assert.strictEqual(typeof a.onCancelled, 'function');
});

test('attendance_correction: cancellation disabled (punch integrity)', () => {
  const a = lc.getAdapter('attendance_correction');
  assert.strictEqual(a.canCancel, false);
  assert.strictEqual(a.status({ hr_status: 'approved' }), 'approved');
  assert.strictEqual(a.status({ hr_status: 'rejected' }), 'rejected');
});

test('document: delete-only (no resubmit / no cancellation); verified→approved', () => {
  const a = lc.getAdapter('document');
  assert.strictEqual(a.canResubmit, false);
  assert.strictEqual(a.canCancel, false);
  assert.strictEqual(a.status({ hr_status: 'verified' }), 'approved');
  assert.strictEqual(a.status({ hr_status: 'reupload' }), 'rejected');
  assert.strictEqual(a.status({ hr_status: 'superseded' }), 'cancelled');
});

test('adapters expose the write patches the engine needs', () => {
  for (const type of ['leave', 'late_login', 'comp_off']) {
    const a = lc.getAdapter(type);
    assert.ok(a.cancelledPatch() && typeof a.cancelledPatch() === 'object');
    assert.ok(a.resubmitPatch() && typeof a.resubmitPatch() === 'object');
    assert.strictEqual(typeof a.applyEdits({}), 'object');
  }
});
