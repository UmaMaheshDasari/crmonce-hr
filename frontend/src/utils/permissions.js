/**
 * Frontend permission resolver — MIRRORS the backend semantics in
 * backend/src/config/permissions.js (hasPermission). It consumes the already-resolved
 * `permissions` array returned by GET /auth/me (see AuthContext). It does NOT hold a
 * copy of the permission matrix — the matrix lives only on the backend; the frontend
 * only interprets the resolved list for UX (show/hide). Backend Phase B remains the
 * real authorization boundary.
 *
 * Supported grant forms (same as backend):
 *   '*'          → all permissions (super_admin)
 *   'module.*'   → every action in that module
 *   'module.act' → that exact permission
 * A missing permission → false (never throws).
 */
export function hasPermission(permissions, perm) {
  if (!Array.isArray(permissions) || !perm) return false;
  if (permissions.includes('*')) return true;          // super_admin
  if (permissions.includes(perm)) return true;         // exact (the /auth/me list is pre-expanded)
  const mod = String(perm).split('.')[0];              // module wildcard, e.g. 'payroll.*'
  return permissions.includes(`${mod}.*`);
}
