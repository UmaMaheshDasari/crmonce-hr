// ── PAYROLL ───────────────────────────────────────────────────────
const express = require('express');
const payrollRouter = express.Router();
const d365 = require('../../services/d365.service');
const { requireRole, requirePermission, requireAnyPermission } = require('../../middleware/auth.middleware');
const { notifyPayrollProcessed, broadcast, notifyUser, sendEmail } = require('../../services/notification.service');
const { toValue, toLabel, labelsForList } = require('../../services/picklist');
const { resolveDays } = require('../../services/leave-summary.util');
const payrollDashboard = require('../../services/payroll-dashboard.service');
const { rangeCounts } = require('../../services/attendance-summary.util');
const { odStr, odInt, odGuid } = require('../../services/odata.util');
const attnCfg = require('../../services/attendance.config');
// A punch only counts toward "present" on an actual working day — a weekend/holiday
// punch must NOT inflate present days (which would erase genuine LOP).
const isWorkingDay = (ds) => { try { return !attnCfg.holidays.includes(ds) && !attnCfg.weekOffDays.includes(new Date(`${ds}T00:00:00Z`).getUTCDay()); } catch { return true; } };
const { computePayroll, round2 } = require('../../services/payroll.calc');
const { computePayrollEngine } = require('../../services/payroll-engine.calc');
const leaveEngine = require('../../services/leave-engine.service');
const advanceService = require('../../services/advance.service');
const salaryStructure = require('../../services/salary-structure.service');
const payrollSettings = require('../../services/payroll-settings.service');
const ptMaster = require('../../services/pt-master.service');
const activity = require('../../services/activity.service');
const policy = require('../../services/company.policy');
const monthlyBalance = require('../../services/monthly-balance.service');
const { buildPayslipPdf, payslipModel, computeFigures } = require('../../services/payslip.service');
const { emailPayslip } = require('../../services/payslip-notify.service');
const { buildReport } = require('../../services/payroll-reports.service');

const E = d365.constructor.entities;
const PAYROLL = E.payroll;
const pad2 = (n) => String(n).padStart(2, '0');

// Base columns always present + computed/workflow columns that may not be
// provisioned yet (selected/stored optionally so payroll works before migration).
const BASE_SELECT = 'hr_hrpayrollid,hr_month,hr_year,hr_basic,hr_allowances,hr_deductions,hr_netpay,hr_status,hr_processeddate,_hr_hremployee_value';
const OPT_SELECT = 'hr_gross,hr_overtime,hr_lop,hr_hourdeduction,hr_advance,hr_hra,hr_special,hr_medical,hr_conveyance,hr_pf,hr_professionaltax,hr_incometax,hr_presentdays,hr_absentdays,hr_workingdays,hr_paydays,hr_approvedby,hr_approveddate,hr_releasedby,hr_releaseddate,hr_emailsent,hr_emailsenttime,hr_locked,hr_lockedby,hr_lockeddate';
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

/**
 * Month facts for ONE employee, from APPROVED data only (attendance punches,
 * approved leave, approved comp-off, PT master). Implements the leave priority and
 * the LOP waterfall (spec §Leave):
 *
 *   working day → Holiday / Weekly-Off (excluded from Working Days) → Approved
 *   Leave (paid) → Present / Half Day → uncovered Absent.
 *
 * An uncovered absent day is NEVER converted straight to LOP. It becomes LOP only
 * after CL + SL + Earned + Comp Off balances are ALL exhausted; while balance is
 * still available the day is flagged "Leave Not Applied" (a warning, no deduction).
 * Pending requests never affect payroll (only approved leave is fetched).
 */
