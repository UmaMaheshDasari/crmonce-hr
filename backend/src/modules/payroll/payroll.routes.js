// ── PAYROLL ───────────────────────────────────────────────────────
const express = require('express');
const payrollRouter = express.Router();
const d365 = require('../../services/d365.service');
const { requireRole, requirePermission } = require('../../middleware/auth.middleware');
const { notifyPayrollProcessed, broadcast, notifyUser } = require('../../services/notification.service');
const { toValue, toLabel, labelsForList } = require('../../services/picklist');
const { resolveDays } = require('../../services/leave-summary.util');
const payrollDashboard = require('../../services/payroll-dashboard.service');
const { rangeCounts } = require('../../services/attendance-summary.util');
const { computePayroll, round2 } = require('../../services/payroll.calc');
const { computePayrollEngine } = require('../../services/payroll-engine.calc');
const leaveEngine = require('../../services/leave-engine.service');
const advanceService = require('../../services/advance.service');
const salaryStructure = require('../../services/salary-structure.service');
const payrollSettings = require('../../services/payroll-settings.service');
const activity = require('../../services/activity.service');
const { buildPayslipPdf, payslipModel } = require('../../services/payslip.service');
const { emailPayslip } = require('../../services/payslip-notify.service');
const { buildReport } = require('../../services/payroll-reports.service');

const E = d365.constructor.entities;
const PAYROLL = E.payroll;
const pad2 = (n) => String(n).padStart(2, '0');

// Base columns always present + computed/workflow columns that may not be
// provisioned yet (selected/stored optionally so payroll works before migration).
const BASE_SELECT = 'hr_hrpayrollid,hr_month,hr_year,hr_basic,hr_allowances,hr_deductions,hr_netpay,hr_status,hr_processeddate,_hr_hremployee_value';
const OPT_SELECT = 'hr_gross,hr_overtime,hr_lop,hr_advance,hr_hra,hr_special,hr_medical,hr_conveyance,hr_pf,hr_professionaltax,hr_incometax,hr_presentdays,hr_absentdays,hr_workingdays,hr_paydays,hr_approvedby,hr_approveddate,hr_releasedby,hr_releaseddate,hr_emailsent,hr_emailsenttime,hr_locked,hr_lockedby,hr_lockeddate';
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

  // Leave Engine splits the month's approved leave into PAID (within the annual
  // 18-day cap) vs LOP (beyond it). Excess paid-leave automatically falls into
  // lopDays via the formula below. The engine never throws — on any failure it
  // falls back to the legacy "all approved leave is paid" behaviour, so payroll
  // is never blocked. (§2/§8 — paid leave exhausted → remaining days become LOP.)
  const { paidLeaveDays } = await leaveEngine.splitMonthLeave(empId, { year, month });

  const lopDays = Math.max(0, workingDays - presentDays - paidLeaveDays);
  return { workingDays, presentDays, absentDays: lopDays, lopDays, paidLeaveDays, overtimeHours, calendarDays: lastDay };
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

