/**
 * Roles & Permissions — READ-ONLY admin API (RBAC Phase E), mounted at /api/roles.
 *
 * The permission model is CODE-DEFINED (backend/src/config/permissions.js) — there is
 * NO database permission table and this endpoint does NOT change the permission source.
 * It simply resolves the existing catalogue + per-role grants for the Admin UI, and
 * counts how many employees currently hold each role. Gated by `roles.view`.
 */
const express = require('express');
const router = express.Router();
const d365 = require('../../services/d365.service');
const { requireAnyPermission } = require('../../middleware/auth.middleware');
const { CATALOGUE, ROLE_PERMISSIONS, permissionsForRole } = require('../../config/permissions');
const { toLabel } = require('../../services/picklist');

const ENTITY = d365.constructor.entities.employee;

// Display order + human labels. Manager is intentionally NOT a role (it is the
// reporting-manager workflow via _hr_manager_value); Recruiter is dormant (kept, not removed).
const ROLE_META = [
  { key: 'employee', label: 'Employee' },
  { key: 'hr_manager', label: 'HR' },
  { key: 'super_admin', label: 'Super Admin' },
  { key: 'recruiter', label: 'Recruiter', dormant: true },
];

// GET /  — the role catalogue, each role's resolved permissions, and live user counts.
router.get('/', requireAnyPermission('roles.view'), async (req, res, next) => {
  try {
    // Live user counts per role (best-effort; empty on read failure).
    const counts = {};
    try {
      const { data } = await d365.getList(ENTITY, { select: 'hr_hremployeeid,hr_role', top: 5000 });
      for (const e of data || []) {
        const r = toLabel('hr_role', e.hr_role);
        if (r) counts[r] = (counts[r] || 0) + 1;
      }
    } catch (_) { /* counts best-effort */ }

    const roles = ROLE_META
      .filter((m) => ROLE_PERMISSIONS[m.key])          // only roles that exist in the catalogue
      .map((m) => {
        const resolved = permissionsForRole(m.key);    // ['*'] for super_admin, else concrete list
        const fullAccess = resolved.length === 1 && resolved[0] === '*';
        return {
          key: m.key,
          label: m.label,
          dormant: !!m.dormant,
          fullAccess,
          permissions: fullAccess ? [] : resolved,      // concrete perms for the matrix (empty when fullAccess)
          userCount: counts[m.key] || 0,
        };
      });

    // `catalogue` (module → actions) drives the matrix rows/columns; the UI must NOT
    // invent permission names — it renders exactly what the code catalogue defines.
    res.json({ catalogue: CATALOGUE, roles, editable: false, source: 'code-defined (permissions.js)' });
  } catch (err) { next(err); }
});

module.exports = router;
