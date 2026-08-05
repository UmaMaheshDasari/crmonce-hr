// ── PAYROLL ───────────────────────────────────────────────────────
const express = require('express');
const payrollRouter = express.Router();
const d365 = require('../../services/d365.service');
const { requireRole, requirePermission } = require('../../middleware/auth.middleware');
const { notifyPayrollProcessed, broadcast, notifyUser } = require('../../services/notification.service');
const { toValue, labelsForList } = require('../../services/picklist');
const { rangeCounts } = require('../../services/attendance-summary.util');
const { computePayroll, round2 } = require('../../services/payroll.calc');
const { buildPayslipPdf } = require('../../services/payslip.service');
const { emailPayslip } = require('../../services/payslip-notify.service');
const { buildReport } = require('../../services/payroll-reports.service');

const E = d365.constructor.entities;
const PAYROLL = E.payroll;
const pad2 = (n) => String(n).padStart(2, '0');

// Base columns always present + computed/workflow columns that may not be
// provisioned yet (selected/stored optionally so payroll works before migration).
const BASE_SELECT = 'hr_hrpayrollid,hr_month,hr_year,hr_basic,hr_allowances,hr_deductions,hr_netpay,hr_status,hr_processeddate,_hr_hremployee_value';
const OPT_SELECT = 'hr_gross,hr_overtime,hr_lop,hr_presentdays,hr_absentdays,hr_workingdays,hr_paydays,hr_approvedby,hr_approveddate,hr_releasedby,hr_releaseddate,hr_emailsent,hr_emailsenttime';
const OPT_FIELDS = OPT_SELECT.split(',');

// create/update that retry WITHOUT the optional (computed/workflow) columns if
// Dataverse rejects them as unknown — so a not-yet-provisioned column never blocks.
const stripOpt = (data) => { const r = { ...data }; for (const f of OPT_FIELDS) delete r[f]; return r; };
async function createOpt(data) {
  try { return await d365.create(PAYROLL, data); }
  catch (err) { if (!d365._isMissingProperty(err)) throw err; return d365.create(PAYROLL, stripOpt(data)); }
}
async function updateOpt(id, data) {
  try { return await d365.update(PAYROLL, id, data); }
  catch (err) { if (!d365._isMissingProperty(err)) throw err; return d365.update(PAYROLL, id, stripOpt(data)); }
}

// ── Attendance facts for a month (best-effort; failure → assume full present, no LOP) ──
async function attendanceFacts(empId, month, year) {
  const from = `${year}-${pad2(month)}-01`;
  const lastDay = new Date(year, month, 0).getDate();
  const to = `${year}-${pad2(month)}-${pad2(lastDay)}`;
  const workingDays = rangeCounts(from, to).working;

  let presentDays = workingDays;   // assume present unless attendance says otherwise
  let overtimeHours = 0;
  try {
    const { data } = await d365.getList(E.attendance, {
      select: 'hr_date,hr_intime,_hr_hremployee_value',
      filter: `_hr_hremployee_value eq '${empId}' and hr_date ge '${from}' and hr_date le '${to}'`,
      top: 400,
    });
    const dates = new Set();
    for (const r of data || []) if (r.hr_intime && r.hr_date) dates.add(String(r.hr_date).slice(0, 10));
    presentDays = Math.min(dates.size, workingDays);
  } catch { /* keep assumed full present */ }

  let paidLeaveDays = 0;
  try {
    const { data } = await d365.getList(E.leave, {
      select: 'hr_days,hr_fromdate,hr_status',
      filter: `_hr_hremployee_value eq '${empId}' and hr_status eq ${toValue('hr_leave_status', 'approved')}`,
      top: 200,
    });
    const ym = `${year}-${pad2(month)}`;
    for (const l of data || []) if (String(l.hr_fromdate || '').slice(0, 7) === ym) paidLeaveDays += Number(l.hr_days) || 0;
  } catch { /* no paid leave data */ }

  const lopDays = Math.max(0, workingDays - presentDays - paidLeaveDays);
  return { workingDays, presentDays, absentDays: lopDays, lopDays, overtimeHours };
}

