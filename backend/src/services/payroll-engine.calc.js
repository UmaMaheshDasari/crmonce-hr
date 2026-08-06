/**
 * Payroll Engine — the single, pure calculation that ties every module together:
 * Salary Structure (earnings) + Payroll Settings (PF/PT/TDS rates) + Attendance/
 * Leave (LOP) + Advance recovery + Other Deductions.
 *
 *   Gross = Basic + HRA + Special + Medical + Conveyance + Other Allowance (+ OT)
 *   Net   = Gross − PF − PT − TDS − LOP − Advance − Other Deductions
 *
 * Rate precedence (nothing hardcoded): a non-zero per-employee value on the salary
 * structure OVERRIDES the global setting; otherwise the setting's rate applies.
 * Pure & unit-tested — no I/O.
 */
const { calculateProfessionalTax } = require('./professional-tax');

const round = (v) => Math.round(Number(v) || 0);
const nn = (v) => Math.max(0, Number(v) || 0);

const EARNING_KEYS = ['basic', 'hra', 'special', 'medical', 'conveyance', 'otherAllowance'];

/** Per-day salary base for LOP, per the configured LOP basis. */
function perDaySalary(gross, { lopBasis, salaryWorkingDays, calendarDays }) {
  const g = nn(gross);
  if (lopBasis === 'calendar_days') return calendarDays > 0 ? g / calendarDays : 0;
  if (lopBasis === 'fixed_30') return g / 30;
  return salaryWorkingDays > 0 ? g / salaryWorkingDays : 0;   // default: salary_working_days
}

/**
 * @param {object} p
 * @param {object} p.earnings          { basic, hra, special, medical, conveyance, otherAllowance }
 * @param {object} p.settings          resolved payroll settings (pf/professionalTax/incomeTax/lopBasis/...)
 * @param {object} [p.overrides]       per-employee salary-structure deductions (pfApplicable, pfAmount, professionalTax, incomeTax, otherDeductions)
 * @param {object} p.attendance        { salaryWorkingDays, lopDays, calendarDays, overtimeHours }
 * @param {number} [p.advance]         advance-salary recovery this month
 * @returns full itemised breakdown
 */
function computePayrollEngine({ earnings = {}, settings = {}, overrides = {}, attendance = {}, advance = 0, professionalTax: resolvedPT = null } = {}) {
  // ── Earnings ──
  const e = {};
  for (const k of EARNING_KEYS) e[k] = round(earnings[k]);
  const baseGross = EARNING_KEYS.reduce((s, k) => s + e[k], 0);

  const salaryWorkingDays = nn(attendance.salaryWorkingDays);
  const calendarDays = nn(attendance.calendarDays);
  const lopDays = nn(attendance.lopDays);
  const overtimeHours = nn(attendance.overtimeHours);

  // Overtime pay = hours × hourly rate × OT multiplier (all from settings).
  const workingHours = nn(settings.workingHoursPerDay) || 8;
  const otMultiplier = Number(settings.overtimeMultiplier) || 0;
  const perDayForOt = salaryWorkingDays > 0 ? baseGross / salaryWorkingDays : 0;
  const overtimePay = round(overtimeHours * (perDayForOt / workingHours) * otMultiplier);

  const gross = round(baseGross + overtimePay);

  // ── LOP ──
  const perDay = perDaySalary(baseGross, { lopBasis: settings.lopBasis, salaryWorkingDays, calendarDays });
  const lop = round(perDay * lopDays);

  // ── Statutory deductions (override → setting) ──
  const pfSet = settings.pf || {};
  const ptSet = settings.professionalTax || {};
  const itSet = settings.incomeTax || {};

  const pfApplicable = overrides.pfApplicable === undefined ? true : !!overrides.pfApplicable;
  let pf = 0;
  if (pfApplicable) {
    if (round(overrides.pfAmount) > 0) pf = round(overrides.pfAmount);
    else if (pfSet.applicable) {
      const ceiling = round(pfSet.wageCeiling);
      const pfWage = ceiling > 0 ? Math.min(e.basic, ceiling) : e.basic;
      pf = round(pfWage * (Number(pfSet.employeePercent) || 0) / 100);
    }
  }

  // Professional Tax: use the amount RESOLVED from the PT Master (state + gross +
  // month) when the caller provides it; otherwise the built-in slab. Never manual.
  // The settings toggle can switch PT off entirely (company policy).
  const ptApplicable = !(settings.professionalTax && settings.professionalTax.applicable === false);
  const professionalTax = !ptApplicable ? 0
    : (resolvedPT != null ? round(resolvedPT) : calculateProfessionalTax(baseGross));

  const incomeTax = round(overrides.incomeTax) > 0
    ? round(overrides.incomeTax)
    : (itSet.applicable ? round(gross * (Number(itSet.percent) || 0) / 100) : 0);

  const otherDeductions = round(overrides.otherDeductions);
  const advanceRecovery = round(advance);

  const totalDeductions = pf + professionalTax + incomeTax + lop + advanceRecovery + otherDeductions;
  const netSalary = round(gross - totalDeductions);

  return {
    ...e, overtimePay,
    gross,
    perDay: round(perDay),
    pf, professionalTax, incomeTax, lop,
    advance: advanceRecovery, otherDeductions,
    totalDeductions, netSalary,
    lopDays, salaryWorkingDays,
    pfApplicable,
  };
}

module.exports = { computePayrollEngine, perDaySalary, EARNING_KEYS };