async function computeMonthFacts(empId, month, year, settings) {
  const from = `${year}-${pad2(month)}-01`;
  const lastDay = new Date(year, month, 0).getDate();
  const to = `${year}-${pad2(month)}-${pad2(lastDay)}`;
  const rc = rangeCounts(from, to);
  const workingDays = rc.working;

  // Present / Half Day from APPROVED attendance (working-day punches only).
  let presentDays = 0, halfDays = 0, overtimeHours = 0, attendanceRows = 0;
  try {
    const { data } = await d365.getList(E.attendance, {
      select: 'hr_date,hr_intime,hr_status,hr_overtime,_hr_hremployee_value',
      filter: `_hr_hremployee_value eq '${empId}' and hr_date ge '${from}' and hr_date le '${to}'`,
      top: 400,
    });
    attendanceRows = (data || []).length;
    const seen = new Set();
    for (const r of data || []) {
      const ds = String(r.hr_date || '').slice(0, 10);
      if (!ds || !isWorkingDay(ds) || seen.has(ds)) continue;
      seen.add(ds);
      overtimeHours += Number(r.hr_overtime) || 0;
      if (toLabel('hr_attendance_status', r.hr_status) === 'half_day') halfDays++;
      else if (r.hr_intime) presentDays++;
    }
  } catch { /* no attendance rows → flagged below */ }

  // Approved leave split into PAID (covered by the available balance — which already
  // has the Opening Balance folded into "used") vs LOP (approved leave that exceeded
  // the balance / explicit LOP-type leave). The Opening Balance only lowers the
  // available balance here; it is NEVER itself a leave or LOP day.
  const { paidLeaveDays, lopLeaveDays } = await leaveEngine.splitMonthLeave(empId, { year, month });

  // Balances (CL → SL → Earned → Comp Off), approved data + opening only. Shown in
  // the "Leave Not Applied" warning so HR can decide.
  const bal = await leaveEngine.getBalance(empId, year).catch(() => null);
  const earnedCfg = settings.earnedLeave || {};
  const earnedRemaining = earnedCfg.enabled ? Math.max(0, (Number(earnedCfg.allocated) || 0) - (bal?.earned?.used || 0)) : 0;
  const available = bal ? round2(bal.casual.remaining + bal.sick.remaining + earnedRemaining + bal.compOff.balance) : 0;

  // PENDING (undecided) leave — held OUT of BOTH Payable and LOP until the decision:
  // approved → becomes paid (Payable), rejected → becomes LOP. Never paid while pending,
  // never auto-LOP'd while pending.
  const pendingRaw = await leaveEngine.pendingMonthDays(empId, { year, month }).catch(() => 0);

  // ── FINAL business rule (mandatory — no on/off setting) ──
  // Payable Days = Present + ½·Half-day + Approved Paid Leave (CL/SL within cap, Comp Off,
  //   Earned/Maternity/Paternity). A Late Login keeps its punch → it is already Present
  //   (never a half-day, never LOP).
  const payDays = Math.max(0, round2(presentDays + halfDays * 0.5 + paidLeaveDays));

  // Non-payable working-day pool = Working − Payable. Pending leave is reserved from it
  // (clamped to the pool); EVERYTHING else is LOP. An absence with no approved AND no
  // pending leave is ALWAYS LOP — automatically, without waiting for an HR application.
  const uncovered = Math.max(0, round2(workingDays - payDays));
  const pendingLeaveDays = Math.min(round2(pendingRaw), uncovered);
  const lopDays = Math.max(0, round2(uncovered - pendingLeaveDays));

  const warnings = [];
  if (attendanceRows === 0) warnings.push({ code: 'attendance_missing', message: 'No attendance records exist for this month.' });
  if (workingDays === 0) warnings.push({ code: 'working_days_missing', message: 'No working days are configured for this month.' });
  if (lopDays > 0) warnings.push({
    // Code kept as `leave_not_applied` so the UI's Approve-Leave / Send-Reminder actions still fire.
    code: 'leave_not_applied', days: lopDays,
    message: available >= lopDays
      ? 'This employee has available leave balance but no approved leave request — these absent days are LOP (approve leave to reverse).'
      : 'This employee has absent days with no approved leave request — automatically LOP (approve leave or record an approved LOP to reverse).',
    balances: bal ? { casual: bal.casual.remaining, sick: bal.sick.remaining, earned: earnedRemaining, compOff: bal.compOff.balance } : null,
  });
  if (pendingLeaveDays > 0) warnings.push({
    code: 'leave_pending', days: pendingLeaveDays,
    message: 'This employee has a PENDING leave request for these days — held from LOP until decided (paid if approved, LOP if rejected).',
  });

  return {
    workingDays, presentDays, halfDays, holidays: rc.holidays, weeklyOff: rc.weeklyOff,
    approvedLeaveDays: round2(paidLeaveDays), pendingLeaveDays, compOffBalance: bal?.compOff?.balance || 0,
    absentDays: lopDays,                 // the "Absent" column == LOP (auto for unapproved absence)
    lopDays, payDays,
    overtimeHours, calendarDays: lastDay,
    warnings,
    snapshot: { workingDays, present: presentDays, halfDays, paidLeave: round2(paidLeaveDays), pendingLeave: pendingLeaveDays, lopLeave: round2(lopLeaveDays), availableBalance: available, openingFoldedIntoBalance: true },
  };
}