// GET /  — list payroll (employees scoped to their own)
payrollRouter.get('/', requirePermission('payroll:read'), async (req, res, next) => {
  try {
    const { employeeId, month, year, page = 1, limit = 20 } = req.query;
    const filters = [];
    const targetId = req.user.role === 'employee' ? req.user.id : employeeId;
    if (targetId) filters.push(`_hr_hremployee_value eq '${targetId}'`);
    if (month) filters.push(`hr_month eq ${month}`);
    if (year) filters.push(`hr_year eq ${year}`);

    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const lim = Math.max(1, parseInt(limit, 10) || 20);
    const result = await d365.getListOptional(PAYROLL, {
      select: BASE_SELECT, optionalSelect: OPT_SELECT,
      filter: filters.join(' and ') || undefined,
      orderby: 'hr_year desc,hr_month desc',
      top: pageNum * lim,
    });
    const pageData = (result.data || []).slice((pageNum - 1) * lim);
    res.json(labelsForList('hr_hrpayrolls', { data: pageData, count: result.count }));
  } catch (err) { next(err); }
});

// POST /generate  — generate DRAFT payroll for a month (HR). Idempotent: updates an
// existing DRAFT, skips already-approved/released rows.
async function generatePayroll(req, res, next) {
  try {
    const { month, year, employeeIds } = req.body;
    if (!month || !year) return res.status(400).json({ error: 'month and year are required.' });

    const filter = employeeIds?.length
      ? employeeIds.map(id => `hr_hremployeeid eq '${id}'`).join(' or ')
      : `hr_status eq ${toValue('hr_employee_status', 'active')}`;
    const { data: employees } = await d365.getList(E.employee, {
      select: 'hr_hremployeeid,hr_hremployee1,hr_salary,hr_allowances,hr_deductions',
      filter,
    });

    const draft = toValue('hr_payroll_status', 'draft');
    let created = 0, updated = 0, skipped = 0;
    for (const emp of employees) {
      const basic = emp.hr_salary || 0;
      const allowances = emp.hr_allowances || 0;
      const fixedDeductions = emp.hr_deductions || 0;
      const att = await attendanceFacts(emp.hr_hremployeeid, month, year);
      const c = computePayroll({ basic, allowances, fixedDeductions, salaryWorkingDays: att.workingDays, lopDays: att.lopDays, overtimeHours: att.overtimeHours });

      const record = {
        hr_month: month, hr_year: year,
        hr_basic: round2(basic), hr_allowances: round2(allowances),
        hr_deductions: c.totalDeductions, hr_netpay: c.netSalary,
        hr_gross: Math.round(c.grossSalary), hr_overtime: Math.round(c.overtimePay), hr_lop: Math.round(c.lopDeduction),
        hr_presentdays: att.presentDays, hr_absentdays: att.absentDays,
        hr_workingdays: att.workingDays, hr_paydays: Math.round(c.payableDays),
        hr_status: draft, hr_processeddate: new Date().toISOString(),
      };

      // Upsert: one payroll row per employee/month/year.
      const existing = await d365.getList(PAYROLL, {
        select: 'hr_hrpayrollid,hr_status',
        filter: `_hr_hremployee_value eq '${emp.hr_hremployeeid}' and hr_month eq ${month} and hr_year eq ${year}`,
        top: 1,
      });
      const row = existing.data?.[0];
      if (row) {
        // Don't overwrite an approved/released payroll.
        if (row.hr_status !== draft) { skipped++; continue; }
        await updateOpt(row.hr_hrpayrollid, record);
        updated++;
      } else {
        await createOpt({ 'hr_hremployee@odata.bind': `/hr_hremployees(${emp.hr_hremployeeid})`, ...record });
        created++;
      }
    }
    broadcast('payroll:processed', { month: `${month}/${year}`, count: created + updated });
    res.json({ message: `Payroll generated for ${created + updated} employees (${skipped} already finalised skipped)`, created, updated, skipped, count: created + updated });
  } catch (err) { next(err); }
}
payrollRouter.post('/generate', requireRole('super_admin', 'hr_manager'), generatePayroll);
payrollRouter.post('/process', requireRole('super_admin', 'hr_manager'), generatePayroll);   // backward-compat alias

