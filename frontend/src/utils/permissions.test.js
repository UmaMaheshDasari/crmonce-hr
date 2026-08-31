/**
 * Frontend permission resolver — parity with backend hasPermission semantics.
 * Pure, no React. Run: `node --test src/utils/permissions.test.js`.
 * The arrays below mirror what GET /auth/me returns per role (permissionsForRole).
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { hasPermission } from './permissions.js';

// Representative /auth/me permission lists (backend pre-expands module.* → concrete).
const SUPER_ADMIN = ['*'];
const HR_MANAGER = [
  'employees.view', 'employees.create', 'employees.edit',
  'attendance.view', 'attendance.edit', 'attendance.add_punch', 'attendance.approve_request', 'attendance.reject_request', 'attendance.export',
  'leave.approve', 'leave.reject', 'leave.manage_balance',
  'compoff.approve', 'compoff.reject', 'compoff.edit', 'compoff.configure', 'compoff.manage_balance',
  'payroll.view', 'payroll.process', 'payroll.edit', 'payroll.export',
  'salary.view', 'salary.edit', 'payslip.view',
  'performance.create', 'performance.edit', 'performance.delete',
  'recruitment.view', 'documents.verify', 'documents.upload', 'reports.export', 'settings.view',
];
const EMPLOYEE = ['employees.view', 'attendance.view', 'leave.view', 'leave.apply', 'compoff.view', 'compoff.create', 'payslip.view', 'documents.view', 'documents.upload'];
const RECRUITER = ['employees.view', 'recruitment.view', 'recruitment.create', 'recruitment.edit', 'recruitment.delete'];

test('super_admin holds every permission via "*"', () => {
  assert.equal(hasPermission(SUPER_ADMIN, 'payroll.process'), true);
  assert.equal(hasPermission(SUPER_ADMIN, 'employees.delete'), true);
  assert.equal(hasPermission(SUPER_ADMIN, 'anything.at_all'), true);
});

test('hr_manager: HR operational actions allowed; super-admin-only + recruitment.edit denied', () => {
  assert.equal(hasPermission(HR_MANAGER, 'leave.approve'), true);
  assert.equal(hasPermission(HR_MANAGER, 'compoff.configure'), true);
  assert.equal(hasPermission(HR_MANAGER, 'payroll.edit'), true);
  assert.equal(hasPermission(HR_MANAGER, 'salary.edit'), true);
  assert.equal(hasPermission(HR_MANAGER, 'employees.delete'), false);   // super-admin only
  assert.equal(hasPermission(HR_MANAGER, 'settings.edit'), false);      // super-admin only
  assert.equal(hasPermission(HR_MANAGER, 'recruitment.edit'), false);   // recruiter-only, not HR
});

test('employee: self-service only, no admin mutations', () => {
  assert.equal(hasPermission(EMPLOYEE, 'attendance.view'), true);
  assert.equal(hasPermission(EMPLOYEE, 'payslip.view'), true);
  assert.equal(hasPermission(EMPLOYEE, 'attendance.edit'), false);
  assert.equal(hasPermission(EMPLOYEE, 'leave.approve'), false);
  assert.equal(hasPermission(EMPLOYEE, 'payroll.view'), false);
  assert.equal(hasPermission(EMPLOYEE, 'salary.edit'), false);
});

test('recruiter (dormant): recruitment + read employees only', () => {
  assert.equal(hasPermission(RECRUITER, 'recruitment.edit'), true);
  assert.equal(hasPermission(RECRUITER, 'employees.view'), true);
  assert.equal(hasPermission(RECRUITER, 'attendance.view'), false);
  assert.equal(hasPermission(RECRUITER, 'payroll.process'), false);
});

test('attendance-request Delete/Cancel: visible ONLY to HR/Admin (canApprove || canReject)', () => {
  const canDelete = (perms) => hasPermission(perms, 'attendance.approve_request') || hasPermission(perms, 'attendance.reject_request');
  assert.equal(canDelete(SUPER_ADMIN), true);
  assert.equal(canDelete(HR_MANAGER), true);
  assert.equal(canDelete(EMPLOYEE), false);    // employee cannot delete from the approval list
  assert.equal(canDelete(RECRUITER), false);
});

test('semantics: exact, module.* wildcard, "*", and missing → false (never throws)', () => {
  assert.equal(hasPermission(['payroll.*'], 'payroll.process'), true);   // module wildcard form
  assert.equal(hasPermission(['payroll.*'], 'salary.edit'), false);
  assert.equal(hasPermission(['leave.approve'], 'leave.approve'), true); // exact
  assert.equal(hasPermission([], 'attendance.view'), false);            // empty
  assert.equal(hasPermission(null, 'attendance.view'), false);          // no list
  assert.equal(hasPermission(EMPLOYEE, ''), false);                     // no perm
  assert.equal(hasPermission(EMPLOYEE, undefined), false);
});
