/**
 * Per-employee, per-category email notification preferences.
 *
 * Storage: one row per (employee, category) in hr_emailpreferences (see
 * provision-email-preferences.js). Uniqueness of (employee + category) is enforced here by
 * looking up before insert (upsert), so duplicate rows are never created. The DEFAULT for any
 * category with no row is ENABLED, so a brand-new employee (and the whole system before the
 * table exists) behaves exactly as today.
 *
 * FAIL-OPEN: every read used by the email pipeline returns "enabled" on any error (missing
 * table, Dataverse down, bad data) and logs it — a preference lookup must NEVER block or break
 * email delivery. Writes are only reached from the authorized API, never from the send path.
 */
const d365 = require('./d365.service');
const { CATEGORY_KEYS, isValidCategory, defaultPreferences } = require('./email-categories');
let activity; try { activity = require('./activity.service'); } catch (_) { activity = null; }
const audit = (p) => { try { activity?.record?.(p); } catch (_) {} };

const PREF = d365.constructor.entities.emailPreference;   // 'hr_emailpreferences'
const SELECT = 'hr_emailpreferenceid,hr_employeeid,hr_employeename,hr_category,hr_enabled,hr_changedby,hr_changedbyrole,hr_changedon';
const esc = (s) => String(s == null ? '' : s).replace(/'/g, "''");
const asBool = (v) => String(v) === 'true';
const nowIso = () => new Date().toISOString();

// A Dataverse duplicate-alternate-key / duplicate-insert conflict (concurrent create of the same
// employee+category). 412 Precondition Failed / 409 Conflict, or the duplicate-key message/code.
function isDuplicateKey(err) {
  const status = err?.response?.status || err?.status;
  const msg = err?.response?.data?.error?.message || err?.message || '';
  const code = err?.response?.data?.error?.code || '';
  return status === 412 || status === 409
    || /duplicate|matching key values already exists|Cannot insert duplicate|a record that has the same/i.test(msg)
    || /0x80060892|0x80040237/i.test(String(code));
}

// Small read cache (per employee) so the send pipeline does not hit Dataverse on every email.
const CACHE_TTL_MS = 60 * 1000;
const cache = new Map();   // employeeId → { prefs, at }
function invalidate(employeeId) { cache.delete(String(employeeId)); }

/** Raw rows for an employee (fail-open → [] on error). */
async function readRows(employeeId) {
  const { data } = await d365.getListOptional(PREF, {
    select: SELECT,
    filter: `hr_employeeid eq '${esc(employeeId)}'`,
    top: 100,
  });
  return data || [];
}

/**
 * The full preference map for an employee: { categoryKey: boolean } for EVERY known category,
 * defaulting to enabled where no row exists. Fail-open (all enabled) on any error.
 */
async function getPreferences(employeeId) {
  const prefs = defaultPreferences();
  if (!employeeId) return prefs;
  const cached = cache.get(String(employeeId));
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return { ...cached.prefs };
  try {
    for (const r of await readRows(employeeId)) {
      if (isValidCategory(r.hr_category)) prefs[r.hr_category] = asBool(r.hr_enabled);
    }
    cache.set(String(employeeId), { prefs: { ...prefs }, at: Date.now() });
  } catch (e) {
    global.logger?.warn?.(`[email-prefs] read failed for ${employeeId} (fail-open: all enabled): ${e.message}`);
    return defaultPreferences();
  }
  return prefs;
}

/**
 * Is a category enabled for an employee? FAIL-OPEN → true on any error or unknown category.
 * This is the ONLY function the email pipeline calls.
 */
async function isCategoryEnabled(employeeId, category) {
  if (!employeeId || !isValidCategory(category)) return true;   // uncategorized/unknown → always send
  try {
    const prefs = await getPreferences(employeeId);
    return prefs[category] !== false;   // default enabled
  } catch (e) {
    global.logger?.warn?.(`[email-prefs] isCategoryEnabled failed (fail-open) ${employeeId}/${category}: ${e.message}`);
    return true;
  }
}

/** Find the single existing row for (employee, category), or null. */
async function findRow(employeeId, category) {
  const { data } = await d365.getListOptional(PREF, {
    select: SELECT,
    filter: `hr_employeeid eq '${esc(employeeId)}' and hr_category eq '${esc(category)}'`,
    top: 1,
  });
  return (data && data[0]) || null;
}

/**
 * Upsert ONE (employee, category) preference — enforces uniqueness (update if a row exists,
 * else create), records who/when/role, writes an audit entry, and invalidates the cache.
 * Throws on a hard write failure (surfaced by the API as 500); the SEND path never calls this.
 */
async function setPreference(employeeId, category, enabled, actor = {}, employeeName = '') {
  if (!employeeId) { const e = new Error('employeeId required'); e.status = 400; throw e; }
  if (!isValidCategory(category)) { const e = new Error(`Unknown category: ${category}`); e.status = 400; throw e; }
  const val = enabled ? 'true' : 'false';
  const existing = await findRow(employeeId, category);
  const patch = {
    hr_enabled: val,
    hr_changedby: actor?.name || '',
    hr_changedbyrole: actor?.role || '',
    hr_changedon: nowIso(),
  };
  if (existing) {
    await d365.update(PREF, existing.hr_emailpreferenceid, patch);   // update in place (no duplicate row)
  } else {
    try {
      await d365.create(PREF, {
        hr_name: `${employeeId}:${category}`.slice(0, 250),
        hr_employeeid: String(employeeId),
        hr_employeename: employeeName || '',
        hr_category: category,
        ...patch,
      });
    } catch (err) {
      // A concurrent create won the race (the alternate key / a prior insert rejects the duplicate):
      // re-read the now-existing row and UPDATE it, so (employee, category) stays unique atomically.
      if (isDuplicateKey(err)) {
        const again = await findRow(employeeId, category);
        if (again) await d365.update(PREF, again.hr_emailpreferenceid, patch);
        else throw err;
      } else throw err;
    }
  }
  invalidate(employeeId);
  audit({
    category: 'Settings', type: 'email_pref_changed',
    title: `Email preference ${enabled ? 'enabled' : 'disabled'}: ${category}`,
    name: employeeName || employeeId,
    meta: { employeeId, category, enabled, by: actor?.name, byId: actor?.id, byRole: actor?.role },
  });
  return { employeeId, category, enabled };
}

/** Upsert several categories at once for an employee. Returns the resulting preference map. */
async function setPreferences(employeeId, changes = {}, actor = {}, employeeName = '') {
  for (const [category, enabled] of Object.entries(changes)) {
    if (isValidCategory(category)) await setPreference(employeeId, category, !!enabled, actor, employeeName);
  }
  invalidate(employeeId);
  return getPreferences(employeeId);
}

/** Reset an employee to the default (ALL categories enabled). Audited. */
async function resetToDefaults(employeeId, actor = {}, employeeName = '') {
  const changes = Object.fromEntries(CATEGORY_KEYS.map((k) => [k, true]));
  await setPreferences(employeeId, changes, actor, employeeName);
  audit({
    category: 'Settings', type: 'email_pref_reset',
    title: 'Email preferences reset to defaults (all enabled)',
    name: employeeName || employeeId,
    meta: { employeeId, by: actor?.name, byId: actor?.id, byRole: actor?.role },
  });
  return getPreferences(employeeId);
}

module.exports = {
  getPreferences, isCategoryEnabled, setPreference, setPreferences, resetToDefaults,
  _invalidate: invalidate, _clearCache: () => cache.clear(),
};