// The reusable generation CORE — used by the POST /generate handler AND the
// Payroll Automation orchestrator. Idempotent: updates an existing DRAFT, skips
// locked/finalised months. Returns counts (no HTTP). Runs Attendance → Leave →
// LOP → Advance → Salary Calculation → Payroll for each employee.
async function runGeneration({ month, year, employeeIds } = {}) {
  const filter = employeeIds?.length
    ? employeeIds.map(id => `hr_hremployeeid eq '${id}'`).join(' or ')
    : `hr_status eq ${toValue('hr_employee_status', 'active')}`;
  const { data: employees } = await d365.getList(E.employee, {
    select: 'hr_hremployeeid,hr_hremployee1,hr_salary,hr_allowances,hr_deductions',
    filter,
  });

  // Rates come from Payroll Settings — never hardcoded (§15).
  const settings = await payrollSettings.getResolved().catch(() => payrollSettings.resolve(null));
  const asOf = `${year}-${pad2(month)}-${pad2(new Date(year, month, 0).getDate())}`;   // last day of the month

  const draft = toValue('hr_payroll_status', 'draft');
  let created = 0, updated = 0, skipped = 0, locked = 0;
  {
    for (const emp of employees) {
      // Skip a locked or finalised month for this employee up front.
      const existing = await d365.getListOptional(PAYROLL, {
        select: 'hr_hrpayrollid,hr_status', optionalSelect: 'hr_locked',
        filter: `_hr_hremployee_value eq '${emp.hr_hremployeeid}' and hr_month eq ${month} and hr_year eq ${year}`, top: 1,
      });
      const row = existing.data?.[0];
      if (row && row.hr_locked === 'true') { locked++; continue; }             // never regenerate locked months
      if (row && row.hr_status !== draft) { skipped++; continue; }             // don't overwrite approved/released

      // ── Earnings: from the effective Salary Structure; fall back to the
      //    Employee master (basic + lump allowances) when none exists yet. ──
      const structure = await salaryStructure.getEffectiveStructure(d365, emp.hr_hremployeeid, asOf);
      const earnings = structure
        ? { basic: structure.basic, hra: structure.hra, special: structure.special, medical: structure.medical, conveyance: structure.conveyance, otherAllowance: structure.otherAllowance }
        : { basic: emp.hr_salary || 0, otherAllowance: emp.hr_allowances || 0 };
      const overrides = structure
        ? { pfApplicable: structure.pfApplicable, pfAmount: structure.pfAmount, professionalTax: structure.professionalTax, incomeTax: structure.incomeTax, otherDeductions: structure.otherDeductions }
        : { otherDeductions: emp.hr_deductions || 0 };

      const att = await attendanceFacts(emp.hr_hremployeeid, month, year);
      const advanceRecovery = await advanceService.applyMonthlyRecovery(emp.hr_hremployeeid, { year, month });

      // The one engine: Gross − PF − PT − TDS − LOP − Advance − Other = Net.
      const c = computePayrollEngine({
        earnings, settings, overrides, advance: advanceRecovery,
        attendance: { salaryWorkingDays: att.workingDays, lopDays: att.lopDays, calendarDays: att.calendarDays, overtimeHours: att.overtimeHours },
      });

      const record = {
        hr_month: month, hr_year: year,
        hr_basic: round2(c.basic), hr_hra: c.hra, hr_special: c.special, hr_medical: c.medical, hr_conveyance: c.conveyance,
        hr_allowances: round2(c.otherAllowance), hr_overtime: c.overtimePay, hr_gross: c.gross,
        hr_pf: c.pf, hr_professionaltax: c.professionalTax, hr_incometax: c.incomeTax,
        hr_lop: c.lop, hr_advance: c.advance, hr_deductions: c.otherDeductions,
        hr_netpay: c.netSalary,
        hr_presentdays: att.presentDays, hr_absentdays: att.absentDays,
        hr_workingdays: att.workingDays, hr_paydays: Math.max(0, att.workingDays - att.lopDays),
        hr_status: draft, hr_locked: 'false', hr_processeddate: new Date().toISOString(),
      };

      if (row) { await updateOpt(row.hr_hrpayrollid, record); updated++; }
      else { await createOpt({ 'hr_hremployee@odata.bind': `/hr_hremployees(${emp.hr_hremployeeid})`, ...record }); created++; }
    }
  }
  return { created, updated, skipped, locked, count: created + updated };
}

// POST /generate  — HTTP wrapper around runGeneration (HR).
async function generatePayroll(req, res, next) {
  try {
    const { month, year, employeeIds } = req.body;
    if (!month || !year) return res.status(400).json({ error: 'month and year are required.' });
    const r = await runGeneration({ month, year, employeeIds });
    try { activity.record({ category: 'Payroll', type: 'payroll_generated', title: 'Payroll Generated', name: req.user?.name, meta: `${req.user?.name || 'Admin'} generated payroll for ${month}/${year} — ${r.created + r.updated} employees${r.locked ? `, ${r.locked} locked skipped` : ''}` }); } catch {}
    broadcast('payroll:processed', { month: `${month}/${year}`, count: r.created + r.updated });
    res.json({ message: `Payroll generated for ${r.created + r.updated} employees (${r.skipped} finalised, ${r.locked} locked skipped)`, ...r });
  } catch (err) { next(err); }
}
payrollRouter.post('/generate', requireRole('super_admin', 'hr_manager'), generatePayroll);
payrollRouter.post('/process', requireRole('super_admin', 'hr_manager'), generatePayroll);   // backward-compat alias

