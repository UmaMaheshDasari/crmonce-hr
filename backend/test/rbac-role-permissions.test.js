/**
 * RBAC Phase K — editable role permissions (DB-override overlay on code defaults).
 *
 * Verifies the resolver overlay (override → code default, fail-safe), the override service
 * (validate/normalize, persist via the settings blob, role isolation, preserve other keys,
 * fail-safe load), and the roles.edit guard. No network — d365 + company blob stubbed.
 */
process.env.NODE_ENV = 'test';
process.env.AZURE_CLIENT_ID = process.env.AZURE_CLIENT_ID || 'test-client';
process.env.AZURE_CLIENT_SECRET = process.env.AZURE_CLIENT_SECRET || 'test-secret';
process.env.AZURE_TENANT_ID = process.env.AZURE_TENANT_ID || 'test-tenant';

const { test, afterEach } = require('node:test');
const assert = require('node:assert');
const permissions = require('../src/config/permissions');
const overrides = require('../src/services/permission-overrides.service');
const company = require('../src/services/company.service');
const d365 = require('../src/services/d365.service');
const { requireAnyPermission } = require('../src/middleware/auth.middleware');

// Reset the in-memory override cache to code defaults after each test.
afterEach(() => permissions.setOverrides({}));

function stubBlob(blob, id = 'CS1') {
  const orig = company.getRawSettingsBlob;
  company.getRawSettingsBlob = async () => ({ id, blob: blob || {} });
  return () => { company.getRawSettingsBlob = orig; };
}
function stubUpdate() {
  const origU = d365.update, origInv = company.invalidate;
  const calls = [];
  d365.update = async (entity, id, data) => { calls.push({ entity, id, data }); return {}; };
  company.invalidate = () => {};
  return { calls, restore() { d365.update = origU; company.invalidate = origInv; } };
}
function runGuard(mw, role) {
  const req = { user: role ? { role } : undefined };
  let status = 200, passed = false;
  mw(req, { status(c) { status = c; return this; }, json() { return this; } }, () => { passed = true; });
  return { passed, status };
}

// ── Resolver overlay ──
test('override wins; roles without an override fall back to the code default', () => {
  // default: hr_manager has attendance.* → attendance.delete_punch true
  assert.equal(permissions.hasPermission('hr_manager', 'attendance.delete_punch'), true);
  permissions.setOverrides({ hr_manager: ['attendance.view'] });     // narrow hr_manager
  assert.equal(permissions.hasPermission('hr_manager', 'attendance.delete_punch'), false);
  assert.equal(permissions.hasPermission('hr_manager', 'attendance.view'), true);
  // employee has NO override → still resolves to its code default
  assert.equal(permissions.hasPermission('employee', 'attendance.view'), true);
  assert.equal(permissions.hasPermission('employee', 'attendance.edit'), false);
});

test('permissionsForRole reflects the override; super_admin stays ["*"]', () => {
  permissions.setOverrides({ employee: ['leave.view', 'leave.apply', 'payslip.view'] });
  const emp = permissions.permissionsForRole('employee');
  assert.deepEqual(emp, ['leave.apply', 'leave.view', 'payslip.view']);
  assert.deepEqual(permissions.permissionsForRole('super_admin'), ['*']);
});

test('clearing overrides restores code defaults exactly', () => {
  permissions.setOverrides({ hr_manager: ['attendance.view'] });
  permissions.setOverrides({});
  assert.equal(permissions.hasPermission('hr_manager', 'leave.approve'), true);   // back to default
});

// ── validate / normalize ──
test('validate rejects unknown permission keys and normalizes duplicates', () => {
  const { clean, invalid } = overrides.validate(['attendance.view', 'attendance.view', 'made.up', 'leave.apply', 'nope']);
  assert.deepEqual(invalid, ['made.up', 'nope']);
  assert.deepEqual(clean, ['attendance.view', 'leave.apply']);   // deduped + sorted
});

