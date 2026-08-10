/**
 * Employee-role access control (navigation + API authorization).
 *
 * Proves the backend authorization boundary for the Employee role:
 *   • Employee-management writes (create / delete / verify / backfill / sync,
 *     payroll generate/approve/lock, salary create/update/delete) are HR-gated
 *     → an employee is refused with 403.
 *   • Salary Structure is NOT available to employees (blockEmployees → 403), while
 *     HR / Super Admin / Recruiter pass through to the (self-scoping) handler.
 *   • Employee READ endpoints (employees list/:id, attendance, leave, payroll,
 *     documents) let the employee through requirePermission and are then scoped to
 *     req.user.id inside the handler — this test locks the middleware half.
 *
 * Pure middleware tests — no network (mirrors document-permissions.test.js).
 */
process.env.NODE_ENV = 'test';
process.env.AZURE_CLIENT_ID = process.env.AZURE_CLIENT_ID || 'test-client';
process.env.AZURE_CLIENT_SECRET = process.env.AZURE_CLIENT_SECRET || 'test-secret';
process.env.AZURE_TENANT_ID = process.env.AZURE_TENANT_ID || 'test-tenant';

const { test } = require('node:test');
const assert = require('node:assert');
const { requireRole, requirePermission } = require('../src/middleware/auth.middleware');
const salaryRouter = require('../src/modules/payroll/salary-structure.routes');

// Run a middleware with a mocked req/res and report {nexted, status}.
function invoke(mw, role) {
  let status = 0, nexted = false;
  const req = { user: role ? { role, id: 'self-guid' } : undefined };
  const res = { status(c) { status = c; return { json() { return this; } }; } };
  mw(req, res, () => { nexted = true; });
  return { nexted, status };
}

// ── HR-only management routes (create/delete/verify/backfill/sync/generate/…) ──
test('employee is BLOCKED (403) from HR-only management routes', () => {
  const hrOnly = requireRole('super_admin', 'hr_manager');
  assert.deepStrictEqual(invoke(hrOnly, 'employee'), { nexted: false, status: 403 });
});

test('HR manager and Super Admin PASS HR-only management routes', () => {
  const hrOnly = requireRole('super_admin', 'hr_manager');
  assert.strictEqual(invoke(hrOnly, 'hr_manager').nexted, true);
  assert.strictEqual(invoke(hrOnly, 'super_admin').nexted, true);
});

test('DELETE employee is Super-Admin only — HR manager AND employee are blocked (403)', () => {
  const superOnly = requireRole('super_admin');
  assert.strictEqual(invoke(superOnly, 'hr_manager').status, 403);
  assert.strictEqual(invoke(superOnly, 'employee').status, 403);
  assert.strictEqual(invoke(superOnly, 'super_admin').nexted, true);
});

// ── Salary Structure = NOT AVAILABLE to employees ──
test('Salary Structure blocks the employee role outright (403)', () => {
  assert.deepStrictEqual(invoke(salaryRouter.blockEmployees, 'employee'), { nexted: false, status: 403 });
});

test('Salary Structure reads pass for HR / Super Admin / Recruiter (scoped downstream)', () => {
  assert.strictEqual(invoke(salaryRouter.blockEmployees, 'hr_manager').nexted, true);
  assert.strictEqual(invoke(salaryRouter.blockEmployees, 'super_admin').nexted, true);
  assert.strictEqual(invoke(salaryRouter.blockEmployees, 'recruiter').nexted, true);
});

// ── Employee READ endpoints: pass the permission gate, then self-scope in-handler ──
test('employee passes requirePermission(employee:read) — handler then self-scopes to req.user.id', () => {
  assert.strictEqual(invoke(requirePermission('employee:read'), 'employee').nexted, true);
});

test('employee passes attendance/payroll/document :read (self) — never :write:all', () => {
  assert.strictEqual(invoke(requirePermission('attendance:read'), 'employee').nexted, true);
  assert.strictEqual(invoke(requirePermission('payroll:read'), 'employee').nexted, true);
  assert.strictEqual(invoke(requirePermission('document:read'), 'employee').nexted, true);
});

test('an unauthenticated request (no req.user) is refused by requireRole', () => {
  assert.strictEqual(invoke(requireRole('super_admin', 'hr_manager'), null).status, 403);
});