// Finalise a month for the Automation orchestrator: approve every DRAFT row,
// email its payslip PDF and notify the employee. Idempotent — rows already
// approved are not fetched (only DRAFT), so a retry only handles what's left.
async function finalizeMonth({ month, year, employeeIds } = {}) {
  const draft = toValue('hr_payroll_status', 'draft');
  const processed = toValue('hr_payroll_status', 'processed');
  const filters = [`hr_year eq ${year}`, `hr_month eq ${month}`, `hr_status eq ${draft}`];
  if (employeeIds?.length) filters.push('(' + employeeIds.map(id => `_hr_hremployee_value eq '${id}'`).join(' or ') + ')');
  const { data } = await d365.getListOptional(PAYROLL, { select: BASE_SELECT, optionalSelect: OPT_SELECT, filter: filters.join(' and '), top: 2000 });
  let approved = 0, emailed = 0, emailFailed = 0, notified = 0, failed = 0;
  for (const payroll of data || []) {
    try {
      const empId = payroll._hr_hremployee_value;
      const employee = empId ? await d365.getByIdOptional(E.employee, empId, {
        select: 'hr_hremployeeid,hr_hremployee1,hr_email,hr_department,hr_designation,_hr_manager_value',
        optionalSelect: 'hr_pan,hr_aadhaar,hr_accountnumber,hr_ifsc,hr_bankname,hr_etimecode,hr_joiningdate,hr_uan,hr_pfnumber,hr_employeecode,hr_employeeid',
      }) : {};
      const mail = await emailPayslip({ payroll, employee });   // builds the PDF + sends
      await updateOpt(payroll.hr_hrpayrollid, {
        hr_status: processed, hr_approvedby: 'Payroll Automation', hr_approveddate: new Date().toISOString(),
        hr_emailsent: mail.success ? 'sent' : 'failed', hr_emailsenttime: mail.sentAt || '',
      });
      approved++; if (mail.success) emailed++; else emailFailed++;
      if (empId) { try { notifyUser(empId, 'payroll:processed', { month: `${month}/${year}` }); notified++; } catch {} }
    } catch (e) { failed++; global.logger?.warn?.(`[automation] finalise row ${payroll.hr_hrpayrollid}: ${e.message}`); }
  }
  return { approved, emailed, emailFailed, notified, failed };
}

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
    try { activity.record({ category: 'Payroll', type: 'payroll_approved', title: 'Payroll Approved', name: req.user?.name, meta: `${req.user?.name || 'Admin'} approved payroll ${payroll.hr_month}/${payroll.hr_year}` }); } catch {}
    res.json({ message: `Payroll approved${mail.success ? ' and payslip emailed' : ' (payslip email failed — will retry)'}`, emailSent: mail.success });
  } catch (err) {
    console.error('[payroll/approve] FAILED:', err.message);
    res.status(err.status || 400).json({ error: err.message || 'Failed to approve payroll' });
  }
});

// PATCH /:id/lock  — lock a payroll row so it can never be regenerated (HR).
payrollRouter.patch('/:id/lock', requireRole('super_admin', 'hr_manager'), async (req, res, next) => {
  try {
    const p = await d365.getByIdOptional(PAYROLL, req.params.id, { select: 'hr_hrpayrollid,hr_month,hr_year', optionalSelect: 'hr_status' });
    await updateOpt(req.params.id, { hr_locked: 'true', hr_lockedby: req.user?.name || req.user?.email || 'HR', hr_lockeddate: new Date().toISOString() });
    try { activity.record({ category: 'Payroll', type: 'payroll_locked', title: 'Payroll Locked', name: req.user?.name, meta: `${req.user?.name || 'Admin'} locked payroll ${p.hr_month}/${p.hr_year}` }); } catch {}
    res.json({ message: 'Payroll locked — this month can no longer be regenerated.' });
  } catch (err) { res.status(err.status || 400).json({ error: err.message || 'Failed to lock payroll' }); }
});

