// ── TAX DECLARATIONS ─────────────────────────────────────────────
const express = require('express');
const router = express.Router();
const d365 = require('../../services/d365.service');
const { requireRole } = require('../../middleware/auth.middleware');
const { toValue, labelsForList, labelsForEntity } = require('../../services/picklist');

const ENTITY = 'hr_hrtaxdeclarations';
const SELECT_FIELDS = [
  'hr_hrtaxdeclarationid', 'hr_hrtaxdeclaration1', 'hr_financialyear',
  'hr_regime', 'hr_status',
  'hr_section80c', 'hr_section80d', 'hr_section80g',
  'hr_hra', 'hr_lta', 'hr_section24b', 'hr_section80e', 'hr_section80tta',
  'hr_nps', 'hr_othersection', 'hr_otheramount', 'hr_totaldeductions',
  'hr_remarks', '_hr_hremployee_value',
].join(',');

const isHR = (user) => ['super_admin', 'hr_manager'].includes(user?.role);

// ── GET / — list declarations ────────────────────────────────────
router.get('/', async (req, res, next) => {
  try {
    const { year, status, employeeId, page = 1, limit = 20 } = req.query;
    const filters = [];

    // Employees can only see their own
    if (!isHR(req.user)) {
      filters.push(`_hr_hremployee_value eq '${req.user.id}'`);
    } else if (employeeId) {
      filters.push(`_hr_hremployee_value eq '${employeeId}'`);
    }

    if (year) filters.push(`hr_financialyear eq '${year}'`);
    if (status) filters.push(`hr_status eq ${toValue('hr_declaration_status', status)}`);

    const result = await d365.getList(ENTITY, {
      select: SELECT_FIELDS,
      filter: filters.join(' and ') || undefined,
      orderby: 'createdon desc',
      top: limit,
      skip: (page - 1) * limit,
    });

    res.json(labelsForList(ENTITY, result));
  } catch (err) { next(err); }
});

// ── GET /:id — get single declaration ────────────────────────────
router.get('/:id', async (req, res, next) => {
  try {
    const record = await d365.getById(ENTITY, req.params.id, { select: SELECT_FIELDS });

    // Employees can only view their own
    if (!isHR(req.user) && record._hr_hremployee_value !== req.user.id) {
      return res.status(403).json({ error: 'Access denied' });
    }

    res.json(labelsForEntity(ENTITY, record));
  } catch (err) { next(err); }
});

// ── POST / — create declaration ──────────────────────────────────
router.post('/', async (req, res, next) => {
  try {
    const {
      hr_financialyear, hr_regime, hr_status,
      hr_section80c, hr_section80d, hr_section80g,
      hr_hra, hr_lta, hr_section24b, hr_section80e, hr_section80tta,
      hr_nps, hr_othersection, hr_otheramount, hr_remarks,
    } = req.body;

    // Calculate total deductions
    const hr_totaldeductions = (hr_section80c || 0) + (hr_section80d || 0) + (hr_section80g || 0)
      + (hr_hra || 0) + (hr_lta || 0) + (hr_section24b || 0) + (hr_section80e || 0)
      + (hr_section80tta || 0) + (hr_nps || 0) + (hr_otheramount || 0);

    const data = {
      'hr_hremployee@odata.bind': `/hr_hremployees(${req.user.id})`,
      hr_hrtaxdeclaration1: `FY ${hr_financialyear}`,
      hr_financialyear,
      hr_regime: toValue('hr_tax_regime', hr_regime || 'old'),
      hr_status: toValue('hr_declaration_status', hr_status || 'draft'),
      hr_section80c: hr_section80c || 0,
      hr_section80d: hr_section80d || 0,
      hr_section80g: hr_section80g || 0,
      hr_hra: hr_hra || 0,
      hr_lta: hr_lta || 0,
      hr_section24b: hr_section24b || 0,
      hr_section80e: hr_section80e || 0,
      hr_section80tta: hr_section80tta || 0,
      hr_nps: hr_nps || 0,
      hr_othersection: hr_othersection || '',
      hr_otheramount: hr_otheramount || 0,
      hr_totaldeductions,
      hr_remarks: hr_remarks || '',
    };

    const created = await d365.create(ENTITY, data);
    res.status(201).json(labelsForEntity(ENTITY, created));
  } catch (err) { next(err); }
});

// ── PATCH /:id — update declaration ──────────────────────────────
router.patch('/:id', async (req, res, next) => {
  try {
    const existing = await d365.getById(ENTITY, req.params.id, { select: SELECT_FIELDS });

    // Employees can only edit their own drafts
    if (!isHR(req.user)) {
      if (existing._hr_hremployee_value !== req.user.id) {
        return res.status(403).json({ error: 'Access denied' });
      }
      if (existing.hr_status !== toValue('hr_declaration_status', 'draft')) {
        return res.status(400).json({ error: 'Only draft declarations can be edited' });
      }
    }

    const updates = { ...req.body };

    // Convert picklist values
    if (updates.hr_regime !== undefined) {
      updates.hr_regime = toValue('hr_tax_regime', updates.hr_regime);
    }
    if (updates.hr_status !== undefined) {
      updates.hr_status = toValue('hr_declaration_status', updates.hr_status);
    }

    // Recalculate total if any deduction field is being updated
    const deductionFields = ['hr_section80c','hr_section80d','hr_section80g','hr_hra','hr_lta',
      'hr_section24b','hr_section80e','hr_section80tta','hr_nps','hr_otheramount'];
    const hasDeductionUpdate = deductionFields.some(f => updates[f] !== undefined);
    if (hasDeductionUpdate) {
      const merged = { ...existing, ...updates };
      updates.hr_totaldeductions = deductionFields.reduce((sum, f) => sum + (merged[f] || 0), 0);
    }

    const updated = await d365.update(ENTITY, req.params.id, updates);
    res.json(labelsForEntity(ENTITY, updated));
  } catch (err) { next(err); }
});

// ── DELETE /:id — delete draft declaration ───────────────────────
router.delete('/:id', async (req, res, next) => {
  try {
    const existing = await d365.getById(ENTITY, req.params.id, { select: 'hr_hrtaxdeclarationid,hr_status,_hr_hremployee_value' });

    // Only owner or HR can delete, and only drafts
    if (!isHR(req.user) && existing._hr_hremployee_value !== req.user.id) {
      return res.status(403).json({ error: 'Access denied' });
    }
    if (existing.hr_status !== toValue('hr_declaration_status', 'draft')) {
      return res.status(400).json({ error: 'Only draft declarations can be deleted' });
    }

    await d365.delete(ENTITY, req.params.id);
    res.json({ deleted: true });
  } catch (err) { next(err); }
});

module.exports = router;