// GET /  — list payroll (employees scoped to their own)
payrollRouter.get('/', requireAnyPermission('payroll.view', 'payslip.view'), async (req, res, next) => {
  try {
    const { employeeId, month, year, page = 1, limit = 20 } = req.query;
    const filters = [];
    // Employees are locked to their own id; HR may pass an employeeId (validated GUID).
    const targetId = req.user.role === 'employee' ? req.user.id : employeeId;
    if (targetId) filters.push(`_hr_hremployee_value eq '${odGuid(targetId) || odStr(targetId)}'`);
    // month/year are interpolated UNQUOTED — must be integers or a crafted value could
    // break out of the self-scope (`?month=1 or hr_year eq 2025`). Validate strictly.
    const m = odInt(month); if (m !== null) filters.push(`hr_month eq ${m}`);
    const y = odInt(year); if (y !== null) filters.push(`hr_year eq ${y}`);

    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const lim = Math.max(1, parseInt(limit, 10) || 20);
    const result = await d365.getListOptional(PAYROLL, {
      select: BASE_SELECT, optionalSelect: OPT_SELECT,
      filter: filters.join(' and ') || undefined,
      orderby: 'hr_year desc,hr_month desc',
      top: pageNum * lim,
    });
    const pageData = (result.data || []).slice((pageNum - 1) * lim);
    // Attach the AUTHORITATIVE totals from the SAME engine the Payroll Detail + Payslip
    // use (computeFigures) so all three screens agree. hr_allowances / hr_deductions are
    // only the "Other" buckets — NOT the totals — so the list must never show them raw.
    for (const r of pageData) {
      const f = computeFigures(r);
      const basic = Number(r.hr_basic) || 0;
      r._basic = basic;
      r._allowances = f.gross - basic;   // total of ALL allowances (HRA/special/medical/conveyance/other/OT)
      r._deductions = f.deductions;      // PF + Professional Tax + TDS + LOP + advance + other deductions
      r._gross = f.gross;
      r._net = f.net;
    }
    res.json(labelsForList('hr_hrpayrolls', { data: pageData, count: result.count }));
  } catch (err) { next(err); }
});

