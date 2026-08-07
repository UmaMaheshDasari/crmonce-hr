/**
 * Late Login — mounted at /api/attendance/late-login.
 *
 * Employees submit a Late Login request (self); the reporting manager approves,
 * then HR finalises. A monthly-limit warning is surfaced but never blocks — HR
 * keeps approval authority. On approval attendance stays Present and no leave is
 * deducted (this is purely a record).
 */
const express = require('express');
const router = express.Router();
const { requireRole } = require('../../middleware/auth.middleware');
const lateLogin = require('../../services/late-login.service');
const payrollSettings = require('../../services/payroll-settings.service');
const { ensureLateLoginTable } = require('../../services/provision-late-login');

const HR = ['super_admin', 'hr_manager'];
const isHR = (u) => HR.includes(u.role);

async function withTable(fn) {
  try { return await fn(); }
  catch (err) {
    if (/Resource not found for the segment|does not exist|Could not find/i.test(err.message)) {
      await ensureLateLoginTable(global.logger || console).catch(() => {});
      return await fn();
    }
    throw err;
  }
}

// GET /policy — grace time + monthly limit (for the UI, not hardcoded).
router.get('/policy', async (req, res, next) => {
  try {
    const { lateLogin: p } = await payrollSettings.getResolved();
    res.json({ graceMinutes: p.graceMinutes, maxPerMonth: p.maxPerMonth });
  } catch (_) { res.json({ graceMinutes: 15, maxPerMonth: 3 }); }
});

// GET /  — Late Login requests. Employee: own. HR: all, or ?employeeId. ?month=YYYY-MM.
router.get('/', async (req, res, next) => {
  try {
    const employeeId = isHR(req.user) ? (req.query.employeeId || undefined) : req.user.id;
    const rows = await withTable(() => lateLogin.list({ employeeId, month: req.query.month, status: req.query.status }));
    res.json({ data: rows, count: rows.length });
  } catch (err) { next(err); }
});

// POST /  — employee submits a Late Login (self). Returns a warning if over the limit.
router.post('/', async (req, res, next) => {
  try {
    const b = req.body || {};
    if (!b.date || !b.expectedTime || !b.actualTime || !String(b.reason || '').trim()) {
      return res.status(400).json({ error: 'Date, expected time, actual time and reason are required.' });
    }
    // HR may raise on behalf of an employee; everyone else raises for themselves.
    const employeeId = isHR(req.user) && b.employeeId ? b.employeeId : req.user.id;
    const employeeName = employeeId === req.user.id ? req.user.name : (b.employeeName || '');
    const out = await withTable(() => lateLogin.create({
      employeeId, employeeName, date: b.date, expectedTime: b.expectedTime, actualTime: b.actualTime,
      reason: b.reason, remarks: b.remarks, createdBy: req.user.name || req.user.email,
    }));
    res.status(201).json(out);   // { record, warning }
  } catch (err) { next(err); }
});

// PATCH /:id/manager  — reporting manager (or HR) decision. body: { action, remarks }
router.patch('/:id/manager', async (req, res, next) => {
  try {
    const action = req.body?.action === 'rejected' ? 'rejected' : 'approved';
    res.json(await lateLogin.managerDecide(req.params.id, action, req.user, req.body?.remarks));
  } catch (err) { next(err); }
});

// PATCH /:id/hr  — HR final decision. body: { action, remarks }
router.patch('/:id/hr', requireRole(...HR), async (req, res, next) => {
  try {
    const action = req.body?.action === 'rejected' ? 'rejected' : 'approved';
    res.json(await lateLogin.hrDecide(req.params.id, action, req.user, req.body?.remarks));
  } catch (err) { next(err); }
});

module.exports = router;
