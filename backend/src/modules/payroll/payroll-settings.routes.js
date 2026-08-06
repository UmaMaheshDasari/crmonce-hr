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

    let saved;
    try {
      if (current.hr_payrollsettingid) {
        saved = await d365.update(ENTITY, current.hr_payrollsettingid, patch);
      } else {
        saved = await d365.create(ENTITY, { ...settings.PAYROLL_SETTINGS_DEFAULTS, ...patch });
      }
    } catch (err) {
      // Table not provisioned yet → create it, then retry the upsert once.
      if (/Resource not found for the segment|does not exist|Could not find/i.test(err.message)) {
        await ensurePayrollSettingsTable(global.logger || console);
        settings.invalidate();
        const again = await settings.getSettings();
        saved = again.hr_payrollsettingid
          ? await d365.update(ENTITY, again.hr_payrollsettingid, patch)
          : await d365.create(ENTITY, { ...settings.PAYROLL_SETTINGS_DEFAULTS, ...patch });
      } else { throw err; }
    }

    settings.invalidate();
    const raw = await settings.getSettings();
    res.json({ ...raw, resolved: settings.resolve(raw) });
  } catch (err) {
    console.error('[payroll-settings/update] FAILED:', err.message);
    return res.status(err.status || 400).json({ error: err.message || 'Failed to update payroll settings' });
  }
});

module.exports = router;