test('validate accepts * and module.* wildcard forms', () => {
  assert.deepEqual(overrides.validate(['*']).invalid, []);
  assert.deepEqual(overrides.validate(['attendance.*']).invalid, []);
  assert.deepEqual(overrides.validate(['bogus.*']).invalid, ['bogus.*']);
});

// ── load (fail-safe) ──
test('load reads rolePermissions from the blob into the cache (sanitized)', async () => {
  const un = stubBlob({ hr_name: 'ACME', rolePermissions: { hr_manager: ['attendance.view', 'made.up'] } });
  try {
    await overrides.load();
    assert.equal(permissions.hasPermission('hr_manager', 'attendance.view'), true);
    assert.equal(permissions.hasPermission('hr_manager', 'attendance.edit'), false);   // narrowed
    // the invalid 'made.up' was dropped on load (never grants outside the catalogue)
    assert.equal(permissions.hasPermission('hr_manager', 'made.up'), false);
  } finally { un(); }
});

test('load fails safe to code defaults when the store throws', async () => {
  const orig = company.getRawSettingsBlob;
  company.getRawSettingsBlob = async () => { throw new Error('Dataverse down'); };
  try {
    await overrides.load();
    // authorization must NOT break — code defaults apply
    assert.equal(permissions.hasPermission('hr_manager', 'leave.approve'), true);
    assert.equal(permissions.hasPermission('employee', 'leave.approve'), false);
  } finally { company.getRawSettingsBlob = orig; }
});

// ── setRole: persist + role isolation + preserve other keys ──
test('setRole persists to the settings blob, is role-isolated, and preserves other keys', async () => {
  const un = stubBlob({ hr_name: 'ACME', hr_currency: 'INR', rolePermissions: { employee: ['leave.view'] } });
  const up = stubUpdate();
  try {
    const saved = await overrides.setRole('hr_manager', ['attendance.view', 'attendance.view', 'leave.approve']);
    assert.deepEqual(saved, ['attendance.view', 'leave.approve']);   // deduped + sorted
    assert.equal(up.calls.length, 1);
    const written = JSON.parse(up.calls[0].data.hr_settingsjson);
    // company fields preserved
    assert.equal(written.hr_name, 'ACME');
    assert.equal(written.hr_currency, 'INR');
    // role isolation: employee entry untouched, hr_manager updated
    assert.deepEqual(written.rolePermissions.employee, ['leave.view']);
    assert.deepEqual(written.rolePermissions.hr_manager, ['attendance.view', 'leave.approve']);
    // cache refreshed live (no restart)
    assert.equal(permissions.hasPermission('hr_manager', 'attendance.view'), true);
    assert.equal(permissions.hasPermission('hr_manager', 'payroll.process'), false);
  } finally { up.restore(); un(); }
});

test('setRole rejects an unknown role (400) and invalid permissions (400)', async () => {
  const un = stubBlob({ rolePermissions: {} });
  const up = stubUpdate();
  try {
    await assert.rejects(() => overrides.setRole('manager', ['attendance.view']), (e) => e.status === 400);   // no Manager role
    await assert.rejects(() => overrides.setRole('hr_manager', ['made.up']), (e) => e.status === 400 && e.invalid.includes('made.up'));
    assert.equal(up.calls.length, 0);   // nothing persisted on rejection
  } finally { up.restore(); un(); }
});

test('setRole refuses when no settings record exists (409) — never creates a second record', async () => {
  const un = stubBlob({}, null);   // id null
  const up = stubUpdate();
  try {
    await assert.rejects(() => overrides.setRole('employee', ['leave.view']), (e) => e.status === 409);
    assert.equal(up.calls.length, 0);
  } finally { up.restore(); un(); }
});

// ── roles.edit guard (unauthorized cannot edit) ──
test('roles.edit guard: employee + hr_manager denied (403); super_admin allowed', () => {
  const g = requireAnyPermission('roles.edit');
  assert.deepEqual(runGuard(g, 'employee'), { passed: false, status: 403 });
  assert.deepEqual(runGuard(g, 'hr_manager'), { passed: false, status: 403 });
  assert.deepEqual(runGuard(g, 'super_admin'), { passed: true, status: 200 });
  assert.deepEqual(runGuard(g, undefined), { passed: false, status: 403 });
});

