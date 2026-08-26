const express = require('express');
const router = express.Router();
const d365 = require('../../services/d365.service');
const { requireRole, requireAnyPermission } = require('../../middleware/auth.middleware');
const { resolvePhoto } = require('../../services/employee-photo.util');
const { ensureGoalTable } = require('../../services/provision-goal');
const { notifyGoalAssigned, notifyGoalReassigned } = require('../../services/goal-notify.service');

// hr_hrgoals — a TEXT-column table (see services/provision-goal.js). Quarter /
// Priority / Status are stored as their plain string codes ('Q1', 'medium',
// 'not_started'); the employee is stored as a GUID string in hr_employeeid
// (not a Dataverse lookup). This mirrors the Attendance-Request / Holiday tables
// and lets the frontend read the codes back verbatim (STATUS_CONFIG[goal.hr_status]).
const ENTITY = d365.constructor.entities.goal;   // 'hr_hrgoals'
const EMP = d365.constructor.entities.employee;
const HR_ROLES = ['super_admin', 'hr_manager'];

// The goal stores the employee as a GUID string (hr_employeeid) — not a Dataverse
// lookup — so we "expand" it by joining to the employee master for Name, Employee
// ID (EMP1039), Department and Designation.
async function enrichEmployees(goals) {
  const ids = [...new Set((goals || []).map(g => g.hr_employeeid).filter(Boolean))];
  if (!ids.length) return goals;
  let map = new Map();
  try {
    const { data } = await d365.getListOptional(EMP, {
      select: 'hr_hremployeeid,hr_hremployee1,hr_department,hr_designation',
      optionalSelect: 'hr_employeeid,hr_employeecode,hr_etimecode,hr_photourl,hr_personalphotourl,hr_photoremoved', top: 5000,
    });
    map = new Map((data || []).map(e => [e.hr_hremployeeid, e]));
  } catch { /* enrichment is best-effort */ }
  for (const g of goals) {
    const e = map.get(g.hr_employeeid);
    g._employee = {
      name: e?.hr_hremployee1 || g.hr_employeename || '',
      employeeId: e?.hr_employeeid || e?.hr_etimecode || e?.hr_employeecode || '',
      department: e?.hr_department || '',
      designation: e?.hr_designation || '',
      photo: resolvePhoto(e),
    };
  }
  return goals;
}
const CORE_FIELDS = [
  'hr_hrgoalid', 'hr_hrgoal1', 'hr_description', 'hr_quarter', 'hr_financialyear',
  'hr_status', 'hr_priority', 'hr_progress', 'hr_weightage', 'hr_selfrating',
  'hr_managerrating', 'hr_selfcomments', 'hr_managercomments', 'hr_duedate',
  'hr_keyresults', 'hr_employeeid', 'hr_employeename', 'hr_assignedby',
  'hr_assigneddate', 'createdon', 'modifiedon',
].join(',');
// Notification-audit columns — optional so a table missing them still returns goals.
const AUDIT_FIELDS = 'hr_emailsent,hr_emailsenttime,hr_notificationcreated';

// Quote a value for an OData string-column filter (escape single quotes).
const q = (v) => `'${String(v).replace(/'/g, "''")}'`;

// True when Dataverse says the table/segment or a column doesn't exist yet.
const tableMissing = (err) =>
  d365._isBadSegment?.(err) ||
  /Resource not found for the segment|Could not find a property|does not exist|was not found|404/i
    .test(err?.message || '');

