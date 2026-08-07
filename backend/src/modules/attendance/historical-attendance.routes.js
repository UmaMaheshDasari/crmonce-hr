/**
 * Historical Attendance Requests — mounted at /api/attendance/historical-requests.
 *
 * Employees raise a request to record attendance for a past Absent date; HR
 * approves / rejects / asks for more information. On approval the SINGLE attendance
 * record for that date is upserted (never a second row). Self-heals its table.
 */
const express = require('express');
const router = express.Router();
const { requireRole, requirePermission } = require('../../middleware/auth.middleware');
const svc = require('../../services/historical-attendance.service');
const { ensureHistoricalAttendanceTable } = require('../../services/provision-historical-attendance');

const HR = ['super_admin', 'hr_manager'];
const isHR = (u) => HR.includes(u.role);

async function withTable(fn) {
  try { return await fn(); }
  catch (err) {
    if (/Resource not found for the segment|does not exist|Could not find/i.test(err.message || '')) {
      await ensureHistoricalAttendanceTable(global.logger || console).catch(() => {});
      return await fn();
    }
    throw err;
  }
}

// GET /policy — the configured months-back window.
router.get('/policy', requirePermission('attendance:read'), async (req, res, next) => {
  try { res.json(await svc.policy()); } catch (_) { res.json({ monthsBack: 6 }); }
});

// GET /summary — counts (self, or HR ?employeeId).
router.get('/summary', requirePermission('attendance:read'), async (req, res, next) => {
  try {
    const employeeId = isHR(req.user) ? (req.query.employeeId || undefined) : req.user.id;
    res.json(await withTable(() => svc.summary({ employeeId, month: req.query.month })));
  } catch (err) { next(err); }
});

// GET / — employees see their own; HR sees all (filters: employeeId, status, month).
router.get('/', requirePermission('attendance:read'), async (req, res, next) => {
  try {
    const employeeId = isHR(req.user) ? (req.query.employeeId || undefined) : req.user.id;
    const rows = await withTable(() => svc.list({ employeeId, status: req.query.status, month: req.query.month }));
    res.json({ data: rows, count: rows.length });
  } catch (err) { next(err); }
});

// POST / — employee raises a request (HR may raise for anyone).
router.post('/', requirePermission('attendance:read'), async (req, res, next) => {
  try {
    const b = req.body || {};
    if (!b.date || !String(b.reason || '').trim()) return res.status(400).json({ error: 'Date and reason are required.' });
    const employeeId = isHR(req.user) && b.employeeId ? b.employeeId : req.user.id;
    const employeeName = employeeId === req.user.id ? req.user.name : (b.employeeName || '');
    const out = await withTable(() => svc.create({
      employeeId, employeeName, date: b.date, inTime: b.inTime, outTime: b.outTime,
      reason: b.reason, comments: b.comments, attachmentId: b.attachmentId,
      ip: (req.headers['x-forwarded-for'] || req.ip || '').toString().split(',')[0].trim(),
      createdBy: req.user.name || req.user.email,
    }));
    res.status(201).json({ data: out });
  } catch (err) { if (err.status) return res.status(err.status).json({ error: err.message }); next(err); }
});

// PATCH /:id/approve|reject|more-info — HR decision.
function decisionRoute(action) {
  return async (req, res, next) => {
    try { res.json(await withTable(() => svc.decide(req.params.id, action, req.user, req.body?.comment))); }
    catch (err) { if (err.status) return res.status(err.status).json({ error: err.message }); next(err); }
  };
}
router.patch('/:id/approve', requireRole(...HR), decisionRoute('approved'));
router.patch('/:id/reject', requireRole(...HR), decisionRoute('rejected'));
router.patch('/:id/more-info', requireRole(...HR), decisionRoute('more_info'));

module.exports = router;
