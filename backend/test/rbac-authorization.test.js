/**
 * RBAC Phase B — backend AUTHORIZATION ENFORCEMENT.
 *
 * Phase A tested the pure resolver. This suite tests the REAL route-guard
 * middleware (requireAnyPermission / requireRole from auth.middleware.js) against
 * the exact permission strings the migrated routes use, proving the migration is
 * behaviour-preserving:
 *   • Employee  → unauthorised mutation → 403
 *   • HR        → authorised operation  → pass (next)
 *   • SuperAdmin→ unrestricted          → pass (next)
 *   • Existing role restrictions (super-admin-only, recruiter dormancy) unchanged
 *
 * Guards do not encode scope; own/team/all scoping stays in the handlers and is
 * unchanged by Phase B, so it is out of scope for these guard-contract tests.
 */
process.env.NODE_ENV = 'test';

const { test } = require('node:test');
const assert = require('node:assert');
const { requireAnyPermission, requireRole } = require('../src/middleware/auth.middleware');

// Drive a guard middleware with a fake req/res/next. Returns { passed, status }.
// passed === true means the guard called next() (access allowed).
function run(mw, role) {
  const req = { user: role ? { role, id: 'u1', name: 'T', email: 't@x.io' } : undefined };
  let status = 200;
  const res = { status(c) { status = c; return this; }, json() { return this; } };
  let passed = false;
  mw(req, res, () => { passed = true; });
  return { passed, status };
}
const allow = (mw, role) => assert.deepEqual(run(mw, role), { passed: true, status: 200 }, `${role} should be ALLOWED`);
const deny = (mw, role) => { const r = run(mw, role); assert.equal(r.passed, false, `${role} should be DENIED`); assert.equal(r.status, 403, `${role} should get 403`); };

// The permission each migrated MUTATION guard checks (real strings from the routes).
const HR_MUTATIONS = [
  'attendance.edit',            // PUT /attendance/:id/edit, /correction→add_punch, /historical, PATCH /:id
  'attendance.add_punch',       // POST /attendance/correction
  'attendance.approve_request', // PATCH /attendance-requests/:id/approve, historical approve
  'attendance.reject_request',  // PATCH /attendance-requests/:id/reject
  'leave.approve', 'leave.reject',   // PATCH /leaves/:id (approve/reject decision)
  'leave.manage_balance',       // /leaves/adjust, /carry-forward, leave-opening/*
  'compoff.approve', 'compoff.reject', 'compoff.edit',
  'compoff.configure',          // /comp-off/scan, /scan-month (HR-only; employee has compoff.create but NOT configure)
  'compoff.manage_balance',     // POST /leaves/compoff (HR grant/consume ledger)
  'payroll.process',            // generate/approve/release/validate/automation
  'payroll.edit',               // lock / lock-month / pt-master writes
  'salary.edit',                // salary-structure POST/PATCH
  'employees.create', 'employees.edit',
  'performance.create', 'performance.delete', 'performance.edit',
  'documents.verify',           // doc verify + pending
];
// recruitment.edit is deliberately NOT here: recruiter holds it (recruitment.*),
// hr_manager does NOT (recruitment.view only) — asserted separately below.

// Guards employees legitimately pass today (self-scoped reads / self-service).
const EMPLOYEE_ALLOWED = [
  requireAnyPermission('attendance.view'),
  requireAnyPermission('employees.view'),
  requireAnyPermission('documents.view'),
  requireAnyPermission('documents.upload'),
  requireAnyPermission('performance.view'),
  requireAnyPermission('payroll.view', 'payslip.view'), // own payslip endpoints
];

// ── Employee: every HR mutation guard denies; self-service guards allow ──
test('employee → HR mutation guards → 403 (no new mutation permissions)', () => {
  for (const p of HR_MUTATIONS) deny(requireAnyPermission(p), 'employee');
});
test('employee → self-service / own-read guards → allowed (unchanged access)', () => {
  for (const mw of EMPLOYEE_ALLOWED) allow(mw, 'employee');
});
test('employee → own-payslip guard allowed via payslip.view; recruiter denied', () => {
  const g = requireAnyPermission('payroll.view', 'payslip.view');
  allow(g, 'employee');      // payslip.view
  allow(g, 'hr_manager');    // payroll.view
  allow(g, 'super_admin');   // *
  deny(g, 'recruiter');      // neither → 403 (matches today)
});

// ── HR (hr_manager): retains full operational access ──
test('hr_manager → all HR operational mutations → allowed', () => {
  for (const p of HR_MUTATIONS) allow(requireAnyPermission(p), 'hr_manager');
});
test('hr_manager → HR reads (settings.view / reports.*) → allowed', () => {
  allow(requireAnyPermission('settings.view'), 'hr_manager'); // payroll-settings GET/history
  allow(requireAnyPermission('reports.view'), 'hr_manager');  // dashboard admin-summary
  allow(requireAnyPermission('reports.export'), 'hr_manager');// import-export
  allow(requireAnyPermission('attendance.export'), 'hr_manager'); // audit/overview/weekly/device
});

// ── Super-admin-only actions: HR blocked, super_admin allowed (unchanged) ──
test('super-admin-only permission guards: hr_manager 403, super_admin allowed', () => {
  for (const p of ['employees.delete', 'settings.edit']) {
    deny(requireAnyPermission(p), 'hr_manager');
    allow(requireAnyPermission(p), 'super_admin');
  }
});
test('retained requireRole(super_admin) guards: hr_manager 403, super_admin allowed', () => {
  // payroll /:id/unlock, salary-structure DELETE, goals DELETE, attendance-requests /setup
  const g = requireRole('super_admin');
  deny(g, 'hr_manager');
  deny(g, 'employee');
  allow(g, 'super_admin');
});

// ── Super Admin: unrestricted across everything migrated ──
test('super_admin → every migrated permission guard → allowed', () => {
  for (const p of [...HR_MUTATIONS, 'employees.delete', 'settings.edit', 'settings.view',
                   'reports.view', 'reports.export', 'payroll.view', 'payroll.export', 'attendance.export']) {
    allow(requireAnyPermission(p), 'super_admin');
  }
});

// ── Recruiter (dormant): unchanged — recruitment yes, HR data no ──
test('recruiter → recruitment guards allowed, HR/attendance/payroll guards denied', () => {
  allow(requireAnyPermission('recruitment.view'), 'recruiter');
  allow(requireAnyPermission('recruitment.edit'), 'recruiter');  // recruitment.*
  deny(requireAnyPermission('recruitment.edit'), 'hr_manager');  // hr_manager has recruitment.view only (unchanged)
  allow(requireAnyPermission('employees.view'), 'recruiter');
  deny(requireAnyPermission('attendance.view'), 'recruiter');
  deny(requireAnyPermission('payroll.view'), 'recruiter');
  deny(requireAnyPermission('leave.approve'), 'recruiter');
});
test('recruitment POST /jobs stays requireRole(HR): hr_manager allowed, recruiter denied', () => {
  const g = requireRole('super_admin', 'hr_manager');
  allow(g, 'hr_manager');
  allow(g, 'super_admin');
  deny(g, 'recruiter');   // role semantics preserved (recruiter cannot create jobs)
  deny(g, 'employee');
});

// ── No token / unknown role → denied (never throws) ──
test('missing user or unknown role → 403', () => {
  deny(requireAnyPermission('attendance.view'), undefined);
  deny(requireAnyPermission('attendance.view'), 'nonsense');
});