// GET /  — list goals with filters
router.get('/', async (req, res, next) => {
  try {
    const { quarter, year, status, priority, employeeId } = req.query;
    const isHR = HR_ROLES.includes(req.user.role);
    const targetId = isHR ? employeeId : req.user.id;   // non-HR only see their own

    const filters = [];
    if (targetId) filters.push(`hr_employeeid eq ${q(targetId)}`);
    if (quarter) filters.push(`hr_quarter eq ${q(quarter)}`);
    if (year) filters.push(`hr_financialyear eq ${q(year)}`);
    if (status) filters.push(`hr_status eq ${q(status)}`);
    if (priority) filters.push(`hr_priority eq ${q(priority)}`);

    const result = await d365.getListOptional(ENTITY, {
      select: CORE_FIELDS,
      optionalSelect: AUDIT_FIELDS,   // dropped automatically if not yet provisioned
      filter: filters.join(' and ') || undefined,
      orderby: 'createdon desc',
    });
    await enrichEmployees(result.data);   // attach _employee (name, EMP id, dept, designation)
    res.json(result);
  } catch (err) {
    // Table not created yet → provision it, then return an empty list (no goals).
    if (tableMissing(err)) {
      await ensureGoalTable(global.logger || console).catch(() => {});
      return res.json({ data: [], count: 0 });
    }
    next(err);
  }
});

// GET /:id  — get single goal
router.get('/:id', async (req, res, next) => {
  try {
    const goal = await d365.getByIdOptional(ENTITY, req.params.id, { select: CORE_FIELDS, optionalSelect: AUDIT_FIELDS });
    const isHR = HR_ROLES.includes(req.user.role);
    if (!isHR && goal.hr_employeeid !== req.user.id) {
      return res.status(403).json({ error: 'Access denied' });
    }
    await enrichEmployees([goal]);
    res.json(goal);
  } catch (err) { next(err); }
});

// POST /  — create goal (HR/manager only)
router.post('/', requireAnyPermission('performance.create'), async (req, res, next) => {
  try {
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

    // Best-effort: resolve the employee's name for display/filtering.
    let empName = '';
    try {
      const emp = await d365.getById(d365.constructor.entities.employee, employeeId, { select: 'hr_hremployee1' });
      empName = emp?.hr_hremployee1 || '';
    } catch { /* name is optional — the GUID is what matters */ }

    const body = {
      hr_hrgoal1: String(rest.hr_hrgoal1).trim(),      // primary name (title)
      hr_description: rest.hr_description,
      hr_quarter: rest.hr_quarter,                     // text code 'Q1'..'Q4'
      hr_financialyear: rest.hr_financialyear,         // '2025-26'
      hr_priority: rest.hr_priority,                   // 'low'|'medium'|'high'|'critical'
      hr_status: rest.hr_status || 'not_started',
      hr_duedate: rest.hr_duedate,                     // 'YYYY-MM-DD' (or absent)
      hr_keyresults: rest.hr_keyresults,
      hr_weightage: Math.round(weight),
      hr_progress: 0,
      hr_employeeid: employeeId,                       // GUID string (not a lookup)
      hr_employeename: empName,
      hr_assignedby: req.user?.name || req.user?.email || '',
      hr_assigneddate: new Date().toISOString().slice(0, 10),
    };
    // Strip empty / null values — Dataverse rejects '' on Whole Number columns and
    // there's no reason to send absent fields.
    for (const k of Object.keys(body)) {
      if (body[k] === '' || body[k] === null || body[k] === undefined) delete body[k];
    }

    let goal;
    try {
      goal = await d365.create(ENTITY, body);
    } catch (err) {
      // Table not provisioned yet → create it on demand (single attempt — never
      // block the request), then retry the create once.
      if (tableMissing(err)) {
        console.warn('[goals/create] table missing — provisioning hr_hrgoals then retrying');
        const prov = await ensureGoalTable(global.logger || console);   // retry:false
        if (prov.status === 'locked') {
          // Dataverse is mid-publish. The startup provisioner keeps retrying in the
          // background; tell the user to try again shortly.
          return res.status(503).json({ error: prov.message });
        }
        if (prov.status === 'forbidden') {
          // Missing security role — a config problem, reported distinctly from a lock.
          return res.status(503).json({ error: prov.message });
        }
        if (prov.status === 'unavailable') {
          return res.status(503).json({ error: `Goal table could not be created: ${prov.reason}` });
        }
        goal = await d365.create(ENTITY, body);
      } else {
        throw err;
      }
    }

    // Goal is now safely in Dataverse. Fire the assignment notifications (email +
    // in-app + activity). Best-effort: a notification failure NEVER fails or rolls
    // back the goal — it stays assigned. Audit is returned for transparency.
    const notification = await notifyGoalAssigned({
      goal,
      assigner: { name: req.user?.name, email: req.user?.email },
      employeeId,
    });

    res.status(201).json({ ...goal, _notification: notification });
  } catch (err) {
    console.error('[goals/create] FAILED:', err.message);
    return res.status(err.status || 400).json({ error: err.message || 'Failed to create goal' });
  }
});

