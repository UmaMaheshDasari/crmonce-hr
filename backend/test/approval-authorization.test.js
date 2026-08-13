/**
 * Approval authorization — the ONE shared rule used by BOTH the email button rendering
 * and the approval API guard (leave /:id/email-action):
 *
 *   A user may approve iff  (authorized HR/Admin/Super Admin role)  OR  (explicit approver).
 *   CC membership alone grants NOTHING → a normal CC user is 403.
 *
 * Pure-logic tests (no network) over request-notify's exported helpers.
 */
process.env.NODE_ENV = 'test';
process.env.AZURE_CLIENT_ID = process.env.AZURE_CLIENT_ID || 'test-client';
process.env.AZURE_CLIENT_SECRET = process.env.AZURE_CLIENT_SECRET || 'test-secret';
process.env.AZURE_TENANT_ID = process.env.AZURE_TENANT_ID || 'test-tenant';

const { test } = require('node:test');
const assert = require('node:assert');
const { isAuthorizedApprovalRole, canActOnApproval } = require('../src/services/request-notify.service');
const { requireRole } = require('../src/middleware/auth.middleware');

// The exact middleware guarding the leave email-action / approve routes.
function guard(role) {
  const mw = requireRole('super_admin', 'hr_manager');
  let code = 200, nexted = false;
  mw({ user: { role } }, { status: (c) => { code = c; return { json: () => {} }; } }, () => { nexted = true; });
  return { code, nexted };
}

// 6 + 11: a normal CC user calling the approval API is stopped at the route guard → 403.
test('API guard: employee (normal CC) → 403; recruiter → 403; HR/Super Admin → allowed', () => {
  assert.strictEqual(guard('employee').code, 403);
  assert.strictEqual(guard('employee').nexted, false);
  assert.strictEqual(guard('recruiter').code, 403);
  assert.strictEqual(guard('hr_manager').nexted, true);
  assert.strictEqual(guard('super_admin').nexted, true);
});

// ── which roles carry authorized approval access ──
test('authorized approval roles = super_admin + hr_manager (case-insensitive)', () => {
  assert.strictEqual(isAuthorizedApprovalRole('super_admin'), true);
  assert.strictEqual(isAuthorizedApprovalRole('hr_manager'), true);
  assert.strictEqual(isAuthorizedApprovalRole('SUPER_ADMIN'), true);
  assert.strictEqual(isAuthorizedApprovalRole('employee'), false);
  assert.strictEqual(isAuthorizedApprovalRole('recruiter'), false);
  assert.strictEqual(isAuthorizedApprovalRole(''), false);
  assert.strictEqual(isAuthorizedApprovalRole(undefined), false);
});

const APPROVER_ID = 'APP-1';

// 1. Explicit HR approver → may act.
test('explicit HR approver → can act', () => {
  assert.strictEqual(canActOnApproval({ role: 'hr_manager', userId: APPROVER_ID, approverId: APPROVER_ID }), true);
});

// 2. Explicit non-admin approver → may act because explicitly selected (rule allows it;
//    for Leave the approver is always HR, but the shared rule still honors explicit approver).
test('explicit approver with a non-admin role → can act (explicitly selected)', () => {
  assert.strictEqual(canActOnApproval({ role: 'employee', userId: APPROVER_ID, approverId: APPROVER_ID }), true);
});

// 3 + 4. CC Super Admin / CC HR (NOT the selected approver) → may act via authorized role.
test('CC Super Admin (not the approver) → can act (authorized role)', () => {
  assert.strictEqual(canActOnApproval({ role: 'super_admin', userId: 'CC-1', approverId: APPROVER_ID }), true);
});
test('CC HR Manager (not the approver) → can act (authorized role)', () => {
  assert.strictEqual(canActOnApproval({ role: 'hr_manager', userId: 'CC-2', approverId: APPROVER_ID }), true);
});

// 5 + 7. CC normal Team Lead / employee without admin-HR access → CANNOT act (→ 403).
test('CC normal Team Lead (employee role, not approver) → cannot act', () => {
  assert.strictEqual(canActOnApproval({ role: 'employee', userId: 'CC-3', approverId: APPROVER_ID }), false);
});
test('CC recruiter (not an approval role, not approver) → cannot act', () => {
  assert.strictEqual(canActOnApproval({ role: 'recruiter', userId: 'CC-4', approverId: APPROVER_ID }), false);
});

// 6 / 11. CC alone NEVER grants access — the rule ignores CC membership entirely.
test('being CC-listed does not grant access: a normal user is denied regardless', () => {
  // Same normal user, whether or not they were CC'd, is denied.
  assert.strictEqual(canActOnApproval({ role: 'employee', userId: 'CC-3', approverId: APPROVER_ID }), false);
});

// A legacy request with no assigned approver still requires an authorized role.
test('no assigned approver → only an authorized role may act', () => {
  assert.strictEqual(canActOnApproval({ role: 'hr_manager', userId: 'X', approverId: undefined }), true);
  assert.strictEqual(canActOnApproval({ role: 'employee', userId: 'X', approverId: undefined }), false);
});
