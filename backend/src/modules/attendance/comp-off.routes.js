/**
 * Comp Off — mounted at /api/attendance/comp-off.
 *
 * Employees: view their balance/history, and raise a request (if policy allows).
 * HR / Super Admin: grant, edit, cancel, expire, approve, reject, and scan
 * attendance to auto-raise comp-off for holiday / weekly-off work.
 */
const express = require('express');
const router = express.Router();
const { requireRole, requireAnyPermission } = require('../../middleware/auth.middleware');
const compOff = require('../../services/comp-off.service');
const payrollSettings = require('../../services/payroll-settings.service');
const leaveEngine = require('../../services/leave-engine.service');
const { ensureCompOffTable } = require('../../services/provision-comp-off');

const HR = ['super_admin', 'hr_manager'];
const isHR = (u) => HR.includes(u.role);

async function withTable(fn) {
  try { return await fn(); }
  catch (err) {
    if (/Resource not found for the segment|does not exist|Could not find/i.test(err.message)) {
      await ensureCompOffTable(global.logger || console).catch(() => {});
      return await fn();
    }
    throw err;
  }
}

// GET /  — comp-off records. Employee: own. HR: all, or ?employeeId. Lazily expires.
router.get('/', async (req, res, next) => {
  try {
    const employeeId = isHR(req.user) ? (req.query.employeeId || undefined) : req.user.id;
    if (isHR(req.user)) { compOff.sweepExpired().catch(() => {}); }   // best-effort lazy expiry
    const rows = await withTable(() => compOff.list({ employeeId, year: req.query.year, status: req.query.status }));
    res.json({ data: rows, count: rows.length });
  } catch (err) { next(err); }
});

// GET /balance  — comp-off balance for the current user (or HR ?employeeId)
router.get('/balance', async (req, res, next) => {
  try {
    const employeeId = isHR(req.user) ? (req.query.employeeId || req.user.id) : req.user.id;
    const year = Number(req.query.year) || new Date().getFullYear();
    const bal = await leaveEngine.getBalance(employeeId, year);
    res.json({ compOff: bal.compOff, year });
  } catch (err) { next(err); }
});

// GET /policy  — comp-off policy (for the UI: can employees raise? expiry days)
router.get('/policy', async (req, res, next) => {
  try {
    const { compOff: p } = await payrollSettings.getResolved();
    res.json({ expiryDays: p.expiryDays, autoEarn: p.autoEarn, employeeRaise: p.employeeRaise });
  } catch (_) { res.json({ expiryDays: 90, autoEarn: true, employeeRaise: true }); }
});

// GET /eligibility?date=YYYY-MM-DD[&employeeId]  — computed worked-hours + Comp Off
// eligibility for a date (employee: own; HR: ?employeeId). Drives the form's live
// eligibility hint; the backend re-checks on submit (this is advisory, not the gate).
router.get('/eligibility', async (req, res, next) => {
  try {
    const date = String(req.query.date || '').slice(0, 10);
    if (!date) return res.status(400).json({ error: 'date is required.' });
    const employeeId = isHR(req.user) ? (req.query.employeeId || req.user.id) : req.user.id;
    const worked = await withTable(() => compOff.workedHoursForDate(employeeId, date));
    const duplicate = await compOff.existsForDate(employeeId, date).catch(() => false);
    res.json({ ...worked, duplicate, eligible: worked.eligible && !duplicate });
  } catch (err) { next(err); }
});

