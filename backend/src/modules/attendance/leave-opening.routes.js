/**
 * Historical Leave Opening Balance — HR / Super Admin only.
 * Mounted at /api/leave-opening.
 *
 * One row per employee per leave-year (a second create is rejected). Edits are
 * audited. The engine folds these into every employee's live leave balance.
 */
const express = require('express');
const router = express.Router();
const d365 = require('../../services/d365.service');
const { requireRole, requireAnyPermission } = require('../../middleware/auth.middleware');
const openingSvc = require('../../services/leave-opening.service');
const leaveEngine = require('../../services/leave-engine.service');
const usageReport = require('../../services/leave-opening-report.service');
const { ensureLeaveOpeningTable } = require('../../services/provision-leave-opening');
let activity; try { activity = require('../../services/activity.service'); } catch (_) { activity = null; }
const audit = (p) => { try { activity?.record?.(p); } catch (_) {} };

const EMP = d365.constructor.entities.employee;
const HR = ['super_admin', 'hr_manager'];

async function resolveEmployee(id) {
  try { const e = await d365.getById(EMP, id, { select: 'hr_hremployeeid,hr_hremployee1' }); return e?.hr_hremployee1 || ''; }
  catch { return ''; }
}

// Ensure the table exists before the first write (self-heals if provisioning was deferred).
async function withTable(fn) {
  try { return await fn(); }
  catch (err) {
    if (/Resource not found for the segment|does not exist|Could not find/i.test(err.message)) {
      await ensureLeaveOpeningTable(global.logger || console).catch(() => {});
      return await fn();
    }
    throw err;
  }
}

// GET /  — list opening balances (?year, ?employeeId)
router.get('/', requireAnyPermission('leave.manage_balance'), async (req, res, next) => {
  try {
    const rows = await withTable(() => openingSvc.list({ year: req.query.year, employeeId: req.query.employeeId }));
    res.json({ data: rows, count: rows.length });
  } catch (err) { next(err); }
});

// GET /audit  — edit history for an employee/year
router.get('/audit', requireAnyPermission('leave.manage_balance'), async (req, res, next) => {
  try {
    const { employeeId, year } = req.query;
    if (!employeeId) return res.status(400).json({ error: 'employeeId is required' });
    const rows = await openingSvc.readAudit(employeeId, year);
    res.json({ data: rows, count: rows.length });
  } catch (err) { next(err); }
});

// GET /report  — computed leave-usage report for a year (least-taken first).
//   Reporting only: approved+pending usage, year-clamped, remaining from the real
//   balance (pending not deducted). Reuses the leave engine + payroll LOP source.
router.get('/report', requireAnyPermission('leave.manage_balance'), async (req, res, next) => {
  try {
    const rows = await withTable(() => usageReport.buildSummary({ year: req.query.year }));
    res.json({ data: rows, count: rows.length, year: Number(req.query.year) || new Date().getFullYear() });
  } catch (err) { next(err); }
});

// GET /report/export  — same report as an Excel workbook (sorted least-taken first).
router.get('/report/export', requireAnyPermission('leave.manage_balance'), async (req, res, next) => {
  try {
    const year = Number(req.query.year) || new Date().getFullYear();
    const wb = await withTable(() => usageReport.buildWorkbook({ year }));
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="leave-usage-${year}.xlsx"`);
    await wb.xlsx.write(res);
    res.end();
  } catch (err) { next(err); }
});

function parseBody(body) {
  return {
    employeeId: body.employeeId,
    year: Number(body.year) || new Date().getFullYear(),
    casualUsed: Number(body.casualUsed) || 0,
    sickUsed: Number(body.sickUsed) || 0,
    earnedUsed: Number(body.earnedUsed) || 0,
    lopUsed: Number(body.lopUsed) || 0,
    compOff: Number(body.compOff) || 0,
    remarks: body.remarks || '',
    reason: body.reason || '',
  };
}

function validate(v) {
  if (!v.employeeId || !/^[0-9a-fA-F-]{36}$/.test(String(v.employeeId))) return 'A valid employee is required.';
  if (v.year < 2000 || v.year > 2100) return 'Leave year is invalid.';
  for (const k of ['casualUsed', 'sickUsed', 'lopUsed', 'compOff']) {
    if (v[k] < 0) return 'Values cannot be negative.';
  }
  return '';
}

// POST /  — create (one-time; 409 if the year already exists)
router.post('/', requireAnyPermission('leave.manage_balance'), async (req, res, next) => {
  try {
    const v = parseBody(req.body);
    const err = validate(v); if (err) return res.status(400).json({ error: err });
    const employeeName = await resolveEmployee(v.employeeId);
    const result = await withTable(() => openingSvc.upsert({ ...v, employeeName, updatedBy: req.user?.name || req.user?.email || 'HR', reason: v.reason || 'Created' }, { allowUpdate: false }));
    const balance = await leaveEngine.getBalance(v.employeeId, v.year);
    audit({ category: 'Leave', type: 'opening_created', title: 'Leave opening balance set', name: employeeName, meta: { year: v.year, by: req.user?.name } });
    res.status(201).json({ ...result, balance });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

// PUT /  — edit an existing opening balance (audited)
router.put('/', requireAnyPermission('leave.manage_balance'), async (req, res, next) => {
  try {
    const v = parseBody(req.body);
    const err = validate(v); if (err) return res.status(400).json({ error: err });
    if (!v.reason) return res.status(400).json({ error: 'A reason is required for editing an opening balance.' });
    const employeeName = await resolveEmployee(v.employeeId);
    const result = await withTable(() => openingSvc.upsert({ ...v, employeeName, updatedBy: req.user?.name || req.user?.email || 'HR', reason: v.reason }, { allowUpdate: true }));
    const balance = await leaveEngine.getBalance(v.employeeId, v.year);
    audit({ category: 'Leave', type: 'opening_updated', title: 'Leave opening balance edited', name: employeeName, meta: { year: v.year, by: req.user?.name } });
    res.json({ ...result, balance });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

// DELETE /:id
router.delete('/:id', requireAnyPermission('leave.manage_balance'), async (req, res, next) => {
  try { await openingSvc.remove(req.params.id); res.json({ message: 'Deleted' }); }
  catch (err) { next(err); }
});

module.exports = router;