// PATCH /:id/unlock  — unlock (Super Admin only).
payrollRouter.patch('/:id/unlock', requireRole('super_admin'), async (req, res, next) => {
  try {
    const p = await d365.getByIdOptional(PAYROLL, req.params.id, { select: 'hr_hrpayrollid,hr_month,hr_year' });
    await updateOpt(req.params.id, { hr_locked: 'false', hr_lockedby: '', hr_lockeddate: '' });
    try { activity.record({ category: 'Payroll', type: 'payroll_unlocked', title: 'Payroll Unlocked', name: req.user?.name, meta: `${req.user?.name || 'Admin'} unlocked payroll ${p.hr_month}/${p.hr_year}` }); } catch {}
    res.json({ message: 'Payroll unlocked.' });
  } catch (err) { res.status(err.status || 400).json({ error: err.message || 'Failed to unlock payroll' }); }
});

// POST /lock-month  — bulk-lock every APPROVED/PAID row for a month (HR).
payrollRouter.post('/lock-month', requireRole('super_admin', 'hr_manager'), async (req, res, next) => {
  try {
    const { month, year } = req.body;
    if (!month || !year) return res.status(400).json({ error: 'month and year are required.' });
    const processed = toValue('hr_payroll_status', 'processed');
    const paid = toValue('hr_payroll_status', 'paid');
    const { data } = await d365.getListOptional(PAYROLL, {
      select: 'hr_hrpayrollid,hr_status', optionalSelect: 'hr_locked',
      filter: `hr_month eq ${month} and hr_year eq ${year} and (hr_status eq ${processed} or hr_status eq ${paid})`,
    });
    let n = 0;
    for (const r of data || []) {
      if (r.hr_locked === 'true') continue;
      await updateOpt(r.hr_hrpayrollid, { hr_locked: 'true', hr_lockedby: req.user?.name || 'HR', hr_lockeddate: new Date().toISOString() });
      n++;
    }
    try { activity.record({ category: 'Payroll', type: 'payroll_locked', title: 'Payroll Month Locked', name: req.user?.name, meta: `${req.user?.name || 'Admin'} locked ${n} payroll rows for ${month}/${year}` }); } catch {}
    res.json({ message: `Locked ${n} payroll record(s) for ${month}/${year}.`, locked: n });
  } catch (err) { res.status(err.status || 400).json({ error: err.message || 'Failed to lock month' }); }
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

// GET /dashboard  — aggregated payroll analytics (HR). Filters: year, month,
// department, employeeId. Powers cards, charts and the status pipeline.
payrollRouter.get('/dashboard', requireRole('super_admin', 'hr_manager'), async (req, res, next) => {
  try {
    const year = Number(req.query.year) || new Date().getFullYear();
    const filters = {
      month: req.query.month ? Number(req.query.month) : undefined,
      department: req.query.department || undefined,
      employeeId: req.query.employeeId || undefined,
    };

    // Employees (active) — for the total count + department map.
    const { data: emps } = await d365.getList(E.employee, {
      select: 'hr_hremployeeid,hr_hremployee1,hr_department',
      filter: `hr_status eq ${toValue('hr_employee_status', 'active')}`, top: 5000,
    });
    const employees = (emps || []).map(e => ({ id: e.hr_hremployeeid, department: e.hr_department || 'Unassigned', name: e.hr_hremployee1 }));
    const deptOf = new Map(employees.map(e => [e.id, e.department]));

    // Payroll rows for the whole year (trends need all 12 months).
    const pr = await d365.getListOptional(PAYROLL, {
      select: BASE_SELECT, optionalSelect: OPT_SELECT, filter: `hr_year eq ${year}`, top: 5000,
    });
    const rows = (pr.data || []).map(r => ({
      month: r.hr_month, gross: r.hr_gross, net: r.hr_netpay, lop: r.hr_lop, advance: r.hr_advance,
      status: toLabel('hr_payroll_status', r.hr_status), locked: r.hr_locked === 'true',
      employeeId: r._hr_hremployee_value, department: deptOf.get(r._hr_hremployee_value),
    }));

    // Approved leaves in the year → month/days for the Leave Trend.
    let leaves = [];
    try {
      const { data } = await d365.getList(E.leave, {
        select: 'hr_days,hr_fromdate,hr_todate,hr_status,_hr_hremployee_value',
        filter: `hr_status eq ${toValue('hr_leave_status', 'approved')}`, top: 5000,
      });
      leaves = (data || [])
        .filter(l => String(l.hr_fromdate || '').slice(0, 4) === String(year))
        .map(l => ({ month: Number(String(l.hr_fromdate).slice(5, 7)) || 0, days: Number(resolveDays(l.hr_days, l.hr_fromdate, l.hr_todate)) || 0, employeeId: l._hr_hremployee_value, department: deptOf.get(l._hr_hremployee_value) }));
    } catch { /* leave trend is best-effort */ }

    res.json({ year, filters, ...payrollDashboard.aggregate({ rows, employees, leaves, filters }) });
  } catch (err) {
    console.error('[payroll/dashboard] FAILED:', err.message);
    res.status(err.status || 500).json({ error: err.message || 'Failed to load payroll dashboard' });
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

// Load a payroll row + its employee (with the 403 self-scope check). Shared by the
// payslip-data and email endpoints.
async function loadPayrollWithEmployee(id, user) {
  const payroll = await d365.getByIdOptional(PAYROLL, id, { select: BASE_SELECT, optionalSelect: OPT_SELECT });
  if (user.role === 'employee' && payroll._hr_hremployee_value !== user.id) { const e = new Error('Access denied'); e.status = 403; throw e; }
  const empId = payroll._hr_hremployee_value;
  const employee = empId ? await d365.getByIdOptional(E.employee, empId, {
    select: 'hr_hremployeeid,hr_hremployee1,hr_email,hr_department,hr_designation,_hr_manager_value',
    optionalSelect: 'hr_pan,hr_aadhaar,hr_accountnumber,hr_ifsc,hr_bankname,hr_etimecode,hr_joiningdate,hr_uan,hr_pfnumber,hr_employeecode,hr_employeeid',
  }) : {};
  return { payroll, employee };
}

// GET /:id/payslip-data  — structured payslip for the responsive on-screen view.
payrollRouter.get('/:id/payslip-data', requirePermission('payroll:read'), async (req, res, next) => {
  try {
    const { payroll, employee } = await loadPayrollWithEmployee(req.params.id, req.user);
    res.json(await payslipModel({ payroll, employee }));
  } catch (err) { res.status(err.status || 500).json({ error: err.message || 'Failed to load payslip' }); }
});

// POST /:id/email  — email the payslip PDF to the employee (self or HR). The same
// document as the download, reusing the approval-email service.
payrollRouter.post('/:id/email', requirePermission('payroll:read'), async (req, res, next) => {
  try {
    const { payroll, employee } = await loadPayrollWithEmployee(req.params.id, req.user);
    if (!employee?.hr_email) return res.status(400).json({ error: 'This employee has no email address on file.' });
    const mail = await emailPayslip({ payroll, employee });
    try { activity.record({ category: 'Payroll', type: 'payslip_emailed', title: 'Payslip Emailed', name: req.user?.name, meta: `Payslip ${payroll.hr_month}/${payroll.hr_year} emailed to ${employee.hr_hremployee1 || 'employee'}` }); } catch {}
    res.json({ success: !!mail.success, message: mail.success ? `Payslip emailed to ${employee.hr_email}` : 'Payslip email failed — please retry.' });
  } catch (err) { res.status(err.status || 500).json({ error: err.message || 'Failed to email payslip' }); }
});

module.exports = payrollRouter;
module.exports.runGeneration = runGeneration;    // reused by the Automation orchestrator
module.exports.finalizeMonth = finalizeMonth;