// ── Super Admin: safe/collapse helpers ──
test('superAdminSafe: keeps * or every critical admin permission', () => {
  assert.equal(overrides.superAdminSafe(['*']), true);
  assert.equal(overrides.superAdminSafe(['roles.view', 'roles.edit', 'users.view', 'audit.view']), true);
  assert.equal(overrides.superAdminSafe(['roles.view', 'users.view']), false);   // missing roles.edit
  assert.equal(overrides.superAdminSafe(['attendance.view']), false);
});

test('collapseFullAccess: a selection covering everything (or *) collapses to ["*"]', () => {
  const { ALL_PERMISSIONS } = permissions;
  assert.deepEqual(overrides.collapseFullAccess(['*'], ALL_PERMISSIONS), ['*']);
  assert.deepEqual(overrides.collapseFullAccess([...ALL_PERMISSIONS], ALL_PERMISSIONS), ['*']);   // all boxes checked → '*'
  const partial = ALL_PERMISSIONS.slice(0, 5);
  assert.deepEqual(overrides.collapseFullAccess(partial, ALL_PERMISSIONS), partial);              // a real reduction stays concrete
});

// ── Super Admin: LAST vs MULTIPLE decision (Issue 2) ──
test('decideSuperAdmin: LAST admin (count<=1) cannot drop critical perms → reject', () => {
  const { ALL_PERMISSIONS } = permissions;
  const d = overrides.decideSuperAdmin(['attendance.view'], ALL_PERMISSIONS, 1);
  assert.equal(d.reject, true);
  assert.match(d.message, /last Super Admin/i);
});

test('decideSuperAdmin: MULTIPLE admins (count>1) may reduce super_admin → allowed', () => {
  const { ALL_PERMISSIONS } = permissions;
  const d = overrides.decideSuperAdmin(['roles.view', 'roles.edit'], ALL_PERMISSIONS, 3);
  assert.equal(d.reject, false);
  assert.deepEqual(d.store, ['roles.view', 'roles.edit']);   // stored as concrete list
});

test('decideSuperAdmin: full selection collapses to ["*"] and is always safe (even as last)', () => {
  const { ALL_PERMISSIONS } = permissions;
  const d = overrides.decideSuperAdmin([...ALL_PERMISSIONS], ALL_PERMISSIONS, 1);
  assert.equal(d.reject, false);
  assert.deepEqual(d.store, ['*']);
});

test('decideSuperAdmin: unknown count (null) is treated as LAST (protective)', () => {
  const { ALL_PERMISSIONS } = permissions;
  assert.equal(overrides.decideSuperAdmin(['attendance.view'], ALL_PERMISSIONS, null).reject, true);
});

// ── Editing super_admin persists an override; a concrete reduction resolves correctly ──
test('setRole(super_admin) with a concrete reduced set narrows effective access', async () => {
  const un = stubBlob({ rolePermissions: {} });
  const up = stubUpdate();
  try {
    await overrides.setRole('super_admin', ['roles.view', 'roles.edit', 'users.view']);
    assert.equal(permissions.hasPermission('super_admin', 'roles.edit'), true);
    assert.equal(permissions.hasPermission('super_admin', 'payroll.process'), false);   // '*' no longer applies
    assert.deepEqual(permissions.permissionsForRole('super_admin'), ['roles.edit', 'roles.view', 'users.view']);
  } finally { up.restore(); un(); }
});

test('setRole(super_admin) with ["*"] restores full access', async () => {
  const un = stubBlob({ rolePermissions: { super_admin: ['roles.view'] } });
  const up = stubUpdate();
  try {
    await overrides.setRole('super_admin', ['*']);
    assert.equal(permissions.hasPermission('super_admin', 'anything.at_all'), true);
    assert.deepEqual(permissions.permissionsForRole('super_admin'), ['*']);
  } finally { up.restore(); un(); }
});
