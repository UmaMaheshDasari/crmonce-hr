/**
 * Employees must be able to WRITE (upload/replace) documents for their OWN profile.
 * Regression guard for the "Permission Denied on upload" bug.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const { requirePermission, PERMISSIONS } = require('../src/middleware/auth.middleware');

function run(role, permission) {
  let status = 0, nexted = false;
  const req = { user: { role } };
  const res = { status(c) { status = c; return { json() { return this; } }; } };
  requirePermission(permission)(req, res, () => { nexted = true; });
  return { nexted, status };
}

test('employee role now includes document:write:self', () => {
  assert.ok(PERMISSIONS.employee.includes('document:write:self'), 'employee must have document:write:self');
});

test('employee can document:write (their own) — upload no longer denied', () => {
  assert.deepStrictEqual(run('employee', 'document:write'), { nexted: true, status: 0 });
});

test('employee can still document:read (own) and HR/Super Admin unaffected', () => {
  assert.strictEqual(run('employee', 'document:read').nexted, true);
  assert.strictEqual(run('hr_manager', 'document:write').nexted, true);
  assert.strictEqual(run('super_admin', 'document:write').nexted, true);
});

test('a role with no document permission is still denied', () => {
  const r = run('recruiter', 'document:write');
  assert.strictEqual(r.nexted, false);
  assert.strictEqual(r.status, 403);
});
