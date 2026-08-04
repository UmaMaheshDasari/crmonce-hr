const express = require('express');
const router = express.Router();
const d365 = require('../../services/d365.service');
const { requireRole } = require('../../middleware/auth.middleware');
const company = require('../../services/company.service');
const { ensureCompanyTable } = require('../../services/provision-company');

const ENTITY = company.ENTITY_SET;   // 'hr_companysettings'

// GET /  — company details (any authenticated user; used by payslip header, UI branding)
router.get('/', async (req, res, next) => {
  try {
    res.json(await company.getCompany());
  } catch (err) { next(err); }
});

// PATCH /  — update company details (Super Admin only). Upserts the single row.
router.patch('/', requireRole('super_admin'), async (req, res, next) => {
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

    let saved;
    try {
      if (current.hr_companysettingid) {
        saved = await d365.update(ENTITY, current.hr_companysettingid, patch);
      } else {
        saved = await d365.create(ENTITY, { ...company.COMPANY_DEFAULTS, ...patch });
      }
    } catch (err) {
      // Table not provisioned yet → create it, then retry the upsert once.
      if (/Resource not found for the segment|does not exist|Could not find/i.test(err.message)) {
        await ensureCompanyTable(global.logger || console);
        const again = await company.getCompany();
        company.invalidate();
        saved = again.hr_companysettingid
          ? await d365.update(ENTITY, again.hr_companysettingid, patch)
          : await d365.create(ENTITY, { ...company.COMPANY_DEFAULTS, ...patch });
      } else { throw err; }
    }

    company.invalidate();
    res.json(await company.getCompany());
  } catch (err) {
    console.error('[company/update] FAILED:', err.message);
    return res.status(err.status || 400).json({ error: err.message || 'Failed to update company settings' });
  }
});

module.exports = router;