// The reusable generation CORE — used by the POST /generate handler AND the
// Payroll Automation orchestrator. Idempotent: updates an existing DRAFT, skips
// locked/finalised months. Returns counts (no HTTP). Runs Attendance → Leave →
// LOP → Advance → Salary Calculation → Payroll for each employee.
async function runGeneration({ month, year, employeeIds } = {}) {
  month = odInt(month); year = odInt(year);   // never interpolate a raw month/year
  const validIds = (employeeIds || []).map(odGuid).filter(Boolean);
  const filter = validIds.length
    ? validIds.map(id => `hr_hremployeeid eq '${id}'`).join(' or ')
    : `hr_status eq ${toValue('hr_employee_status', 'active')}`;
  const { data: employees } = await d365.getListOptional(E.employee, {
    select: 'hr_hremployeeid,hr_hremployee1',   // NEVER read salary from Employee Master (spec §Salary Source)
    optionalSelect: 'hr_ptstate', filter,
  });

  // Rates come from Payroll Settings — never hardcoded (§15).
  const settings = await payrollSettings.getResolved().catch(() => payrollSettings.resolve(null));
  const asOf = `${year}-${pad2(month)}-${pad2(new Date(year, month, 0).getDate())}`;   // last day of the month
  const payrollDate = `${year}-${pad2(month)}-01`;   // the month PT slabs are resolved against
  const ptConfigured = (await ptMaster.loadActiveSlabs().catch(() => [])).length > 0;

  const draft = toValue('hr_payroll_status', 'draft');
  let created = 0, updated = 0, skipped = 0, locked = 0, noStructure = 0;
  const warnings = [];   // per-employee payroll warnings (surfaced in the UI)
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

      // ── Earnings + deductions come ONLY from the latest ACTIVE Salary Structure.
      //    Employee-Master salary is never used; no structure → warn + skip. ──
      const structure = await salaryStructure.getActiveStructure(d365, emp.hr_hremployeeid, asOf);
      if (!structure) {
        noStructure++;
        warnings.push({ employeeId: emp.hr_hremployeeid, employeeName: emp.hr_hremployee1, code: 'no_salary_structure', message: `Salary Structure not found for the payroll period (no revision effective on or before ${month}/${year}).` });
        continue;
      }
      const earnings = { basic: structure.basic, hra: structure.hra, special: structure.special, medical: structure.medical, conveyance: structure.conveyance, otherAllowance: structure.otherAllowance };
      const overrides = { pfApplicable: structure.pfApplicable, pfAmount: structure.pfAmount, professionalTax: structure.professionalTax, incomeTax: structure.incomeTax, otherDeductions: structure.otherDeductions };

      const att = await computeMonthFacts(emp.hr_hremployeeid, month, year, settings);
      const advanceRecovery = await advanceService.applyMonthlyRecovery(emp.hr_hremployeeid, { year, month });

      // ── NEW hour-based rules (from the configured effective date, by attendance MONTH). ──
      // Legacy months keep the existing day-based LOP untouched. For new-rules months:
      //   • ABSENT day (no punch, no leave) → day-based LOP (respecting Absent-Creates-LOP)
      //   • ATTENDED day shortfall → EXACT hourly deduction (monthly hour balance)
      // The two are disjoint day-sets, so an absent day is never double-counted.
      const monthStart = `${year}-${pad2(month)}-01`;
      const rules = settings.attendanceRules || {};
      const useNewRules = monthStart >= (rules.effectiveDate || policy.attendance.newRulesFrom());
      let lopDaysForEngine = att.lopDays;                 // default: legacy day-based LOP
      let hourShortageDeduction = 0, shortageHours = 0, hourlyRate = 0, monthlyHourBalance = 0;
      let presentDaysStore = att.presentDays, absentDaysStore = att.absentDays, payDaysStore = att.payDays;
      if (useNewRules && rules.enableMonthlyHourBalance !== false) {
        const bal = await monthlyBalance.buildMonthlyBalance({ employeeId: emp.hr_hremployeeid, year, month });
        monthlyHourBalance = bal.monthlyDifference; shortageHours = bal.shortageHours;
        // Absent LOP = truly-absent working days only (half/short attended days are NOT
        // day-LOP'd here — they flow through the hour balance instead).
        lopDaysForEngine = rules.absentCreatesLop !== false ? bal.absentDays : 0;
        presentDaysStore = round2(bal.presentDays + bal.halfDays * 0.5);
        absentDaysStore = lopDaysForEngine;
        payDaysStore = Math.max(0, round2(att.workingDays - lopDaysForEngine));
        if (rules.enableHourlyShortageDeduction !== false && shortageHours > 0) {
          const ded = await monthlyBalance.estimateSalaryDeduction({ employeeId: emp.hr_hremployeeid, year, month, shortageHours });
          hourShortageDeduction = Number(ded.salaryDeduction) || 0;
          hourlyRate = Number(ded.hourlyRate) || 0;
        }
      }

      // Professional Tax from the MASTER (state + gross + month). The resolved
      // amount is stored on the row, so this month's payslip is immutable even if
      // slabs change later.
      const baseGross = ['basic', 'hra', 'special', 'medical', 'conveyance', 'otherAllowance'].reduce((s, k) => s + (Number(earnings[k]) || 0), 0);
      const ptAmount = await ptMaster.getProfessionalTax(emp.hr_ptstate || settings.defaultPtState, baseGross, payrollDate);

      // Collect this employee's warnings (attendance/leave/PT/working-days).
      for (const w of att.warnings) warnings.push({ employeeId: emp.hr_hremployeeid, employeeName: emp.hr_hremployee1, ...w });
      if (!ptConfigured) warnings.push({ employeeId: emp.hr_hremployeeid, employeeName: emp.hr_hremployee1, code: 'pt_missing', message: 'Professional Tax master has no slabs — using the built-in fallback slab.' });

      // The one engine: Gross − PF − PT − TDS − LOP − Hour-Shortage − Advance − Other = Net.
      const c = computePayrollEngine({
        earnings, settings, overrides, advance: advanceRecovery, professionalTax: ptAmount,
        attendance: { salaryWorkingDays: att.workingDays, lopDays: lopDaysForEngine, calendarDays: att.calendarDays, overtimeHours: att.overtimeHours },
        hourShortageDeduction,
      });

      const record = {
        hr_month: month, hr_year: year,
        hr_basic: round2(c.basic), hr_hra: c.hra, hr_special: c.special, hr_medical: c.medical, hr_conveyance: c.conveyance,
        hr_allowances: round2(c.otherAllowance), hr_overtime: c.overtimePay, hr_gross: c.gross,
        hr_pf: c.pf, hr_professionaltax: c.professionalTax, hr_incometax: c.incomeTax,
        hr_lop: c.lop, hr_hourdeduction: round2(c.hourShortageDeduction), hr_advance: c.advance, hr_deductions: c.otherDeductions,
        hr_netpay: c.netSalary,
        // Day-count columns are Edm.Int32 — round the half-day fractions for storage
        // (LOP money is computed on the exact fractional days inside the engine).
        hr_presentdays: Math.round(presentDaysStore), hr_absentdays: Math.round(absentDaysStore),
        hr_workingdays: Math.round(att.workingDays), hr_paydays: Math.round(payDaysStore),
        hr_status: draft, hr_locked: 'false', hr_processeddate: new Date().toISOString(),
      };

      if (row) { await updateOpt(row.hr_hrpayrollid, record); updated++; }
      else { await createOpt({ 'hr_hremployee@odata.bind': `/hr_hremployees(${emp.hr_hremployeeid})`, ...record }); created++; }

      // Audit snapshot (spec §Audit): salary-structure version, attendance + leave
      // snapshot, PT amount — captured immutably at generation time.
      try {
        activity.record({
          category: 'Payroll', type: 'payroll_calculated', title: 'Payroll Calculated', name: emp.hr_hremployee1,
          meta: `${emp.hr_hremployee1}: structure ${structure.id} (eff ${structure.effectiveFrom}) · WD ${att.workingDays} P ${att.presentDays} AL ${att.approvedLeaveDays} LOP ${att.lopDays} · PT ₹${c.professionalTax} · Net ₹${c.netSalary}`,
        });
      } catch { /* audit is best-effort */ }
    }
  }
  return { created, updated, skipped, locked, noStructure, count: created + updated, warnings };
}

