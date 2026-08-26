/**
 * Role-Permission Overrides (RBAC Phase K) — makes role permissions editable by Super Admin
 * WITHOUT a new table. Overrides are stored as a `rolePermissions` key inside the SAME
 * hr_settingsjson blob used by Company Settings (company.service), and overlaid on the
 * code-defined defaults in config/permissions.js.
 *
 * Design guarantees:
 *  - The code ROLE_PERMISSIONS stays the DEFAULT/FALLBACK — a role with no override resolves
 *    to its code default. Dataverse failure NEVER breaks authorization (fail-safe).
 *  - Overrides are ALWAYS validated against the catalogue on write — an override can never
 *    grant a permission outside CATALOGUE / ALL_PERMISSIONS.
 *  - Role isolation: writing one role only touches that role's entry in the blob.
 *  - hasPermission stays synchronous (this service pushes overrides into an in-memory cache
 *    via permissions.setOverrides()).
 */
const d365 = require('./d365.service');
const company = require('./company.service');
const permissions = require('../config/permissions');
const { CATALOGUE, ALL_PERMISSIONS } = permissions;

// The existing approved role keys (matches picklist hr_role). No Manager (workflow-only).
const ROLE_KEYS = ['employee', 'hr_manager', 'super_admin', 'recruiter'];
const VALID = new Set(ALL_PERMISSIONS);

/** Is a single permission token valid against the catalogue? ('*', 'module.*', or exact). */
function isValidPerm(p) {
  if (p === '*') return true;
  if (typeof p !== 'string') return false;
  if (VALID.has(p)) return true;
  if (p.endsWith('.*') && CATALOGUE[p.slice(0, -2)]) return true;   // module wildcard
  return false;
}

/** Keep only valid perms, dedupe, sort. (Used defensively when LOADING; writes reject invalids.) */
function sanitize(list) {
  return [...new Set((Array.isArray(list) ? list : []).filter(isValidPerm))].sort();
}

/** Split a proposed list into { clean, invalid } — writes use this to REJECT unknown keys. */
function validate(list) {
  const arr = Array.isArray(list) ? list : [];
  const invalid = arr.filter((p) => !isValidPerm(p));
  const clean = [...new Set(arr.filter(isValidPerm))].sort();
  return { clean, invalid };
}

/**
 * Load overrides from the settings blob into the in-memory cache (permissions.setOverrides).
 * Fail-safe: on ANY error, keep code defaults (setOverrides({})). Returns the loaded map.
 */
async function load() {
  try {
    const { blob } = await company.getRawSettingsBlob();
    const rp = blob && blob.rolePermissions;
    const overrides = {};
    if (rp && typeof rp === 'object') {
      for (const role of ROLE_KEYS) if (Array.isArray(rp[role])) overrides[role] = sanitize(rp[role]);
    }
    permissions.setOverrides(overrides);
    global.logger?.info?.(`[perm-overrides] loaded ${Object.keys(overrides).length} role override(s)`);
    return overrides;
  } catch (e) {
    global.logger?.warn?.(`[perm-overrides] load failed — using code defaults: ${e.message}`);
    permissions.setOverrides({});
    return {};
  }
}

/**
 * Persist ONE role's permission override (read-modify-write on the blob; role-isolated),
 * then refresh the in-memory cache so subsequent requests use it without a restart.
 * Throws on validation / missing-record errors (the route maps these to 4xx).
 * @returns {Promise<string[]>} the clean, persisted permission list.
 */
async function setRole(roleKey, list) {
  if (!ROLE_KEYS.includes(roleKey)) { const e = new Error('Unknown role.'); e.status = 400; throw e; }
  const { clean, invalid } = validate(list);
  if (invalid.length) { const e = new Error(`Invalid permission(s): ${invalid.join(', ')}`); e.status = 400; e.invalid = invalid; throw e; }

  const { id, blob } = await company.getRawSettingsBlob();
  if (!id) { const e = new Error('Company settings record not found — cannot persist role permissions.'); e.status = 409; throw e; }

  // Role isolation: copy the existing map and change ONLY this role's entry.
  const rp = (blob.rolePermissions && typeof blob.rolePermissions === 'object') ? { ...blob.rolePermissions } : {};
  rp[roleKey] = clean;
  const newBlob = { ...blob, rolePermissions: rp };

  await d365.update(company.ENTITY_SET, id, { hr_settingsjson: JSON.stringify(newBlob) });
  company.invalidate();   // company settings cache holds the blob too

  // Refresh only this role in the in-memory cache (leave others as-is).
  const overrides = { ...(permissions.getOverrides() || {}) };
  overrides[roleKey] = clean;
  permissions.setOverrides(overrides);
  return clean;
}

// ── Super Admin editing helpers (RBAC Phase K, Issue 1 & 2) ──
// Critical permissions the super_admin role must retain when it is the LAST Super Admin.
const SUPERADMIN_CRITICAL = ['roles.view', 'roles.edit', 'users.view'];

/** A super_admin grant set is "safe" if it keeps '*' OR every critical admin permission. */
function superAdminSafe(perms) {
  return perms.includes('*') || SUPERADMIN_CRITICAL.every((c) => perms.includes(c));
}

/**
 * Collapse a super_admin selection that covers EVERYTHING back to ['*'] — so editing the
 * Super Admin matrix and leaving all boxes checked preserves the '*' wildcard rather than
 * storing hundreds of concrete permissions. `allPerms` is ALL_PERMISSIONS (the concrete list).
 */
function collapseFullAccess(perms, allPerms) {
  if (perms.includes('*')) return ['*'];
  return (Array.isArray(allPerms) && allPerms.length && allPerms.every((p) => perms.includes(p))) ? ['*'] : perms;
}

/**
 * Decide what to persist for a super_admin edit and whether to reject it.
 * Protection triggers ONLY for the LAST Super Admin (superAdminCount <= 1): an unsafe set is
 * rejected. With multiple Super Admins, editing is allowed (another admin can correct it).
 * Pure — the route supplies the live active-Super-Admin count.
 * @returns {{reject:true,message:string} | {reject:false,store:string[]}}
 */
function decideSuperAdmin(clean, allPerms, superAdminCount) {
  const store = collapseFullAccess(clean, allPerms);
  if (!superAdminSafe(store) && (superAdminCount == null || superAdminCount <= 1)) {
    return { reject: true, message: 'Cannot remove critical permissions from the last Super Admin.' };
  }
  return { reject: false, store };
}

module.exports = {
  load, setRole, validate, sanitize, isValidPerm, ROLE_KEYS,
  SUPERADMIN_CRITICAL, superAdminSafe, collapseFullAccess, decideSuperAdmin,
};
