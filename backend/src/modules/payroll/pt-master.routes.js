const express = require('express');
const router = express.Router();
const d365 = require('../../services/d365.service');
const { requireRole } = require('../../middleware/auth.middleware');
const pt = require('../../services/pt-master.service');
const { ensurePtSlabTable } = require('../../services/provision-pt-slabs');

const tableMissing = (err) =>
  /Resource not found for the segment|does not exist|Could not find|was not found|404/i.test(err?.message || '');

function validate(input) {
  const errors = [];
  if (!String(input.state || '').trim()) errors.push('State is required.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(input.effectiveFrom || ''))) errors.push('Effective From must be a valid date.');
  if (input.effectiveTo && !/^\d{4}-\d{2}-\d{2}$/.test(String(input.effectiveTo))) errors.push('Effective To must be a valid date (or blank).');
  const from = Number(input.salaryFrom), to = Number(input.salaryTo), amt = Number(input.amount);
  if (!Number.isFinite(from) || from < 0) errors.push('Salary From must be 0 or more.');
  if (!Number.isFinite(to) || to < 0) errors.push('Salary To must be 0 (no upper bound) or more.');
  if (to > 0 && to < from) errors.push('Salary To must be greater than Salary From (or 0 for no upper bound).');
  if (!Number.isFinite(amt) || amt < 0) errors.push('Professional Tax must be 0 or more.');
  return errors;
}

// GET /  — all slabs (HR/Admin).
router.get('/', requireRole('super_admin', 'hr_manager'), async (req, res, next) => {
  try { res.json({ data: await pt.listSlabs() }); }
  catch (err) { if (tableMissing(err)) { await ensurePtSlabTable(global.logger || console).catch(() => {}); return res.json({ data: [] }); } next(err); }
});

// POST /  — add a slab.
router.post('/', requireRole('super_admin', 'hr_manager'), async (req, res, next) => {
  try {
    const errors = validate(req.body);
    if (errors.length) return res.status(400).json({ error: errors[0], errors });
    const body = pt.toDataverse(req.body);
    let created;
    try { created = await d365.create(pt.ENTITY, body); }
    catch (err) { if (tableMissing(err)) { await ensurePtSlabTable(global.logger || console); created = await d365.create(pt.ENTITY, body); } else throw err; }
    pt.invalidate();
    res.status(201).json(pt.shape(created));
  } catch (err) { res.status(err.status || 400).json({ error: err.message || 'Failed to add slab' }); }
});

// PATCH /:id  — edit a slab.
router.patch('/:id', requireRole('super_admin', 'hr_manager'), async (req, res, next) => {
  try {
    const errors = validate(req.body);
    if (errors.length) return res.status(400).json({ error: errors[0], errors });
    await d365.update(pt.ENTITY, req.params.id, pt.toDataverse(req.body));
    pt.invalidate();
    res.json(pt.shape(await d365.getById(pt.ENTITY, req.params.id, { select: pt.SELECT })));
  } catch (err) { res.status(err.status || 400).json({ error: err.message || 'Failed to update slab' }); }
});

// PATCH /:id/status  — activate / deactivate (never delete — history matters).
router.patch('/:id/status', requireRole('super_admin', 'hr_manager'), async (req, res, next) => {
  try {
    const status = req.body.status === 'inactive' ? 'inactive' : 'active';
    await d365.update(pt.ENTITY, req.params.id, { hr_status: status });
    pt.invalidate();
    res.json({ message: `Slab ${status === 'active' ? 'activated' : 'deactivated'}` });
  } catch (err) { res.status(err.status || 400).json({ error: err.message || 'Failed to change status' }); }
});

// GET /preview  — resolve PT for a state/gross/date (for the UI tester + salary form).
router.get('/preview', requireRole('super_admin', 'hr_manager'), async (req, res, next) => {
  try {
    const amount = await pt.getProfessionalTax(req.query.state, Number(req.query.gross) || 0, req.query.date);
    res.json({ amount });
  } catch (err) { next(err); }
});

module.exports = router;