// POST /generate  — HTTP wrapper around runGeneration (HR).
async function generatePayroll(req, res, next) {
  try {
    const month = odInt(req.body.month), year = odInt(req.body.year);
    const { employeeIds } = req.body;
    if (month === null || year === null || month < 1 || month > 12) return res.status(400).json({ error: 'A valid month (1-12) and year are required.' });
    const r = await runGeneration({ month, year, employeeIds });
    try { activity.record({ category: 'Payroll', type: 'payroll_generated', title: 'Payroll Generated', name: req.user?.name, meta: `${req.user?.name || 'Admin'} generated payroll for ${month}/${year} — ${r.created + r.updated} employees${r.locked ? `, ${r.locked} locked skipped` : ''}${r.noStructure ? `, ${r.noStructure} without salary structure` : ''}` }); } catch {}
    broadcast('payroll:processed', { month: `${month}/${year}`, count: r.created + r.updated });
    res.json({ message: `Payroll generated for ${r.created + r.updated} employees (${r.skipped} finalised, ${r.locked} locked skipped${r.noStructure ? `, ${r.noStructure} without salary structure` : ''})`, ...r });
  } catch (err) { next(err); }
}

// POST /validate — pre-flight checks WITHOUT writing anything (spec §Validation).
// Returns readiness + the same warnings the generation would surface, so HR can
// review "Leave Not Applied" / missing structure / attendance before generating.
async function validateGeneration(req, res, next) {
  try {
    const month = odInt(req.body.month), year = odInt(req.body.year);
    if (month === null || year === null || month < 1 || month > 12) return res.status(400).json({ error: 'A valid month (1-12) and year are required.' });
    const validIds = (req.body.employeeIds || []).map(odGuid).filter(Boolean);
    const filter = validIds.length ? validIds.map(id => `hr_hremployeeid eq '${id}'`).join(' or ') : `hr_status eq ${toValue('hr_employee_status', 'active')}`;
    const { data: employees } = await d365.getListOptional(E.employee, { select: 'hr_hremployeeid,hr_hremployee1', optionalSelect: 'hr_ptstate', filter });
    const settings = await payrollSettings.getResolved().catch(() => payrollSettings.resolve(null));
    const asOf = `${year}-${pad2(month)}-${pad2(new Date(year, month, 0).getDate())}`;
    const ptConfigured = (await ptMaster.loadActiveSlabs().catch(() => [])).length > 0;

    const warnings = [];
    let ready = 0, blocked = 0, lockedCount = 0;
    for (const emp of employees) {
      const existing = await d365.getListOptional(PAYROLL, { select: 'hr_hrpayrollid', optionalSelect: 'hr_locked', filter: `_hr_hremployee_value eq '${emp.hr_hremployeeid}' and hr_month eq ${month} and hr_year eq ${year}`, top: 1 });
      if (existing.data?.[0]?.hr_locked === 'true') { lockedCount++; continue; }
      const structure = await salaryStructure.getActiveStructure(d365, emp.hr_hremployeeid, asOf);
      if (!structure) { blocked++; warnings.push({ employeeId: emp.hr_hremployeeid, employeeName: emp.hr_hremployee1, code: 'no_salary_structure', message: `Salary Structure not found for the payroll period (no revision effective on or before ${month}/${year}).` }); continue; }
      const att = await computeMonthFacts(emp.hr_hremployeeid, month, year, settings);
      for (const w of att.warnings) warnings.push({ employeeId: emp.hr_hremployeeid, employeeName: emp.hr_hremployee1, ...w });
      ready++;
    }
    if (!ptConfigured) warnings.push({ code: 'pt_missing', message: 'Professional Tax master has no slabs — the built-in fallback slab will be used.' });
    res.json({ month, year, ready, blocked, locked: lockedCount, checks: { salaryStructure: blocked === 0, professionalTax: ptConfigured }, warnings });
  } catch (err) { next(err); }
}
payrollRouter.post('/validate', requireAnyPermission('payroll.process'), validateGeneration);

