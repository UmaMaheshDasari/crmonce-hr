/**
 * RBAC — canonical GRANULAR permission catalogue + per-role grants (single source of truth).
 *
 * PHASE A (this file): defines the model + resolver and is exposed via GET /auth/me.
 * It is ADDITIVE — it does NOT change any authorization enforcement yet. The legacy
 * colon-style map in auth.middleware.js still drives the existing `requirePermission`
 * checks unchanged; Phase B will migrate route guards onto this catalogue.
 *
 * Convention: `module.action` (dot). Grants support:
 *   '*'          → all permissions (super_admin)
 *   'module.*'   → every action in that module
 *   'module.act' → that exact permission
 *
 * Scope note: a permission STRING never encodes scope. "Own records only" (employee) and
 * "team only" (future Manager) are enforced by existing route logic (e.g.
 * `req.user.role === 'employee' → targetId = self`), which RBAC does not change.
 *
 * The per-role grants below reflect CURRENT effective access (behaviour-preserving); any
 * per-endpoint nuance is reconciled when guards are migrated in Phase B.
 */

// ── Catalogue: module → actions (drives the Admin "Roles & Permissions" matrix UI) ──
const CATALOGUE = {
  employees:    ['view', 'create', 'edit', 'delete'],
  attendance:   ['view', 'edit', 'add_punch', 'edit_punch', 'delete_punch', 'delete', 'override', 'approve_request', 'reject_request', 'export'],
  leave:        ['view', 'apply', 'edit', 'delete', 'approve', 'reject', 'manage_balance', 'export'],
  compoff:      ['view', 'create', 'edit', 'delete', 'approve', 'reject', 'manage_balance', 'configure'],
  latelogin:    ['apply', 'approve', 'reject'],
  earlylogout:  ['apply', 'approve', 'reject'],
  payroll:      ['view', 'process', 'edit', 'export'],
  salary:       ['view', 'edit'],
  payslip:      ['view', 'print'],
  performance:  ['view', 'create', 'edit', 'delete'],
  recruitment:  ['view', 'create', 'edit', 'delete'],
  documents:    ['view', 'upload', 'verify', 'delete'],
  reports:      ['view', 'export'],
  settings:     ['view', 'edit'],
  users:        ['view', 'create', 'edit', 'delete', 'disable'],
  roles:        ['view', 'create', 'edit', 'delete'],
  permissions:  ['view', 'manage'],
  audit:        ['view', 'export'],
};

/** Flat list of every concrete permission string, e.g. 'attendance.delete_punch'. */
const ALL_PERMISSIONS = Object.entries(CATALOGUE)
  .flatMap(([mod, actions]) => actions.map((a) => `${mod}.${a}`));

// ── Per-role grants (mirrors today's effective access; Manager deferred) ──
const ROLE_PERMISSIONS = {
  // Full, unrestricted access.
  super_admin: ['*'],

  // HR (current `hr_manager`, the single "HR" user). Full HR operational access, matching
  // what hr_manager can already do today. NOT granted: employees.delete, users.*, roles.*,
  // permissions.*, audit.export, settings.edit — those remain super_admin-only (as today;
  // payroll/company settings writes are super_admin-only in the current system).
  hr_manager: [
    'employees.view', 'employees.create', 'employees.edit',
    'attendance.*',
    'leave.*',
    'compoff.*',
    'latelogin.*', 'earlylogout.*',
    'payroll.*',
    'salary.view', 'salary.edit',
    'payslip.view', 'payslip.print',
    'performance.*',
    'recruitment.view',
    'documents.view', 'documents.upload', 'documents.verify', 'documents.delete',
    'reports.view', 'reports.export',
    'settings.view',
    'audit.view',
  ],

  // Dormant role (0 users). Mirrors its current grants: recruitment + read employees.
  recruiter: ['recruitment.*', 'employees.view'],

  // Own HR information only (scope enforced by existing self-scoping route logic).
  employee: [
    'employees.view',
    'attendance.view',
    'leave.view', 'leave.apply',
    'compoff.view', 'compoff.create',
    'latelogin.apply', 'earlylogout.apply',
    'payslip.view', 'payslip.print',
    'performance.view',
    'documents.view', 'documents.upload',
  ],
};

/**
 * Does `roleOrUser` hold `perm`? Supports '*', 'module.*', and exact match.
 * @param {string|{role?:string}} roleOrUser  a role string or a req.user-like object
 * @param {string} perm  a 'module.action' permission
 */
function hasPermission(roleOrUser, perm) {
  const role = typeof roleOrUser === 'string' ? roleOrUser : roleOrUser?.role;
  const grants = ROLE_PERMISSIONS[role] || [];
  if (grants.includes('*')) return true;
  if (grants.includes(perm)) return true;
  const mod = String(perm || '').split('.')[0];
  return grants.includes(`${mod}.*`);
}

/**
 * The concrete permission list for a role, expanding wildcards. Super admin → ['*'].
 * This is what GET /auth/me returns and what the (future) frontend hasPermission uses.
 */
function permissionsForRole(role) {
  const grants = ROLE_PERMISSIONS[role] || [];
  if (grants.includes('*')) return ['*'];
  const out = new Set();
  for (const g of grants) {
    if (g.endsWith('.*')) {
      const mod = g.slice(0, -2);
      (CATALOGUE[mod] || []).forEach((a) => out.add(`${mod}.${a}`));
    } else {
      out.add(g);
    }
  }
  return [...out].sort();
}

module.exports = { CATALOGUE, ALL_PERMISSIONS, ROLE_PERMISSIONS, hasPermission, permissionsForRole };
