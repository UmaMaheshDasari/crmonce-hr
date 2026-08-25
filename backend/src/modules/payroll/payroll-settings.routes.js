const express = require('express');
const axios = require('axios');
const router = express.Router();
const d365 = require('../../services/d365.service');
const { requireRole } = require('../../middleware/auth.middleware');
const settings = require('../../services/payroll-settings.service');
const { ensurePayrollSettingsTable } = require('../../services/provision-payroll-settings');

const ENTITY = settings.ENTITY_SET;   // 'hr_payrollsettings'
const LOGICAL = 'hr_payrollsetting';

// GET /_diagnose — PROVE the persistence root cause with live evidence (Super Admin).
// Non-destructive: it writes a sentinel to one field, reads it back, then restores
// the original value. Answers the 7 evidence questions with exact Dataverse output.
router.get('/_diagnose', requireRole('super_admin'), async (req, res) => {
  const ev = {};
  const raw = (e) => e?.response?.data?.error || { message: e?.message };
  let headers;
  try { headers = await d365.getHeaders({ 'Content-Type': 'application/json' }); }
  catch (e) { return res.status(500).json({ error: 'Could not acquire a Dataverse token', detail: raw(e) }); }

  // (1) The actual table.
  ev['1_table'] = { entitySet: ENTITY, entityLogicalName: LOGICAL, baseUrl: d365.baseUrl };

  // (2) Which columns ACTUALLY exist — straight from Dataverse metadata.
  let existing = [];
  try {
    const url = `${d365.baseUrl}/EntityDefinitions(LogicalName='${LOGICAL}')/Attributes?$select=LogicalName`;
    const r = await axios.get(url, { headers });
    existing = (r.data.value || []).map((a) => a.LogicalName);
    ev['2_columns'] = {
      totalColumns: existing.length,
      hr_settingsjson_EXISTS: existing.includes('hr_settingsjson'),
      hr_pfemployeepercent_EXISTS: existing.includes('hr_pfemployeepercent'),
      hr_defaultallowances_EXISTS: existing.includes('hr_defaultallowances'),
      missingExpectedColumns: settings.FIELDS.filter((f) => !existing.includes(f)),
      allSettingsColumnsPresent: existing.filter((c) => c.startsWith('hr_')).sort(),
    };
  } catch (e) { ev['2_columns'] = { error: 'metadata query failed', detail: raw(e) }; }

  // Read the RAW row (no cache, no blob overlay) using only columns that exist.
  const want = ['hr_payrollsettingid', 'hr_name', 'hr_settingsjson', 'hr_pfemployeepercent', 'hr_ptamount', 'hr_defaultallowances'].filter((c) => existing.length === 0 || existing.includes(c));
  async function readRaw() {
    const url = `${d365.baseUrl}/${ENTITY}?$select=${want.join(',')}&$top=1&$orderby=createdon asc`;
    const r = await axios.get(url, { headers });
    return (r.data.value || [])[0] || null;
  }
  let before;
  try { before = await readRaw(); ev['_rowBeforeTest'] = before; }
  catch (e) { ev['_rowBeforeTest'] = { error: 'raw read failed', detail: raw(e) }; }

  const id = before?.hr_payrollsettingid;
  if (!id) { ev['3_4_5_6_writeTest'] = { skipped: 'no settings row exists yet to test against' }; ev['7_diagnosis'] = diagnose(ev); return res.json(ev); }

  // (3)+(4) Attempt a PATCH on the field the user edits, capturing the EXACT result.
  const probeField = 'hr_pfemployeepercent';
  const original = before[probeField];
  const sentinel = original === '13.13' ? '14.14' : '13.13';
  const test = { field: probeField, originalValue: original ?? null, sentinelWritten: sentinel };
  try {
    const r = await axios.patch(`${d365.baseUrl}/${ENTITY}(${id})`, { [probeField]: sentinel }, { headers });
    test.patchStatus = r.status;                       // 204 = success
    test.patchSucceeded = true;
  } catch (e) {
    test.patchStatus = e.response?.status;
    test.patchSucceeded = false;
    test.patchDataverseError = raw(e);                 // the EXACT Dataverse error
  }
  ev['3_4_writeTest'] = test;

  // (5) The record IMMEDIATELY after save (raw DB read).
  try { ev['5_recordAfterSave_rawDB'] = await readRaw(); }
  catch (e) { ev['5_recordAfterSave_rawDB'] = { error: raw(e) }; }

  // (6) What a page refresh actually loads (the app's real GET path: getSettings()).
  settings.invalidate();
  try {
    const s = await settings.getSettings();
    ev['6_recordAfterRefresh_appGET'] = { [probeField]: s[probeField], hr_payrollsettingid: s.hr_payrollsettingid, source: s.hr_settingsjson ? 'blob+columns' : 'columns/defaults' };
  } catch (e) { ev['6_recordAfterRefresh_appGET'] = { error: raw(e) }; }

  // Did the sentinel actually persist?
  const rawAfter = ev['5_recordAfterSave_rawDB'];
  ev['_sentinelPersisted'] = !!rawAfter && String(rawAfter[probeField] ?? '') === sentinel;

  // Restore the original value (best-effort; only if the column exists / write worked).
  if (test.patchSucceeded) {
    try { await axios.patch(`${d365.baseUrl}/${ENTITY}(${id})`, { [probeField]: original ?? '' }, { headers }); ev['_restored'] = true; }
    catch (e) { ev['_restored'] = false; ev['_restoreError'] = raw(e); }
  }
  settings.invalidate();

  ev['7_diagnosis'] = diagnose(ev);
  res.json(ev);
});