// POST /remind-leave — HR reminds an employee to apply leave for absent days that
// have available balance but no approved request (the "Leave Not Applied" warning).
payrollRouter.post('/remind-leave', requireAnyPermission('payroll.process'), async (req, res, next) => {
  try {
    const employeeId = odGuid(req.body.employeeId);
    if (!employeeId) return res.status(400).json({ error: 'A valid employeeId is required.' });
    const emp = await d365.getByIdOptional(E.employee, employeeId, { select: 'hr_hremployee1,hr_email' });
    const monthLabel = req.body.month ? `${req.body.month}/${req.body.year || ''}` : 'the current month';
    try { notifyUser(employeeId, 'leave:reminder', { message: `Please apply leave for your absent days in ${monthLabel} — payroll is being processed.` }); } catch {}
    if (emp?.hr_email) await sendEmail(emp.hr_email, 'Please apply for leave', `<p>Hi ${emp.hr_hremployee1 || ''},</p><p>Our records show absent days in ${monthLabel} without an approved leave request. Please apply for leave so your attendance and payroll reflect it correctly.</p><p>Regards,<br/>CRMONCE HR Team</p>`);
    res.json({ ok: true });
  } catch (err) { next(err); }
});
payrollRouter.post('/generate', requireAnyPermission('payroll.process'), generatePayroll);
payrollRouter.post('/process', requireAnyPermission('payroll.process'), generatePayroll);   // backward-compat alias