// POST /  — HR grants comp-off (grant=true → approved immediately), or an employee
// raises a request (always pending; only if policy allows). Eligibility (attendance +
// >= 5 worked hours + no duplicate + work report) is enforced HERE, server-side.
router.post('/', async (req, res, next) => {
  try {
    const b = req.body || {};
    if (!b.workedDate) return res.status(400).json({ error: 'Worked date is required.' });

    if (isHR(req.user)) {
      if (!b.employeeId || !/^[0-9a-fA-F-]{36}$/.test(String(b.employeeId))) return res.status(400).json({ error: 'A valid employee is required.' });
      // Prevent duplicate credits for the same employee/date (same rule as the auto scan).
      if (await withTable(() => compOff.existsForDate(b.employeeId, String(b.workedDate).slice(0, 10)))) {
        return res.status(409).json({ error: 'A Comp Off already exists for this date.' });
      }
      // Compute REAL worked hours when attendance exists (never trust typed hours). HR keeps
      // discretion over the day amount / immediate grant, so HR is not hard-blocked on <5h.
      const worked = await compOff.workedHoursForDate(b.employeeId, b.workedDate);
      const days = Number(b.days) || (worked.hasAttendance ? compOff.compOffDaysForHours(worked.effectiveHours) : 1);
      if (days <= 0) return res.status(400).json({ error: 'Comp off days must be greater than 0.' });
      const rec = await withTable(() => compOff.create({
        employeeId: b.employeeId, employeeName: b.employeeName, type: 'manual',
        workedDate: b.workedDate, workedHours: worked.hasAttendance ? worked.effectiveHours : b.workedHours,
        reason: b.workReport || b.reason, holidayName: b.holidayName,
        days, remarks: b.remarks || b.evidenceUrl || '', createdBy: req.user.name || req.user.email || 'HR',
        status: b.grant ? 'approved' : 'pending',
      }));
      return res.status(201).json(rec);
    }

    // Employee self-raise — policy gate, then STRICT backend eligibility. workedHours is
    // computed server-side (typed hours are ignored); a work report is mandatory.
    const { compOff: policy } = await payrollSettings.getResolved();
    if (!policy.employeeRaise) return res.status(403).json({ error: 'Comp-off requests are not enabled for employees.' });
    const workReport = b.workReport || b.reason || '';
    const v = await withTable(() => compOff.validateManualCompOff({ employeeId: req.user.id, workedDate: b.workedDate, workReport, requireWorkReport: true }));
    if (!v.ok) return res.status(v.status).json({ error: v.error });
    // Employee's Full/Half choice (default Full), capped by the hours-eligible max so a request
    // can never claim more than the worked hours earned.
    const days = compOff.requestedDaysForType(b.dayType, v.days);
    const rec = await withTable(() => compOff.create({
      employeeId: req.user.id, employeeName: req.user.name, type: 'manual',
      workedDate: b.workedDate, workedHours: v.worked.effectiveHours, reason: workReport,
      days, remarks: b.evidenceUrl || '', createdBy: req.user.name || req.user.email, status: 'pending',
    }));
    res.status(201).json(rec);
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

// GET /:id/verify — HR attendance-verification details + calculated eligibility for the
// comp-off's worked date (authoritative; the frontend only displays this).
router.get('/:id/verify', requireAnyPermission('compoff.approve'), async (req, res, next) => {
  try { res.json(await withTable(() => compOff.attendanceVerification(req.params.id))); }
  catch (err) { if (err.status) return res.status(err.status).json({ error: err.message }); next(err); }
});

// PATCH /:id/approve  — optional body { dayType: 'full' | 'half' } lets the approver set the
// FINAL Full/Half type before it is credited (pending only). Gated by compoff.approve (HR).
router.patch('/:id/approve', requireAnyPermission('compoff.approve'), async (req, res, next) => {
  try { res.json(await compOff.approve(req.params.id, req.user, { dayType: req.body?.dayType })); }
  catch (err) { if (err.status) return res.status(err.status).json({ error: err.message }); next(err); }
});

// PATCH /:id/reject
router.patch('/:id/reject', requireAnyPermission('compoff.reject'), async (req, res, next) => {
  try { res.json(await compOff.reject(req.params.id, req.user, req.body?.remarks)); }
  catch (err) { if (err.status) return res.status(err.status).json({ error: err.message }); next(err); }
});

// PATCH /:id/cancel
router.patch('/:id/cancel', requireAnyPermission('compoff.edit'), async (req, res, next) => {
  try { res.json(await compOff.cancel(req.params.id, req.user, req.body?.remarks)); }
  catch (err) { if (err.status) return res.status(err.status).json({ error: err.message }); next(err); }
});

// PATCH /:id/expire
router.patch('/:id/expire', requireAnyPermission('compoff.edit'), async (req, res, next) => {
  try { res.json(await compOff.expire(req.params.id)); }
  catch (err) { if (err.status) return res.status(err.status).json({ error: err.message }); next(err); }
});

// DELETE /:id  — EMPLOYEE deletes THEIR OWN comp-off (HR/Admin get 403 — they use
// Approve/Reject). Pending/rejected → removed; Approved unused → ledger reversed then
// removed; Approved USED → blocked (409). Authorization is enforced in the service.
router.delete('/:id', async (req, res, next) => {
  try { res.json(await withTable(() => compOff.remove(req.params.id, req.user))); }
  catch (err) { if (err.status) return res.status(err.status).json({ error: err.message }); next(err); }
});

// PATCH /:id  — edit (days / reason / remarks / expiry / holiday)
router.patch('/:id', requireAnyPermission('compoff.edit'), async (req, res, next) => {
  try { res.json(await compOff.edit(req.params.id, req.body || {})); }
  catch (err) { if (err.status) return res.status(err.status).json({ error: err.message }); next(err); }
});

// POST /scan  — scan attendance in [from,to] and auto-raise comp-off for holiday/weekly-off work
router.post('/scan', requireAnyPermission('compoff.configure'), async (req, res, next) => {
  try {
    const from = String(req.body?.from || '').slice(0, 10);
    const to = String(req.body?.to || '').slice(0, 10);
    if (!from || !to) return res.status(400).json({ error: 'from and to dates are required.' });
    const created = await withTable(() => compOff.scanRange({ from, to }));
    res.json({ created: created.length, records: created });
  } catch (err) { next(err); }
});

// POST /scan-month  — MONTH-END comp-off scan for one completed month (HR manual run /
// retry). Uses the EXACT same scanMonthCompOff() service as the month-end scheduler —
// no business logic is duplicated here. Idempotent: re-running creates no duplicates.
router.post('/scan-month', requireAnyPermission('compoff.configure'), async (req, res, next) => {
  try {
    const month = Number(req.body?.month), year = Number(req.body?.year);
    if (!month || month < 1 || month > 12 || !year) return res.status(400).json({ error: 'A valid month (1-12) and year are required.' });
    const summary = await withTable(() => compOff.scanMonthCompOff({ month, year }));
    res.json(summary);
  } catch (err) { next(err); }
});

module.exports = router;