// PATCH /:id  — update goal (progress / review / status)
router.patch('/:id', async (req, res, next) => {
  try {
    const body = { ...req.body };
    const isHR = HR_ROLES.includes(req.user.role);

    // Employees can only update their OWN goal's progress/self-rating/comments/status.
    let reassign = null;
    if (!isHR) {
      const existing = await d365.getById(ENTITY, req.params.id, { select: 'hr_employeeid' });
      if (existing.hr_employeeid !== req.user.id) {
        return res.status(403).json({ error: 'Access denied' });
      }
      const allowed = ['hr_progress', 'hr_selfrating', 'hr_selfcomments', 'hr_status'];
      Object.keys(body).forEach(k => { if (!allowed.includes(k)) delete body[k]; });
    } else if (body.employeeId && /^[0-9a-fA-F-]{36}$/.test(String(body.employeeId))) {
      // HR re-assigning the goal to a different employee → move the GUID + name.
      const prev = await d365.getById(ENTITY, req.params.id, { select: 'hr_employeeid' });
      if (prev.hr_employeeid !== body.employeeId) reassign = { oldId: prev.hr_employeeid, newId: body.employeeId };
      body.hr_employeeid = body.employeeId;
      try { const emp = await d365.getById(EMP, body.employeeId, { select: 'hr_hremployee1' }); body.hr_employeename = emp?.hr_hremployee1 || ''; } catch {}
    }
    if (body.hr_weightage !== undefined) body.hr_weightage = Math.max(0, Math.min(100, Math.round(Number(body.hr_weightage) || 0)));

    // Never forward the routing id or empty values. Quarter/priority/status stay as
    // their text codes — no option-set conversion.
    delete body.employeeId;
    for (const k of Object.keys(body)) {
      if (body[k] === '' || body[k] === null || body[k] === undefined) delete body[k];
    }

    const goal = await d365.update(ENTITY, req.params.id, body);

    // On re-assignment, notify BOTH the old and new employee (best-effort).
    if (reassign) {
      notifyGoalReassigned({
        goal, assigner: { name: req.user?.name, email: req.user?.email },
        oldEmployeeId: reassign.oldId, newEmployeeId: reassign.newId,
      }).catch(() => {});
    }
    res.json(goal);
  } catch (err) {
    console.error('[goals/update] FAILED:', err.message);
    return res.status(err.status || 400).json({ error: err.message || 'Failed to update goal' });
  }
});

// DELETE /:id  — delete goal (Super Admin only, not completed/exceeded)
router.delete('/:id', requireRole('super_admin'), async (req, res, next) => {
  try {
    const goal = await d365.getById(ENTITY, req.params.id, { select: 'hr_status' });
    if (['completed', 'exceeded'].includes(goal.hr_status)) {
      return res.status(400).json({ error: 'Cannot delete completed/exceeded goals' });
    }
    await d365.delete(ENTITY, req.params.id);
    res.json({ message: 'Goal deleted' });
  } catch (err) {
    console.error('[goals/delete] FAILED:', err.message);
    return res.status(err.status || 400).json({ error: err.message || 'Failed to delete goal' });
  }
});

module.exports = router;
