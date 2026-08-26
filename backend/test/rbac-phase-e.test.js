/**
 * RBAC Phase E — Administration API authorization + audit target filter.
 *
 * Verifies the NEW admin endpoints' permission guards resolve correctly (super_admin only
 * for roles.view / roles.edit / audit.export; audit.view = super_admin + HR; employees
 * denied everywhere), and that the audit service passes the new targetId ("Employee")
 * filter into the OData query. No network — d365 stubbed.
 */
process.env.NODE_ENV = 'test';
process.env.AZURE_CLIENT_ID = process.env.AZURE_CLIENT_ID || 'test-client';
process.env.AZURE_CLIENT_SECRET = process.env.AZURE_CLIENT_SECRET || 'test-secret';
process.env.AZURE_TENANT_ID = process.env.AZURE_TENANT_ID || 'test-tenant';

const { test } = require('node:test');
const assert = require('node:assert');
const { requireAnyPermission } = require('../src/middleware/auth.middleware');
const auditLog = require('../src/services/audit-log.service');
const d365 = require('../src/services/d365.service');

function run(mw, role) {
  const req = { user: role ? { role } : undefined };
  let status = 200; let passed = false;
  mw(req, { status(c) { status = c; return this; }, json() { return this; } }, () => { passed = true; });
  return { passed, status };
}
const allow = (p, role) => assert.deepEqual(run(requireAnyPermission(p), role), { passed: true, status: 200 }, `${role} allowed ${p}`);
const deny = (p, role) => { const r = run(requireAnyPermission(p), role); assert.equal(r.passed, false, `${role} denied ${p}`); assert.equal(r.status, 403); };

// ── Admin endpoint guards ──
test('roles.view / roles.edit / audit.export are super-admin-only', () => {
  for (const p of ['roles.view', 'roles.edit', 'audit.export']) {
    allow(p, 'super_admin');
    deny(p, 'hr_manager');
    deny(p, 'employee');
    deny(p, 'recruiter');
  }
});

test('audit.view is allowed for HR + super_admin, denied for employee', () => {
  allow('audit.view', 'super_admin');
  allow('audit.view', 'hr_manager');
  deny('audit.view', 'employee');
});

test('users.view (Users admin page) is super-admin-only', () => {
  allow('users.view', 'super_admin');
  deny('users.view', 'hr_manager');
  deny('users.view', 'employee');
});

test('missing/unknown role → denied on admin perms', () => {
  deny('roles.view', undefined);
  deny('audit.export', 'nonsense');
});

// ── Audit service passes the targetId ("Employee") filter into the query ──
test('audit-log.list includes hr_targetid filter when targetId is given', async () => {
  const orig = d365.getList;
  let captured = null;
  d365.getList = async (_e, opts) => { captured = opts; return { data: [] }; };
  try {
    await auditLog.list({ targetId: 'EMP-123', category: 'roles' });
    assert.ok(captured && typeof captured.filter === 'string', 'a filter was built');
    assert.ok(captured.filter.includes("hr_targetid eq 'EMP-123'"), 'targetId → hr_targetid filter');
    assert.ok(captured.filter.includes("hr_category eq 'roles'"), 'category still applied');
  } finally { d365.getList = orig; }
});

test('audit-log.list without targetId does not add a target filter', async () => {
  const orig = d365.getList;
  let captured = null;
  d365.getList = async (_e, opts) => { captured = opts; return { data: [] }; };
  try {
    await auditLog.list({ actorRole: 'super_admin' });
    assert.ok(!String(captured.filter || '').includes('hr_targetid'), 'no target filter when omitted');
  } finally { d365.getList = orig; }
});
