/**
 * Email Notification Preferences API — per-employee, per-category opt-out management.
 *
 * Authorization (ENFORCED HERE, backend — never relying on hidden frontend buttons):
 *   • super_admin / hr_manager → manage ANY employee.
 *   • manager (an 'employee' who has direct reports) → manage only their direct reportees.
 *   • any user → view/manage their OWN preferences.
 *   • otherwise → 403.
 *
 * Mounted with authenticateToken, so req.user = { id, role, name, email }.
 */
const express = require('express');
const router = express.Router();
const d365 = require('../../services/d365.service');
const prefs = require('../../services/email-preferences.service');
const { CATEGORIES } = require('../../services/email-categories');

const EMP = d365.constructor.entities.employee;
const HR_ROLES = ['super_admin', 'hr_manager'];
const isHR = (u) => HR_ROLES.includes(u?.role);
const esc = (s) => String(s == null ? '' : s).replace(/'/g, "''");
const EMP_SELECT = 'hr_hremployeeid,hr_hremployee1,hr_email,hr_department,hr_employeecode,hr_employeeid,_hr_manager_value,hr_status';

const shape = (e) => ({
  id: e.hr_hremployeeid,
  name: e.hr_hremployee1 || '',
  employeeId: e.hr_employeecode || e.hr_employeeid || '',
  department: e.hr_department || '',
  email: e.hr_email || '',
  managerId: e._hr_manager_value || null,
});

async function getEmployee(id) {
  try { return await d365.getByIdOptional(EMP, id, { select: EMP_SELECT }); } catch { return null; }
}

/** Backend authorization: may the caller manage this target employee's preferences? */
function canManage(user, targetId, targetRecord) {
  if (isHR(user)) return true;
  if (user?.id && String(user.id) === String(targetId)) return true;      // self
  if (targetRecord && targetRecord._hr_manager_value && String(targetRecord._hr_manager_value) === String(user?.id)) return true; // direct manager
  return false;
}

// ── GET /categories — the category registry (any authenticated user) ──────────
router.get('/categories', (_req, res) => res.json({ data: CATEGORIES }));

// ── GET /employees?q= — employees the caller may manage (for the picker) ───────
router.get('/employees', async (req, res, next) => {
  try {
    const q = String(req.query.q || '').trim().toLowerCase();
    let filter;
    if (isHR(req.user)) {
      filter = undefined;   // all employees
    } else {
      // A manager sees only their direct reportees; a plain employee sees only themselves.
      filter = `_hr_manager_value eq '${esc(req.user.id)}'`;
    }
    const { data } = await d365.getListOptional(EMP, { select: EMP_SELECT, filter, top: 5000 });
    let rows = (data || []).map(shape);
    // A non-HR, non-manager caller (no reportees) still manages self.
    if (!isHR(req.user) && !rows.some(r => String(r.id) === String(req.user.id))) {
      const self = await getEmployee(req.user.id);
      if (self) rows.unshift(shape(self));
    }
    if (q) rows = rows.filter(r => r.name.toLowerCase().includes(q) || String(r.employeeId).toLowerCase().includes(q) || r.department.toLowerCase().includes(q));
    rows.sort((a, b) => a.name.localeCompare(b.name));
    res.json({ data: rows });
  } catch (err) { next(err); }
});

// ── GET /:employeeId — an employee's current category preferences ─────────────
router.get('/:employeeId', async (req, res, next) => {
  try {
    const { employeeId } = req.params;
    const emp = await getEmployee(employeeId);
    if (!canManage(req.user, employeeId, emp)) return res.status(403).json({ error: 'Not authorized to view this employee\'s preferences.' });
    const preferences = await prefs.getPreferences(employeeId);
    res.json({ data: { employee: emp ? shape(emp) : { id: employeeId }, categories: CATEGORIES, preferences } });
  } catch (err) { next(err); }
});

// ── PUT /:employeeId — update category preferences ────────────────────────────
router.put('/:employeeId', async (req, res, next) => {
  try {
    const { employeeId } = req.params;
    const emp = await getEmployee(employeeId);
    if (!canManage(req.user, employeeId, emp)) return res.status(403).json({ error: 'Not authorized to manage this employee\'s preferences.' });
    const changes = (req.body && req.body.preferences) || {};
    if (!changes || typeof changes !== 'object' || Array.isArray(changes)) return res.status(400).json({ error: 'preferences object required.' });
    const actor = { id: req.user.id, name: req.user.name, role: req.user.role };
    const preferences = await prefs.setPreferences(employeeId, changes, actor, emp?.hr_hremployee1 || '');
    res.json({ data: { preferences } });
  } catch (err) { if (err.status) return res.status(err.status).json({ error: err.message }); next(err); }
});

// ── POST /:employeeId/reset — reset to defaults (all enabled) ──────────────────
router.post('/:employeeId/reset', async (req, res, next) => {
  try {
    const { employeeId } = req.params;
    const emp = await getEmployee(employeeId);
    if (!canManage(req.user, employeeId, emp)) return res.status(403).json({ error: 'Not authorized to manage this employee\'s preferences.' });
    const actor = { id: req.user.id, name: req.user.name, role: req.user.role };
    const preferences = await prefs.resetToDefaults(employeeId, actor, emp?.hr_hremployee1 || '');
    res.json({ data: { preferences } });
  } catch (err) { if (err.status) return res.status(err.status).json({ error: err.message }); next(err); }
});

module.exports = router;