// PATCH /:id/approve  — approve payroll → status 'processed' + email the payslip
payrollRouter.patch('/:id/approve', requireRole('super_admin', 'hr_manager'), async (req, res, next) => {
  try {
    const payroll = await d365.getByIdOptional(PAYROLL, req.params.id, { select: BASE_SELECT, optionalSelect: OPT_SELECT });
    const empId = payroll._hr_hremployee_value;
    const employee = empId ? await d365.getByIdOptional(E.employee, empId, {
      select: 'hr_hremployeeid,hr_hremployee1,hr_email,hr_department,hr_designation,_hr_manager_value',
      optionalSelect: 'hr_pan,hr_aadhaar,hr_accountnumber,hr_ifsc,hr_bankname,hr_etimecode,hr_joiningdate,hr_uan,hr_pfnumber,hr_employeecode,hr_employeeid',
    }) : {};

    // Email the payslip (best-effort — never blocks approval).
    const mail = await emailPayslip({ payroll, employee });

    await updateOpt(req.params.id, {
      hr_status: toValue('hr_payroll_status', 'processed'),
      hr_approvedby: req.user?.name || req.user?.email || 'HR',
      hr_approveddate: new Date().toISOString(),
      hr_emailsent: mail.success ? 'sent' : 'failed',
      hr_emailsenttime: mail.sentAt || '',
    });
    if (empId) notifyUser(empId, 'payroll:processed', { month: `${payroll.hr_month}/${payroll.hr_year}` });
    res.json({ message: `Payroll approved${mail.success ? ' and payslip emailed' : ' (payslip email failed — will retry)'}`, emailSent: mail.success });
  } catch (err) {
    console.error('[payroll/approve] FAILED:', err.message);
    res.status(err.status || 400).json({ error: err.message || 'Failed to approve payroll' });
  }
});

// PATCH /:id/release  — release payroll → status 'paid'
payrollRouter.patch('/:id/release', requireRole('super_admin', 'hr_manager'), async (req, res, next) => {
  try {
    await updateOpt(req.params.id, {
      hr_status: toValue('hr_payroll_status', 'paid'),
      hr_releasedby: req.user?.name || req.user?.email || 'HR',
      hr_releaseddate: new Date().toISOString(),
    });
    res.json({ message: 'Payroll released' });
  } catch (err) {
    console.error('[payroll/release] FAILED:', err.message);
    res.status(err.status || 400).json({ error: err.message || 'Failed to release payroll' });
  }
});

// GET /reports/:type  — Excel reports (HR). type ∈ payroll-register, salary-register,
// attendance-register, employee-master, bank-transfer. ?year=&month=
payrollRouter.get('/reports/:type', requireRole('super_admin', 'hr_manager'), async (req, res, next) => {
  try {
    const wb = await buildReport(req.params.type, { year: Number(req.query.year) || undefined, month: Number(req.query.month) || undefined });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename=${req.params.type}_${req.query.year || 'all'}.xlsx`);
    await wb.xlsx.write(res);
    res.end();
  } catch (err) { res.status(err.status || 500).json({ error: err.message || 'Failed to generate report' }); }
});

// GET /:id/payslip  — download the payslip PDF (shared generator)
payrollRouter.get('/:id/payslip', requirePermission('payroll:read'), async (req, res, next) => {
  try {
    const payroll = await d365.getByIdOptional(PAYROLL, req.params.id, { select: BASE_SELECT, optionalSelect: OPT_SELECT });
    if (req.user.role === 'employee' && payroll._hr_hremployee_value !== req.user.id) {
      return res.status(403).json({ error: 'Access denied' });
    }
    const empId = payroll._hr_hremployee_value;
    const employee = empId ? await d365.getByIdOptional(E.employee, empId, {
      select: 'hr_hremployeeid,hr_hremployee1,hr_email,hr_department,hr_designation,_hr_manager_value',
      optionalSelect: 'hr_pan,hr_aadhaar,hr_accountnumber,hr_ifsc,hr_bankname,hr_etimecode,hr_joiningdate,hr_uan,hr_pfnumber,hr_employeecode,hr_employeeid',
    }) : {};

    const pdf = await buildPayslipPdf({ payroll, employee });
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const fname = `Payslip_${String(employee.hr_hremployee1 || 'Employee').replace(/\s+/g, '_')}_${months[(payroll.hr_month || 1) - 1]}_${payroll.hr_year}.pdf`;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename=${fname}`);
    res.end(pdf);
  } catch (err) { next(err); }
});

module.exports = payrollRouter;
