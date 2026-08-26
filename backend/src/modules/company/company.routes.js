const express = require('express');
const router = express.Router();
const d365 = require('../../services/d365.service');
const { requireRole, requireAnyPermission } = require('../../middleware/auth.middleware');
const company = require('../../services/company.service');
const companyConfig = require('../../services/company-config.service');
const { ensureCompanyTable } = require('../../services/provision-company');

const ENTITY = company.ENTITY_SET;   // 'hr_companysettings'

// GET /  — company details (any authenticated user; used by payslip header, UI branding)
router.get('/', async (req, res, next) => {
  try {
    res.json(await company.getCompany());
  } catch (err) { next(err); }
});

// GET /config — the ONE aggregated, typed configuration (company + policy) that the
// whole app can read from a single place (spec §21).
router.get('/config', async (req, res, next) => {
  try { res.json(await companyConfig.getConfig()); }
  catch (err) { next(err); }
});

// PATCH /  — update company details (Super Admin only). Upserts the single row.
router.patch('/', requireAnyPermission('settings.edit'), async (req, res, next) => {
  try {
    // Whitelist only known company fields; ignore anything else.
    const patch = {};
    for (const f of company.FIELDS) {
      if (req.body[f] !== undefined) patch[f] = req.body[f] === null ? '' : String(req.body[f]);
    }
    const current = await company.getCompany();
    const effectiveName = patch.hr_name !== undefined ? patch.hr_name : current.hr_name;
    if (!String(effectiveName || '').trim()) {
      return res.status(400).json({ error: 'Company name is required.' });
    }

    // The JSON blob holds the COMPLETE merged config (new patch over current) — the
    // persistence fallback, so a save survives even if a scalar column isn't
    // provisioned. (Same proven approach as payroll-settings.)
    const merged = {};
    for (const f of company.FIELDS) merged[f] = patch[f] !== undefined ? patch[f] : current[f];
    patch.hr_settingsjson = JSON.stringify(merged);

    // Resilient upsert: provision on a missing table/column, then strip ONLY the
    // column that still can't be created (the blob still persists everything).
    let saved, id = current.hr_companysettingid;
    let body = id ? { ...patch } : { ...company.COMPANY_DEFAULTS, ...patch };
    let provisioned = false;
    for (let attempt = 0; attempt < 80; attempt++) {
      try {
        saved = id ? await d365.update(ENTITY, id, body) : await d365.create(ENTITY, body);
        break;
      } catch (err) {
        const tableMissing = /Resource not found for the segment|Could not find the segment/i.test(err.message);
        const propMissing = d365._isMissingProperty(err);
        if ((tableMissing || propMissing) && !provisioned) {
          await ensureCompanyTable(global.logger || console);
          provisioned = true;
          company.invalidate();
          const again = await company.getCompany();
          id = again.hr_companysettingid;
          body = id ? { ...patch } : { ...company.COMPANY_DEFAULTS, ...patch };
          continue;
        }
        if (propMissing) { const prop = d365._missingPropertyName(err); if (prop && body[prop] !== undefined) { delete body[prop]; continue; } }
        throw err;
      }
    }

    companyConfig.invalidateAll();   // §22 — reload ALL settings caches after a save
    res.json(await company.getCompany());
  } catch (err) {
    console.error('[company/update] FAILED:', err.message);
    return res.status(err.status || 400).json({ error: err.message || 'Failed to update company settings' });
  }
});

module.exports = router;