// Finalise a month for the Automation orchestrator: approve every DRAFT row,
// email its payslip PDF and notify the employee. Idempotent — rows already
// approved are not fetched (only DRAFT), so a retry only handles what's left.
async function finalizeMonth({ month, year, employeeIds } = {}) {
  const draft = toValue('hr_payroll_status', 'draft');
  const processed = toValue('hr_payroll_status', 'processed');
  const filters = [`hr_year eq ${odInt(year)}`, `hr_month eq ${odInt(month)}`, `hr_status eq ${draft}`];
  const validIds = (employeeIds || []).map(odGuid).filter(Boolean);
  if (validIds.length) filters.push('(' + validIds.map(id => `_hr_hremployee_value eq '${id}'`).join(' or ') + ')');
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
payrollRouter.patch('/:id/approve', requireAnyPermission('payroll.process'), async (req, res, next) => {
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
payrollRouter.patch('/:id/lock', requireAnyPermission('payroll.edit'), async (req, res, next) => {
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
payrollRouter.post('/lock-month', requireAnyPermission('payroll.edit'), async (req, res, next) => {
  try {
    const month = odInt(req.body.month), year = odInt(req.body.year);
    if (month === null || year === null) return res.status(400).json({ error: 'A valid month and year are required.' });
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
payrollRouter.patch('/:id/release', requireAnyPermission('payroll.process'), async (req, res, next) => {
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
payrollRouter.get('/dashboard', requireAnyPermission('payroll.view'), async (req, res, next) => {
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
payrollRouter.get('/reports/:type', requireAnyPermission('payroll.export'), async (req, res, next) => {
  try {
    const wb = await buildReport(req.params.type, { year: Number(req.query.year) || undefined, month: Number(req.query.month) || undefined });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename=${req.params.type}_${req.query.year || 'all'}.xlsx`);
    await wb.xlsx.write(res);
    res.end();
  } catch (err) { res.status(err.status || 500).json({ error: err.message || 'Failed to generate report' }); }
});

// GET /:id/payslip  — download the payslip PDF (shared generator)
payrollRouter.get('/:id/payslip', requireAnyPermission('payroll.view', 'payslip.view'), async (req, res, next) => {
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
payrollRouter.get('/:id/payslip-data', requireAnyPermission('payroll.view', 'payslip.view'), async (req, res, next) => {
  try {
    const { payroll, employee } = await loadPayrollWithEmployee(req.params.id, req.user);
    res.json(await payslipModel({ payroll, employee }));
  } catch (err) { res.status(err.status || 500).json({ error: err.message || 'Failed to load payslip' }); }
});

// POST /:id/email  — email the payslip PDF to the employee (self or HR). The same
// document as the download, reusing the approval-email service.
payrollRouter.post('/:id/email', requireAnyPermission('payroll.view', 'payslip.view'), async (req, res, next) => {
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
module.exports.computeMonthFacts = computeMonthFacts;   // exported for unit tests (attendance → payable/LOP)
