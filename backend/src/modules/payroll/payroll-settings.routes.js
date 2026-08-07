const express = require('express');
const router = express.Router();
const d365 = require('../../services/d365.service');
const { requireRole } = require('../../middleware/auth.middleware');
const settings = require('../../services/payroll-settings.service');
const { ensurePayrollSettingsTable } = require('../../services/provision-payroll-settings');

const ENTITY = settings.ENTITY_SET;   // 'hr_payrollsettings'

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

module.exports = router;
