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
const { CATEGORY_KEYS, isValidCategory, defaultPreferences, defaultPreferencesFor, defaultEnabledFor } = require('./email-categories');
const { toLabel } = require('./picklist');
let activity; try { activity = require('./activity.service'); } catch (_) { activity = null; }
const audit = (p) => { try { activity?.record?.(p); } catch (_) {} };

const PREF = d365.constructor.entities.emailPreference;   // 'hr_emailpreferences'
const EMP = d365.constructor.entities.employee;
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

// A Dataverse SCHEMA error: the table or a column is not provisioned yet (e.g. the table shell
// exists but hr_employeeid is missing → 0x80060888 "Could not find a property named ..."). This is
// NOT an ordinary "no preference row" — it means storage is not ready. Reads fail OPEN (all
// enabled); writes surface a clear, retryable error instead of a raw 400.
function isSchemaError(err) {
  const msg = err?.response?.data?.error?.message || err?.message || '';
  const code = String(err?.response?.data?.error?.code || '');
  return /Could not find a property named|does not exist|Resource not found|was not found|The entity with a name/i.test(msg)
    || /0x80060888|0x80060893|0x8006088a/i.test(code);
}
// Safe log line (record id only; no employee PII beyond the GUID already in logs elsewhere).
function logDataverse(where, err) {
  const msg = err?.response?.data?.error?.message || err?.message || '';
  const code = err?.response?.data?.error?.code || '';
  global.logger?.warn?.(`[email-prefs] ${where}: Dataverse ${err?.response?.status || ''} ${code} ${msg}`.trim());
}

// Small read cache (per employee) so the send pipeline does not hit Dataverse on every email.
const CACHE_TTL_MS = 60 * 1000;
const cache = new Map();   // employeeId → { prefs, at }
const roleCache = new Map();   // employeeId → { role, at }
function invalidate(employeeId) { cache.delete(String(employeeId)); roleCache.delete(String(employeeId)); }

// The only roles this HRMS recognizes (hr_role picklist). Anything else is treated as unresolved.
const KNOWN_ROLES = new Set(['employee', 'hr_manager', 'recruiter', 'super_admin']);

/**
 * Resolve an employee's VERIFIED role from the employee record (trusted server-side data — never a
 * client-supplied role). Cached.
 *
 * SAFE BEHAVIOUR when the role cannot be reliably resolved (lookup error, missing hr_role, or an
 * unknown/unmapped value): we LOG it (never silent) and FAIL OPEN to 'employee'. Failing open means
 * routine reminders DEFAULT ON (delivered) for that recipient — it never wrongly SUPPRESSES mail,
 * and operational emails are unaffected regardless (they carry no employeeId). The only consequence
 * of an unresolved role is that the §2C admin routine-reminder exclusion is NOT applied to that
 * recipient until their role resolves; a genuine admin would then receive a routine reminder rather
 * than lose any email. The warning log surfaces the misconfiguration (e.g. a blank hr_role).
 */
async function resolveRole(employeeId) {
  if (!employeeId) return 'employee';
  const c = roleCache.get(String(employeeId));
  if (c && Date.now() - c.at < CACHE_TTL_MS) return c.role;
  try {
    const e = await d365.getByIdOptional(EMP, employeeId, { select: 'hr_role' });
    if (!e || e.hr_role == null || e.hr_role === '') {
      global.logger?.warn?.(`[email-prefs] hr_role MISSING for ${employeeId} — admin exclusion not applied; failing open to 'employee'`);
      roleCache.set(String(employeeId), { role: 'employee', at: Date.now() });
      return 'employee';
    }
    const label = toLabel('hr_role', e.hr_role);
    if (typeof label === 'string' && KNOWN_ROLES.has(label)) {
      roleCache.set(String(employeeId), { role: label, at: Date.now() });
      return label;
    }
    global.logger?.warn?.(`[email-prefs] UNKNOWN hr_role value (${JSON.stringify(e.hr_role)}) for ${employeeId} — admin exclusion not applied; failing open to 'employee'`);
    roleCache.set(String(employeeId), { role: 'employee', at: Date.now() });
    return 'employee';
  } catch (e) {
    // Do NOT cache a transient failure (so it is retried), and do NOT silently classify as employee.
    global.logger?.warn?.(`[email-prefs] role lookup FAILED for ${employeeId} — admin exclusion not applied; failing open to 'employee': ${e.message}`);
    return 'employee';
  }
}

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
 * The full preference map for an employee: { categoryKey: boolean } for EVERY known category.
 * Base defaults are ROLE-AWARE (admins' routine-personal categories default OFF, §2C); explicit
 * preference rows (incl. an admin's "personal exception" ON) override the defaults. Fail-open
 * (all enabled) on any error. `opts.role` may be supplied by a caller that already has it.
 */
async function getPreferences(employeeId, opts = {}) {
  if (!employeeId) return defaultPreferences();
  const cached = cache.get(String(employeeId));
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return { ...cached.prefs };
  try {
    const role = opts.role || await resolveRole(employeeId);
    const prefs = defaultPreferencesFor(role);   // role-aware defaults (admin routine → OFF)
    for (const r of await readRows(employeeId)) {
      if (isValidCategory(r.hr_category)) prefs[r.hr_category] = asBool(r.hr_enabled);
    }
    cache.set(String(employeeId), { prefs: { ...prefs }, at: Date.now() });
    return prefs;
  } catch (e) {
    // Distinguish a storage-not-provisioned SCHEMA error from an ordinary read failure, but
    // fail OPEN (all enabled) in both cases so email delivery is never blocked.
    if (isSchemaError(e)) logDataverse(`storage not provisioned for ${employeeId} — failing open (all enabled)`, e);
    else logDataverse(`read failed for ${employeeId} — failing open (all enabled)`, e);
    return defaultPreferences();
  }
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
  const patch = {
    hr_enabled: val,
    hr_changedby: actor?.name || '',
    hr_changedbyrole: actor?.role || '',
    hr_changedon: nowIso(),
  };
  try {
    const existing = await findRow(employeeId, category);
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
  } catch (err) {
    // Storage not provisioned (table/columns missing) → a clear, RETRYABLE error, not a raw 400,
    // and never a silent no-op. Auto-provisioning backfills the schema; a retry then succeeds.
    if (isSchemaError(err)) {
      logDataverse(`write failed — storage not provisioned (${employeeId}/${category})`, err);
      const e = new Error('Email preferences storage is not fully provisioned yet. Please try again shortly.');
      e.status = 503; throw e;
    }
    throw err;
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

/**
 * Reset an employee to their ROLE DEFAULTS. A normal employee → all categories enabled (§2B); an
 * HR Manager / Super Admin → routine-personal categories OFF, the rest ON (§2C). Audited.
 */
async function resetToDefaults(employeeId, actor = {}, employeeName = '') {
  const role = await resolveRole(employeeId);
  const changes = Object.fromEntries(CATEGORY_KEYS.map((k) => [k, defaultEnabledFor(k, role)]));
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
  resolveRole,
  _invalidate: invalidate, _clearCache: () => { cache.clear(); roleCache.clear(); },
};
