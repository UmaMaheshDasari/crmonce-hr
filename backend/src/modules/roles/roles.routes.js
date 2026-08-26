/**
 * Roles & Permissions — admin API, mounted at /api/roles.
 *
 * The permission CATALOGUE is code-defined (backend/src/config/permissions.js) — the UI can
 * only assign permissions that already exist there. Per-role grants default to the code
 * ROLE_PERMISSIONS and can be OVERRIDDEN by Super Admin (RBAC Phase K), persisted in the
 * existing hr_settingsjson blob (see permission-overrides.service) and overlaid by the
 * resolver. GET is gated by `roles.view`; the permission update by `roles.edit`.
 */
const express = require('express');
const router = express.Router();
const d365 = require('../../services/d365.service');
const { requireAnyPermission } = require('../../middleware/auth.middleware');
const { CATALOGUE, ROLE_PERMISSIONS, ALL_PERMISSIONS, permissionsForRole, hasPermission } = require('../../config/permissions');
const overrides = require('../../services/permission-overrides.service');
const { toLabel, toValue } = require('../../services/picklist');

const ENTITY = d365.constructor.entities.employee;

// Count ACTIVE Super Admin users (drives the "last Super Admin" protection). Best-effort;
// on read failure returns 1 (fail-safe PROTECTIVE — assume it may be the last).
async function countSuperAdmins() {
  try {
    const filter = `hr_role eq ${toValue('hr_role', 'super_admin')} and hr_status eq ${toValue('hr_employee_status', 'active')}`;
    const { data } = await d365.getList(ENTITY, { select: 'hr_hremployeeid', filter, top: 50 });
    return (data || []).length;
  } catch { return 1; }
}

// Display order + human labels. Manager is intentionally NOT a role (it is the
// reporting-manager workflow via _hr_manager_value); Recruiter is dormant (kept, not removed).
const ROLE_META = [
  { key: 'employee', label: 'Employee' },
  { key: 'hr_manager', label: 'HR' },
  { key: 'super_admin', label: 'Super Admin' },
  { key: 'recruiter', label: 'Recruiter', dormant: true },
];

async function userCounts() {
  const counts = {};
  try {
    const { data } = await d365.getList(ENTITY, { select: 'hr_hremployeeid,hr_role', top: 5000 });
    for (const e of data || []) { const r = toLabel('hr_role', e.hr_role); if (r) counts[r] = (counts[r] || 0) + 1; }
  } catch (_) { /* best-effort */ }
  return counts;
}

// GET /  — the role catalogue, each role's EFFECTIVE (override → default) permissions, and
// live user counts. `editable` reflects whether THIS caller may edit (roles.edit).
router.get('/', requireAnyPermission('roles.view'), async (req, res, next) => {
  try {
    const counts = await userCounts();
    const roles = ROLE_META
      .filter((m) => ROLE_PERMISSIONS[m.key])
      .map((m) => {
        const resolved = permissionsForRole(m.key);    // ['*'] for super_admin (default), else concrete list (incl. overrides)
        const fullAccess = resolved.length === 1 && resolved[0] === '*';
        return {
          key: m.key,
          label: m.label,
          dormant: !!m.dormant,
          fullAccess,
          // Expand '*' → the full concrete catalogue so the Super Admin matrix renders all
          // boxes checked AND editable (Issue 1). Concrete overrides pass through as-is.
          permissions: fullAccess ? [...ALL_PERMISSIONS] : resolved,
          userCount: counts[m.key] || 0,
        };
      });
    const canEdit = hasPermission(req.user, 'roles.edit');
    res.json({ catalogue: CATALOGUE, roles, editable: !!canEdit, source: 'code default + Super Admin overrides (hr_settingsjson)' });
  } catch (err) { next(err); }
});

// PUT /:roleKey/permissions  — Super Admin edits a role's permissions (RBAC Phase K).
// Gated by roles.edit. Validates against the catalogue, normalizes duplicates, is
// role-isolated, protects the last Super Admin from lockout, and writes an audit entry.
router.put('/:roleKey/permissions', requireAnyPermission('roles.edit'), async (req, res, next) => {
  try {
    const roleKey = req.params.roleKey;
    if (!overrides.ROLE_KEYS.includes(roleKey)) return res.status(400).json({ error: 'Unknown role.' });
    if (!Array.isArray(req.body?.permissions)) return res.status(400).json({ error: 'A permissions array is required.' });

    // Validate + normalize against the catalogue (reject unknown keys, dedupe).
    const { clean, invalid } = overrides.validate(req.body.permissions);
    if (invalid.length) return res.status(400).json({ error: `Invalid permission(s): ${invalid.join(', ')}`, invalid });

    // Super Admin: collapse a full selection back to '*', and protect ONLY the LAST Super
    // Admin from losing critical admin permissions (Issue 2). Multiple Super Admins → editing
    // is allowed. Any other role stores its concrete list as-is.
    let toStore = clean;
    if (roleKey === 'super_admin') {
      const count = await countSuperAdmins();
      const decision = overrides.decideSuperAdmin(clean, ALL_PERMISSIONS, count);
      if (decision.reject) return res.status(403).json({ error: decision.message });
      toStore = decision.store;
    }

    const before = permissionsForRole(roleKey);           // effective BEFORE
    await overrides.setRole(roleKey, toStore);            // validate + persist (isolated) + refresh cache
    const after = permissionsForRole(roleKey);            // effective AFTER

    // Audit (the middleware logs this mutation; details carries role + before/after diff).
    req._audit = {
      ...(req._audit || {}),
      action: 'roles.permissions_update',
      category: 'roles',
      details: JSON.stringify({
        role: roleKey,
        added: after.filter((p) => !before.includes(p)),
        removed: before.filter((p) => !after.includes(p)),
        before, after,
      }),
    };

    res.json({ role: roleKey, permissions: after, changed: JSON.stringify(before) !== JSON.stringify(after) });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message, ...(err.invalid ? { invalid: err.invalid } : {}) });
    next(err);
  }
});

module.exports = router;
