/**
 * Payroll calculation engine (money math) — pure, no I/O, unit-testable.
 *
 * Inputs are FACTS the route assembles (salary structure + attendance):
 *   basic, allowances       — monthly salary structure (₹)
 *   fixedDeductions         — statutory/other fixed deductions (PF/PT/tax, ₹)
 *   salaryWorkingDays       — payable working days in the month (excl. week-offs/holidays)
 *   lopDays                 — Loss-of-Pay days (unpaid absence)
 *   overtimeHours           — approved overtime hours
 *   overtimeRate            — ₹ per OT hour (default: per-day / 8)
 *   lateDays, lateDeductionPerDay — late-policy deduction (optional)
 *
 * Output: gross (earned, prorated for LOP, plus OT), itemised deductions, net.
 */
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const nonNeg = (n) => Math.max(0, Number(n) || 0);

function computePayroll(facts = {}) {
  const basic = nonNeg(facts.basic);
  const allowances = nonNeg(facts.allowances);
  const fixedDeductions = nonNeg(facts.fixedDeductions);
  const salaryWorkingDays = nonNeg(facts.salaryWorkingDays);
  const lopDays = Math.min(nonNeg(facts.lopDays), salaryWorkingDays);
  const overtimeHours = nonNeg(facts.overtimeHours);
  const lateDays = nonNeg(facts.lateDays);

  const monthlyGross = round2(basic + allowances);
  // Per-day rate from the full monthly salary over the month's working days.
  const perDay = salaryWorkingDays > 0 ? monthlyGross / salaryWorkingDays : 0;
  const payableDays = round2(salaryWorkingDays - lopDays);

  // Earned salary is prorated by payable days (this is how LOP reduces pay).
  const earnedBasic = salaryWorkingDays > 0 ? round2(basic * payableDays / salaryWorkingDays) : round2(basic);
  const earnedAllowances = salaryWorkingDays > 0 ? round2(allowances * payableDays / salaryWorkingDays) : round2(allowances);

  const overtimeRate = facts.overtimeRate != null ? nonNeg(facts.overtimeRate) : round2(perDay / 8);
  const overtimePay = round2(overtimeHours * overtimeRate);

  const grossSalary = round2(earnedBasic + earnedAllowances + overtimePay);

  // LOP amount is informational (already reflected in prorated earnings — NOT
  // subtracted again, to avoid double counting).
  const lopDeduction = round2(perDay * lopDays);

  const lateDeductionPerDay = facts.lateDeductionPerDay != null ? nonNeg(facts.lateDeductionPerDay) : 0;
  const lateDeduction = round2(lateDays * lateDeductionPerDay);

  const totalDeductions = round2(fixedDeductions + lateDeduction);
  const netSalary = round2(grossSalary - totalDeductions);

  return {
    monthlyGross,
    perDay: round2(perDay),
    salaryWorkingDays: round2(salaryWorkingDays),
    payableDays,
    lopDays: round2(lopDays),
    earnedBasic,
    earnedAllowances,
    overtimeHours: round2(overtimeHours),
    overtimeRate: round2(overtimeRate),
    overtimePay,
    grossSalary,
    lopDeduction,
    lateDays: round2(lateDays),
    lateDeduction,
    fixedDeductions,
    totalDeductions,
    netSalary,
  };
}

module.exports = { computePayroll, round2 };
