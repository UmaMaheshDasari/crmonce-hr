/**
 * THE single employee-profile-photo resolver — used EVERYWHERE a photo is shown so
 * the selection logic is never duplicated per component.
 *
 * Priority (same on the backend, employee.routes resolvePhoto):
 *   1. Personal photo  (employee-chosen)      → hr_personalphotourl / personalPhoto
 *   2. Default photo    (HR/Admin-set)          → hr_photourl
 *   3. Backend-resolved `photo`/`_photo`        → already personal→default from the API
 *   4. ''  → caller shows initials / default avatar (never a broken image)
 *
 * Files live under the API server's /uploads (served statically), so a relative
 * "/uploads/x.jpg" is made absolute against the API ORIGIN (not the /api base).
 * A cache-busting ?v=<modifiedon> is appended so a REPLACED photo is never served
 * from a stale browser cache.
 */
const ORIGIN = (import.meta.env.VITE_API_URL || 'http://localhost:5000/api').replace(/\/api\/?$/, '');

function absolutize(raw) {
  if (!raw) return '';
  if (/^(https?:|data:|blob:)/i.test(raw)) return raw;   // already absolute / inline
  return ORIGIN + (raw.startsWith('/') ? raw : `/${raw}`);
}

/** Raw stored value with correct priority (before absolutize/version). */
function rawPhoto(emp) {
  if (!emp) return '';
  return (
    emp.hr_personalphotourl ||
    emp.personalPhoto ||
    emp.hr_photourl ||
    emp._photo ||
    emp.photo ||
    ''
  );
}

/**
 * @param {object} emp - an employee-like object (raw hr_* record OR an enriched
 *   { photo, modifiedon } card). Missing fields are simply skipped.
 * @returns {string} a ready-to-use <img src> URL, or '' when there is no photo.
 */
export function getEmployeeProfilePhoto(emp) {
  const url = absolutize(rawPhoto(emp));
  if (!url) return '';
  const v = emp?.modifiedon || emp?._photoVersion;
  if (!v) return url;
  return `${url}${url.includes('?') ? '&' : '?'}v=${encodeURIComponent(v)}`;
}

/** True when the employee has any usable photo (personal or default). */
export function hasEmployeePhoto(emp) {
  return !!rawPhoto(emp);
}

/** Initials fallback — two letters, upper-case (or '?'). */
export function employeeInitials(name) {
  return (
    String(name || '')
      .trim()
      .split(/\s+/)
      .map((n) => n[0])
      .join('')
      .slice(0, 2)
      .toUpperCase() || '?'
  );
}
