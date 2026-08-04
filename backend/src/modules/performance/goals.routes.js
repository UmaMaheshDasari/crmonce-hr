const express = require('express');
const router = express.Router();
const d365 = require('../../services/d365.service');
const { requireRole } = require('../../middleware/auth.middleware');
const { toValue, labelsForList, labelsForEntity } = require('../../services/picklist');

const ENTITY = d365.constructor.entities.goal;
const ENTITY_NAME = 'hr_hrgoals';
const SELECT_FIELDS = [
  'hr_hrgoalid', 'hr_hrgoal1', 'hr_description', 'hr_quarter', 'hr_financialyear',
  'hr_status', 'hr_priority', 'hr_progress', 'hr_weightage', 'hr_selfrating',
  'hr_managerrating', 'hr_selfcomments', 'hr_managercomments', 'hr_duedate',
  'hr_keyresults', '_hr_hremployee_value', 'createdon', 'modifiedon',
].join(',');

// GET /  — list goals with filters
router.get('/', async (req, res, next) => {
  try {
    const { quarter, year, status, employeeId } = req.query;
    const isHR = ['super_admin', 'hr_manager'].includes(req.user.role);
    const targetId = isHR ? employeeId : req.user.id;

    const filters = [];
    if (targetId) filters.push(`_hr_hremployee_value eq '${targetId}'`);
    if (!isHR) filters.push(`_hr_hremployee_value eq '${req.user.id}'`);
    if (quarter) filters.push(`hr_quarter eq ${toValue('hr_quarter', quarter)}`);
    if (year) filters.push(`hr_financialyear eq '${year}'`);
    if (status) filters.push(`hr_status eq ${toValue('hr_goal_status', status)}`);

    const result = await d365.getList(ENTITY, {
      select: SELECT_FIELDS,
      filter: filters.join(' and ') || undefined,
      orderby: 'createdon desc',
    });

    res.json(labelsForList(ENTITY_NAME, result));
  } catch (err) { next(err); }
});

// GET /:id  — get single goal
router.get('/:id', async (req, res, next) => {
  try {
    const goal = await d365.getById(ENTITY, req.params.id, { select: SELECT_FIELDS });
    const isHR = ['super_admin', 'hr_manager'].includes(req.user.role);
    if (!isHR && goal._hr_hremployee_value !== req.user.id) {
      return res.status(403).json({ error: 'Access denied' });
    }
    res.json(labelsForEntity(ENTITY_NAME, goal));
  } catch (err) { next(err); }
});

// POST /  — create goal (HR/manager only)
router.post('/', requireRole('super_admin', 'hr_manager'), async (req, res, next) => {
  try {
    console.log('[goals/create] incoming payload →', JSON.stringify(req.body));
    const { employeeId, hr_weightage, ...rest } = req.body;

    // ── Validation (return the SPECIFIC reason, never a generic failure) ──
    if (!employeeId) return res.status(400).json({ error: 'Please select an employee.' });
    if (!/^[0-9a-fA-F-]{36}$/.test(String(employeeId))) {
      return res.status(400).json({ error: 'Invalid employee — pick one from the list (a name was sent instead of an ID).' });
    }
    if (!String(rest.hr_hrgoal1 || '').trim()) return res.status(400).json({ error: 'Goal title is required.' });

    let weight = Number(hr_weightage);
    if (!Number.isFinite(weight)) weight = 0;
    if (weight < 0 || weight > 100) return res.status(400).json({ error: 'Weightage must be a number between 0 and 100.' });

    const body = { ...rest };
    // Choice columns → integer option values (never labels).
    if (body.hr_quarter) body.hr_quarter = toValue('hr_quarter', body.hr_quarter);
    body.hr_status = toValue('hr_goal_status', body.hr_status || 'not_started');
    if (body.hr_priority) body.hr_priority = toValue('hr_goal_priority', body.hr_priority);
    body.hr_weightage = Math.round(weight);
    // Employee lookup — GUID via the navigation property (never the name).
    body['hr_hremployee@odata.bind'] = `/hr_hremployees(${employeeId})`;

    // Strip empty / null values. An empty string on a Date column (hr_duedate) or a
    // number column is REJECTED by Dataverse — absent fields are simply not set.
    for (const k of Object.keys(body)) {
      if (body[k] === '' || body[k] === null || body[k] === undefined) delete body[k];
    }
    console.log('[goals/create] dataverse payload →', JSON.stringify(body));

    const goal = await d365.create(ENTITY, body);
    res.status(201).json(labelsForEntity(ENTITY_NAME, goal));
  } catch (err) {
    // Surface the real Dataverse/OData error instead of a generic 500.
    console.error('[goals/create] FAILED:', err.message);
    return res.status(err.status || 400).json({ error: err.message || 'Failed to create goal' });
  }
});

// PATCH /:id  — update goal
router.patch('/:id', async (req, res, next) => {
  try {
    const body = { ...req.body };
    const isHR = ['super_admin', 'hr_manager'].includes(req.user.role);

    // Employee can only update own goals' progress/self-rating/self-comments/status
    if (!isHR) {
      const existing = await d365.getById(ENTITY, req.params.id, { select: '_hr_hremployee_value' });
      if (existing._hr_hremployee_value !== req.user.id) {
        return res.status(403).json({ error: 'Access denied' });
      }
      // Restrict fields for employees
      const allowed = ['hr_progress', 'hr_selfrating', 'hr_selfcomments', 'hr_status'];
      Object.keys(body).forEach(k => { if (!allowed.includes(k)) delete body[k]; });
    }

    if (body.hr_quarter) body.hr_quarter = toValue('hr_quarter', body.hr_quarter);
    if (body.hr_status) body.hr_status = toValue('hr_goal_status', body.hr_status);
    if (body.hr_priority) body.hr_priority = toValue('hr_goal_priority', body.hr_priority);

    const goal = await d365.update(ENTITY, req.params.id, body);
    res.json(labelsForEntity(ENTITY_NAME, goal));
  } catch (err) { next(err); }
});

// DELETE /:id  — delete goal (HR only, not completed)
router.delete('/:id', requireRole('super_admin', 'hr_manager'), async (req, res, next) => {
  try {
    const goal = await d365.getById(ENTITY, req.params.id, { select: 'hr_status' });
    if (goal.hr_status === toValue('hr_goal_status', 'completed') ||
        goal.hr_status === toValue('hr_goal_status', 'exceeded')) {
      return res.status(400).json({ error: 'Cannot delete completed/exceeded goals' });
    }
    await d365.delete(ENTITY, req.params.id);
    res.json({ message: 'Goal deleted' });
  } catch (err) { next(err); }
});

module.exports = router;
