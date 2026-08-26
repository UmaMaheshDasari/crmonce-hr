/**
 * Shift History — mounted at /api/shift-history (HR / Super Admin only).
 *
 * View an employee's effective-dated shift assignments and change their shift WITHOUT
 * overwriting history (a new row is appended; the prior one is closed). Attendance
 * resolves the shift by date from these rows (see shift-history.service).
 */
const express = require('express');
const router = express.Router();
const { requireRole, requireAnyPermission } = require('../../middleware/auth.middleware');
const d365 = require('../../services/d365.service');
const shiftHistory = require('../../services/shift-history.service');
const { ensureShiftHistoryTable } = require('../../services/provision-shift-history');

const EMP = d365.constructor.entities.employee;
const HR = ['super_admin', 'hr_manager'];
const today = () => new Date().toISOString().slice(0, 10);

async function withTable(fn) {
  try { return await fn(); }
  catch (err) {
    if (/Resource not found for the segment|does not exist|Could not find/i.test(err.message)) {
      await ensureShiftHistoryTable(global.logger || console).catch(() => {});
      return await fn();
    }
    throw err;
  }
}

// GET /employee/:employeeId — the full shift-history timeline (newest first).
router.get('/employee/:employeeId', requireAnyPermission('employees.edit'), async (req, res, next) => {
  try { res.json({ data: await withTable(() => shiftHistory.list(req.params.employeeId)) }); }
  catch (err) { next(err); }
});

// POST / — change an employee's shift (append a new effective-dated assignment).
// Body: { employeeId, shiftName, shiftStart, shiftEnd, graceMins?, effectiveFrom, reason? }
router.post('/', requireAnyPermission('employees.edit'), async (req, res, next) => {
  try {
    const b = req.body || {};
    if (!b.employeeId || !/^[0-9a-fA-F-]{36}$/.test(String(b.employeeId))) return res.status(400).json({ error: 'A valid employee is required.' });
    if (!b.shiftStart) return res.status(400).json({ error: 'Shift start time is required.' });

    // The employee record supplies the name, joining date, and the CURRENT shift (which
    // becomes the seed for history the first time the shift is changed).
    const emp = await d365.getByIdOptional(EMP, b.employeeId, {
      select: 'hr_hremployeeid,hr_hremployee1', optionalSelect: 'hr_shiftname,hr_shiftstarttime,hr_shiftendtime,hr_joiningdate',
    }).catch(() => null);

    const rec = await withTable(() => shiftHistory.changeShift({
      employeeId: b.employeeId, employeeName: b.employeeName || emp?.hr_hremployee1,
      shiftName: b.shiftName, shiftStart: b.shiftStart, shiftEnd: b.shiftEnd, graceMins: b.graceMins,
      effectiveFrom: b.effectiveFrom, reason: b.reason, changedBy: req.user.name || req.user.email || 'HR',
      joiningDate: emp?.hr_joiningdate,
      oldShift: { shiftName: emp?.hr_shiftname, shiftStart: emp?.hr_shiftstarttime, shiftEnd: emp?.hr_shiftendtime },
    }));

    // Keep the employee's CURRENT shift fields in sync with whatever is effective TODAY
    // (a backdated insert may not be the current one; a future-dated change leaves today
    // unchanged). resolveShiftForDate returns the assignment effective on the given date.
    try {
      const eff = await shiftHistory.resolveShiftForDate(b.employeeId, today());
      if (eff?.start) await d365.update(EMP, b.employeeId, { hr_shiftname: eff.name || '', hr_shiftstarttime: eff.start, hr_shiftendtime: eff.end || '' });
    } catch (_) { /* optional shift columns — best-effort mirror */ }
    res.status(201).json(rec);
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

module.exports = router;
