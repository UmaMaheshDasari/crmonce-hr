/**
 * THE single employee-profile-photo resolver — used EVERYWHERE (via <Avatar/>) so
 * the selection + URL logic is never duplicated per component.
 *
 * Priority (same as the backend, employee.routes resolvePhoto):
 *   1. Personal photo (employee-chosen)   → hr_personalphotourl / personalPhoto
 *   2. Default photo  (HR/Admin-set)        → hr_photourl
 *   3. Backend-resolved `photo`/`_photo`     → already personal→default from the API
 *   4. ''  → caller shows initials (never a broken image)
 *
 * URL: uploaded files live on the API server. The SPA is hosted separately and only
 * proxies `/api` to the backend, so a bare "/uploads/x.jpg" is NOT reachable from
 * the browser in production. We therefore serve photos through the API base
 * (`/api/uploads/...`, images-only mount) — reachable in every deployment. A
 * cache-busting `?v=<modifiedon>` is appended so a REPLACED photo is never served
 * stale.
 */
// Same source of truth as the axios client (src/api/client.js): '/api' in prod,
// 'http://localhost:5000/api' in dev. Trailing slash stripped.
const API_BASE = (import.meta.env.VITE_API_URL || 'http://localhost:5000/api').replace(/\/+$/, '');

// A stored value is USABLE only if it is a real, non-sentinel string.
function isUsable(raw) {
  if (raw === null || raw === undefined) return false;
  const s = String(raw).trim();
  if (!s) return false;
  return !['null', 'undefined', 'false', '0', 'nan'].includes(s.toLowerCase());
}

/** Raw stored value with the correct priority (before URL construction). */
function rawPhoto(emp) {
  if (!emp) return '';
  for (const v of [emp.hr_personalphotourl, emp.personalPhoto, emp.hr_photourl, emp._photo, emp.photo]) {
    if (isUsable(v)) return String(v).trim();
  }
  return '';
}

/** Turn a stored value into a browser-reachable, validated <img src>, or ''. */
function toSrc(raw) {
  if (!isUsable(raw)) return '';
  const s = String(raw).trim();
  // Already absolute / inline — trust as-is (an external CDN URL or data/blob).
  if (/^(https?:|data:|blob:)/i.test(s)) return s;
  // Anything else must be an uploaded file → serve it through the API base.
  const rel = s.replace(/^\/api(?=\/uploads\/)/i, '');          // normalise an /api-prefixed path
  const path = rel.startsWith('/uploads/') ? rel
    : `/uploads/${rel.replace(/^\/+/, '')}`;                     // bare filename → /uploads/<file>
  return `${API_BASE}${path}`;
}

/**
 * @param {object} emp - an employee-like object (raw hr_* record OR an enriched
 *   { photo, modifiedon } card). Missing fields are skipped.
 * @returns {string} a ready-to-use, validated <img src> URL, or '' when there is
 *   no usable photo (the caller then shows initials).
 */
export function getEmployeeProfilePhoto(emp) {
  const url = toSrc(rawPhoto(emp));
  if (!url) return '';
  const v = emp?.modifiedon || emp?._photoVersion;
  if (!v) return url;
  return `${url}${url.includes('?') ? '&' : '?'}v=${encodeURIComponent(v)}`;
}

/** True when the employee has any usable photo (personal or default). */
export function hasEmployeePhoto(emp) {
  return !!rawPhoto(emp);
}

/**
 * Initials fallback, generated from the ACTUAL name (never hardcoded), upper-cased:
 *   • 2+ names → first letter of the FIRST + first letter of the LAST name
 *       "Vishwesh Boina" → "VB",  "Uma Mahesh" → "UM",  "Uma Mahesh Kumar" → "UK"
 *   • single name → its first TWO letters   "Vishwesh" → "VI"
 *   • empty / null / whitespace → "?"
 */
export function employeeInitials(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}
