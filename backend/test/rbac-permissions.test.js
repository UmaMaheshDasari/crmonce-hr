/**
 * RBAC Phase A — permission catalogue + resolver. Pure, no I/O. Verifies the model is
 * correct and behaviour-preserving; NO enforcement is wired yet (that is Phase B).
 */
const { test } = require('node:test');
const assert = require('node:assert');
const { hasPermission, permissionsForRole, ROLE_PERMISSIONS, ALL_PERMISSIONS, CATALOGUE } = require('../src/config/permissions');

// ── hasPermission: wildcards, module-wildcard, exact, unknown ──
test('super_admin holds every permission via "*"', () => {
  assert.equal(hasPermission('super_admin', 'attendance.delete_punch'), true);
  assert.equal(hasPermission('super_admin', 'users.delete'), true);
  assert.equal(hasPermission('super_admin', 'anything.at_all'), true);
});

test('hr_manager: module-wildcard grants (attendance.* → delete_punch) but not super-admin-only actions', () => {
  assert.equal(hasPermission('hr_manager', 'attendance.delete_punch'), true);   // via attendance.*
  assert.equal(hasPermission('hr_manager', 'attendance.override'), true);
  assert.equal(hasPermission('hr_manager', 'leave.approve'), true);
  assert.equal(hasPermission('hr_manager', 'salary.view'), true);               // exact grant
  assert.equal(hasPermission('hr_manager', 'employees.edit'), true);
  // Reserved for super_admin (preserves today's behaviour):
  assert.equal(hasPermission('hr_manager', 'employees.delete'), false);
  assert.equal(hasPermission('hr_manager', 'users.view'), false);
  assert.equal(hasPermission('hr_manager', 'roles.edit'), false);
  assert.equal(hasPermission('hr_manager', 'settings.edit'), false);
  assert.equal(hasPermission('hr_manager', 'audit.export'), false);
});

test('employee: own-scope actions only, never attendance mutation or admin', () => {
  assert.equal(hasPermission('employee', 'leave.apply'), true);
  assert.equal(hasPermission('employee', 'attendance.view'), true);
  assert.equal(hasPermission('employee', 'payslip.print'), true);
  assert.equal(hasPermission('employee', 'compoff.create'), true);
  assert.equal(hasPermission('employee', 'attendance.delete_punch'), false);
  assert.equal(hasPermission('employee', 'attendance.edit'), false);
  assert.equal(hasPermission('employee', 'leave.approve'), false);
  assert.equal(hasPermission('employee', 'payroll.view'), false);
  assert.equal(hasPermission('employee', 'salary.view'), false);
  assert.equal(hasPermission('employee', 'settings.view'), false);
});

test('recruiter (dormant): recruitment + read employees only', () => {
  assert.equal(hasPermission('recruiter', 'recruitment.create'), true);
  assert.equal(hasPermission('recruiter', 'employees.view'), true);
  assert.equal(hasPermission('recruiter', 'attendance.view'), false);
});

test('unknown role or unknown permission → false (never throws)', () => {
  assert.equal(hasPermission('nope', 'attendance.view'), false);
  assert.equal(hasPermission('employee', 'made.up'), false);
  assert.equal(hasPermission(undefined, 'attendance.view'), false);
  assert.equal(hasPermission({ role: 'hr_manager' }, 'leave.approve'), true);   // accepts a user object
});

// ── permissionsForRole: expansion for /auth/me ──
test('permissionsForRole: super_admin → ["*"]', () => {
  assert.deepEqual(permissionsForRole('super_admin'), ['*']);
});

test('permissionsForRole expands module.* into concrete permissions', () => {
  const hr = permissionsForRole('hr_manager');
  assert.ok(hr.includes('attendance.delete_punch'));   // expanded from attendance.*
  assert.ok(hr.includes('attendance.approve_request'));
  assert.ok(hr.includes('leave.manage_balance'));      // expanded from leave.*
  assert.ok(hr.includes('salary.view'));
  assert.ok(!hr.includes('employees.delete'));
  assert.ok(!hr.includes('users.view'));
  assert.ok(!hr.includes('*'));
});

test('permissionsForRole(employee) is the self-serviceable set only', () => {
  const emp = permissionsForRole('employee');
  assert.ok(emp.includes('leave.apply'));
  assert.ok(emp.includes('payslip.view'));
  assert.ok(!emp.includes('attendance.delete_punch'));
  assert.ok(!emp.includes('payroll.view'));
});

// ── catalogue integrity ──
test('ALL_PERMISSIONS is the flat module.action list and every role grant is resolvable', () => {
  assert.ok(ALL_PERMISSIONS.includes('attendance.delete_punch'));
  assert.ok(ALL_PERMISSIONS.includes('roles.edit'));
  assert.ok(ALL_PERMISSIONS.length === Object.values(CATALOGUE).reduce((n, a) => n + a.length, 0));
  // Every non-wildcard grant references a real catalogue permission.
  for (const [role, grants] of Object.entries(ROLE_PERMISSIONS)) {
    for (const g of grants) {
      if (g === '*') continue;
      if (g.endsWith('.*')) { assert.ok(CATALOGUE[g.slice(0, -2)], `${role}: unknown module ${g}`); continue; }
      assert.ok(ALL_PERMISSIONS.includes(g), `${role}: grant ${g} not in catalogue`);
    }
  }
});
