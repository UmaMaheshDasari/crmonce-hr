/**
 * Late Login — mounted at /api/attendance/late-login.
 *
 * Employees submit a request (self); the reporting manager approves, then HR
 * finalises (unless approval is disabled in settings → auto-approved). Attendance
 * stays Present and no leave/salary is deducted. A monthly-limit warning is
 * surfaced but never blocks — HR keeps authority. The same table/API is future-
 * ready for other request types via `requestType`.
 */
const express = require('express');
const router = express.Router();
const ExcelJS = require('exceljs');
const d365 = require('../../services/d365.service');
const { requireRole } = require('../../middleware/auth.middleware');
const lateLogin = require('../../services/late-login.service');
const payrollSettings = require('../../services/payroll-settings.service');
const { ensureLateLoginTable } = require('../../services/provision-late-login');

const EMP = d365.constructor.entities.employee;
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

// Enrich rows with department (for HR filter/report). Best-effort.
async function withDepartments(rows) {
  try {
    const ids = [...new Set(rows.map(r => r.employeeId).filter(Boolean))];
    if (!ids.length) return rows;
    const { data } = await d365.getList(EMP, { select: 'hr_hremployeeid,hr_department', top: 5000 });
    const dept = new Map((data || []).map(e => [e.hr_hremployeeid, e.hr_department || '']));
    return rows.map(r => ({ ...r, department: dept.get(r.employeeId) || '' }));
  } catch { return rows; }
}

// GET /policy — grace time, monthly limit, backdated window, future/approval flags.
router.get('/policy', async (req, res, next) => {
  try {
    const { lateLogin: p } = await payrollSettings.getResolved();
    res.json({ graceMinutes: p.graceMinutes, maxPerMonth: p.maxPerMonth, backdatedDays: p.backdatedDays, allowFuture: p.allowFuture, approvalRequired: p.approvalRequired, attendanceMode: p.attendanceMode });
  } catch (_) { res.json({ graceMinutes: 15, maxPerMonth: 3, backdatedDays: 30, allowFuture: true, approvalRequired: true, attendanceMode: 'late_present' }); }
});

// GET /summary — dashboard counts (self, or HR ?employeeId; ?month=YYYY-MM).
router.get('/summary', async (req, res, next) => {
  try {
    const employeeId = isHR(req.user) ? (req.query.employeeId || undefined) : req.user.id;
    res.json(await withTable(() => lateLogin.summary({ employeeId, month: req.query.month })));
  } catch (err) { next(err); }
});

// GET /  — requests. Employee: own. HR: all (filters: employeeId, department, month, status).
router.get('/', async (req, res, next) => {
  try {
    const employeeId = isHR(req.user) ? (req.query.employeeId || undefined) : req.user.id;
    let rows = await withTable(() => lateLogin.list({ employeeId, month: req.query.month, status: req.query.status, from: req.query.from, to: req.query.to }));
    if (isHR(req.user) && req.query.department) {
      rows = await withDepartments(rows);
      rows = rows.filter(r => r.department === req.query.department);
    }
    res.json({ data: rows, count: rows.length });
  } catch (err) { next(err); }
});

// GET /export?format=xlsx|csv — filtered report (HR + own). Columns match the audit log.
router.get('/export', async (req, res, next) => {
  try {
    const employeeId = isHR(req.user) ? (req.query.employeeId || undefined) : req.user.id;
    let rows = await withTable(() => lateLogin.list({ employeeId, month: req.query.month, status: req.query.status }));
    if (isHR(req.user)) { rows = await withDepartments(rows); if (req.query.department) rows = rows.filter(r => r.department === req.query.department); }
    const cols = [
      ['Employee', r => r.employeeName], ['Department', r => r.department || ''], ['Date', r => r.date],
      ['Expected', r => r.expectedTime], ['Actual', r => r.actualTime], ['Reason', r => r.reason],
      ['Remarks', r => r.remarks], ['Status', r => r.status], ['Manager Status', r => r.managerStatus],
      ['Approved By', r => r.approvedBy], ['Approved Date', r => r.approvedDate], ['IP', r => r.ip],
    ];
    if (String(req.query.format) === 'csv') {
      const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
      const csv = [cols.map(c => q(c[0])).join(',')].concat(rows.map(r => cols.map(c => q(c[1](r))).join(','))).join('\r\n');
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', 'attachment; filename=late-logins.csv');
      return res.send(csv);
    }
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Late Logins');
    ws.columns = cols.map(c => ({ header: c[0], key: c[0], width: 18 }));
    rows.forEach(r => ws.addRow(Object.fromEntries(cols.map(c => [c[0], c[1](r)]))));
    ws.getRow(1).font = { bold: true };
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename=late-logins.xlsx');
    await wb.xlsx.write(res); res.end();
  } catch (err) { next(err); }
});

// POST /  — submit a Late Login. Returns { record, warning }. Captures the source IP.
router.post('/', async (req, res, next) => {
  try {
    const b = req.body || {};
    if (!b.date || !b.expectedTime || !b.actualTime || !String(b.reason || '').trim()) {
      return res.status(400).json({ error: 'Date, expected time, actual time and reason are required.' });
    }
    const employeeId = isHR(req.user) && b.employeeId ? b.employeeId : req.user.id;
    const employeeName = employeeId === req.user.id ? req.user.name : (b.employeeName || '');
    const out = await withTable(() => lateLogin.create({
      employeeId, employeeName, date: b.date, expectedTime: b.expectedTime, actualTime: b.actualTime,
      reason: b.reason, remarks: b.remarks, attachmentId: b.attachmentId, requestType: b.requestType || 'late_login',
      ip: (req.headers['x-forwarded-for'] || req.ip || '').toString().split(',')[0].trim(),
      createdBy: req.user.name || req.user.email,
    }));
    res.status(201).json(out);
  } catch (err) { if (err.status) return res.status(err.status).json({ error: err.message }); next(err); }
});

// PATCH /:id/manager  — reporting manager (or HR) decision.
router.patch('/:id/manager', async (req, res, next) => {
  try {
    const action = req.body?.action === 'rejected' ? 'rejected' : 'approved';
    res.json(await lateLogin.managerDecide(req.params.id, action, req.user, req.body?.remarks));
  } catch (err) { next(err); }
});

// PATCH /:id/hr  — HR final decision.
router.patch('/:id/hr', requireRole(...HR), async (req, res, next) => {
  try {
    const action = req.body?.action === 'rejected' ? 'rejected' : 'approved';
    res.json(await lateLogin.hrDecide(req.params.id, action, req.user, req.body?.remarks));
  } catch (err) { next(err); }
});

// PATCH /:id/cancel  — employee cancels their own pending request (or HR).
router.patch('/:id/cancel', async (req, res, next) => {
  try {
    const row = await lateLogin.getRaw(req.params.id);
    if (!isHR(req.user) && row.hr_employeeid !== req.user.id) return res.status(403).json({ error: 'Access denied' });
    if (['approved', 'rejected', 'cancelled'].includes(row.hr_status)) return res.status(400).json({ error: `Cannot cancel a ${row.hr_status} request.` });
    res.json(await lateLogin.cancel(req.params.id, req.user));
  } catch (err) { next(err); }
});

module.exports = router;