function diagnose(ev) {
  const cols = ev['2_columns'] || {};
  if (cols.hr_pfemployeepercent_EXISTS === false) {
    return `ROOT CAUSE = MISSING COLUMNS. The Dataverse table '${ENTITY}' does NOT have the settings columns (e.g. hr_pfemployeepercent). A save silently drops those fields, so after refresh the app shows defaults. Fix: grant the application user the System Customizer role so columns can be created (or rely on the hr_settingsjson blob if it exists). Responsible: provisioning (provision-payroll-settings.js) never created them — likely a permissions/lock issue.`;
  }
  const test = ev['3_4_writeTest'] || {};
  if (test.patchSucceeded === false) {
    return `ROOT CAUSE = WRITE REJECTED. The PATCH to '${ENTITY}' failed — see 3_4_writeTest.patchDataverseError for the exact reason. Responsible: the Dataverse write itself, not the app read path.`;
  }
  if (ev['_sentinelPersisted'] === false) {
    return `ROOT CAUSE = WRITE NOT PERSISTED. PATCH returned success but the value did NOT change in the DB — investigate column type / plugin. Evidence in 5_recordAfterSave_rawDB.`;
  }
  const appGet = ev['6_recordAfterRefresh_appGET'] || {};
  const rawAfter = ev['5_recordAfterSave_rawDB'] || {};
  if (ev['_sentinelPersisted'] === true && String(appGet.hr_pfemployeepercent ?? '') !== String(rawAfter.hr_pfemployeepercent ?? '')) {
    return `ROOT CAUSE = READ PATH. The DB HAS the saved value but the app GET (getSettings) returns a different value — a read/merge bug in payroll-settings.service.js getSettings(). Compare 5_recordAfterSave_rawDB vs 6_recordAfterRefresh_appGET.`;
  }
  return `NO PERSISTENCE FAULT DETECTED: columns exist, PATCH succeeded, the value persisted in the DB, and the app GET returned it. If the UI still shows old values the cause is client-side (form reset / caching) — capture the browser Network tab for GET /api/payroll/settings.`;
}

// GET /  — resolved payroll settings (HR/Admin). Returns BOTH the raw row (for the
// settings form) and the typed `resolved` config (what the engine consumes).
router.get('/', requireRole('super_admin', 'hr_manager'), async (req, res, next) => {
  try {
    const raw = await settings.getSettings();
    res.json({ ...raw, resolved: settings.resolve(raw) });
  } catch (err) { next(err); }
});

// PUT /  — update payroll settings (Super Admin only). Upserts the single row.
router.put('/', requireRole('super_admin'), async (req, res, next) => {
  try {
    // Whitelist known fields only. Validate the JSON columns so a broken paste
    // can never corrupt the engine's config.
    const patch = {};
    for (const f of settings.FIELDS) {
      if (req.body[f] === undefined) continue;
      let v = req.body[f];
      if (settings.JSON_FIELDS.includes(f)) {
        // Accept either a JSON string or an array/object; always store as a string.
        if (typeof v !== 'string') { try { v = JSON.stringify(v); } catch { v = '[]'; } }
        try { JSON.parse(v); } catch { return res.status(400).json({ error: `${f} must be valid JSON.` }); }
      } else {
        v = v === null ? '' : String(v);
      }
      patch[f] = v;
    }

    const current = await settings.getSettings();
    const effectiveName = patch.hr_name !== undefined ? patch.hr_name : current.hr_name;
    if (!String(effectiveName || '').trim()) patch.hr_name = settings.PAYROLL_SETTINGS_DEFAULTS.hr_name;

    // ── Config safety (Phase 20): validate the attendance-rule numbers on the merged view. ──
    const eff = { ...current, ...patch };
    const fdMin = Number(eff.hr_fulldayminhours), hdMin = Number(eff.hr_halfdayminhours);
    const fdExp = Number(eff.hr_fulldayexpectedhours), hdExp = Number(eff.hr_halfdayexpectedhours);
    if (Number.isFinite(fdMin) && Number.isFinite(hdMin) && fdMin <= hdMin) {
      return res.status(400).json({ error: 'Full Day Minimum Hours must be greater than Half Day Minimum Hours.' });
    }
    for (const [name, v] of [['Full Day Minimum', fdMin], ['Half Day Minimum', hdMin], ['Full Day Expected', fdExp], ['Half Day Expected', hdExp]]) {
      if (Number.isFinite(v) && v <= 0) return res.status(400).json({ error: `${name} Hours must be a positive number.` });
    }
    if (patch.hr_attnruleeffectivedate !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(String(patch.hr_attnruleeffectivedate))) {
      return res.status(400).json({ error: 'Attendance Rule Effective Date must be a valid date (YYYY-MM-DD).' });
    }

    // The JSON blob holds the COMPLETE merged config (new patch over the current
    // saved values) — it is the persistence source of truth, so the save survives
    // even if individual scalar columns can't be provisioned.
    const merged = {};
    for (const f of settings.FIELDS) merged[f] = patch[f] !== undefined ? patch[f] : current[f];
    patch.hr_settingsjson = JSON.stringify(merged);

    // Resilient upsert: if the table OR a column isn't provisioned yet, provision
    // once and retry; if a column still can't be created (lock/perms), strip ONLY
    // that column and keep going — the JSON blob still persists the whole config.
    let saved, id = current.hr_payrollsettingid;
    let body = id ? { ...patch } : { ...settings.PAYROLL_SETTINGS_DEFAULTS, ...patch };
    let provisioned = false;
    const stripped = [];
    for (let attempt = 0; attempt < 80; attempt++) {
      try {
        saved = id ? await d365.update(ENTITY, id, body) : await d365.create(ENTITY, body);
        break;
      } catch (err) {
        const tableMissing = /Resource not found for the segment|Could not find the segment/i.test(err.message);
        const propMissing = d365._isMissingProperty(err);
        if ((tableMissing || propMissing) && !provisioned) {
          // Create the table and/or add any missing columns, then retry once.
          await ensurePayrollSettingsTable(global.logger || console);
          provisioned = true;
          settings.invalidate();
          const again = await settings.getSettings();
          id = again.hr_payrollsettingid;
          body = id ? { ...patch } : { ...settings.PAYROLL_SETTINGS_DEFAULTS, ...patch };
          continue;
        }
        if (propMissing) {
          const prop = d365._missingPropertyName(err);
          if (prop && body[prop] !== undefined) { stripped.push(prop); delete body[prop]; continue; }   // strip & retry
        }
        throw err;
      }
    }

    settings.invalidate();
    const raw = await settings.getSettings();

    // Append-only Setting History for every changed field, then refresh the attendance
    // engine's DB-backed policy so new thresholds/effective-date take effect at once.
    // Both best-effort — a history/refresh hiccup must never fail the save.
    try {
      const settingsAudit = require('../../services/settings-audit.service');
      await settingsAudit.recordDiff({
        before: current, after: patch, fields: settings.FIELDS,
        changedBy: req.user?.name || req.user?.email || 'Admin',
        effectiveDate: raw.hr_attnruleeffectivedate, ruleVersion: raw.hr_ruleversion,
        reason: req.body?.reason || '', scope: 'payroll',
      });
    } catch (_) { /* history best-effort */ }
    try {
      await settings.getResolved();                            // re-warm the sync snapshot
      const policy = require('../../services/company.policy');
      policy.setProvider(policy.dbProvider); policy.reload();  // attendance rules update live
    } catch (_) { /* policy refresh best-effort */ }

    // Verify persistence: re-read and confirm an edited field actually round-tripped.
    // If Dataverse could persist NEITHER the JSON blob NOR the scalar columns, the
    // save silently lost data — surface it clearly instead of pretending success.
    const sample = Object.keys(patch).find((f) => f !== 'hr_settingsjson' && f !== 'hr_name');
    const blobPersisted = !stripped.includes('hr_settingsjson');
    if (sample && !blobPersisted && String(raw[sample] ?? '') !== String(patch[sample] ?? '')) {
      global.logger?.error?.(`[payroll-settings] NOT PERSISTED — stripped columns: ${stripped.join(', ')}`);
      return res.status(500).json({
        error: 'Payroll settings could not be saved to Dataverse — the settings columns are not provisioned and could not be created automatically. Verify the application user has the System Customizer role (permission to add columns), then try again.',
        stripped,
      });
    }

    res.json({ ...raw, resolved: settings.resolve(raw), _persisted: true, ...(stripped.length ? { _stripped: stripped } : {}) });
  } catch (err) {
    console.error('[payroll-settings/update] FAILED:', err.message);
    return res.status(err.status || 400).json({ error: err.message || 'Failed to update payroll settings' });
  }
});

// GET /history — append-only Setting History (Super Admin / HR). Read-only; append-only
// (there is no edit/delete). Filters: ?field, ?changedBy, ?from, ?to.
router.get('/history', requireRole('super_admin', 'hr_manager'), async (req, res, next) => {
  try {
    const settingsAudit = require('../../services/settings-audit.service');
    const rows = await settingsAudit.list({ field: req.query.field, changedBy: req.query.changedBy, from: req.query.from, to: req.query.to });
    res.json({ data: rows, count: rows.length });
  } catch (err) { next(err); }
});

module.exports = router;
