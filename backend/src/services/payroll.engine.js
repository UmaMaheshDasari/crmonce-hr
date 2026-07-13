/**
 * Payroll Engine — produces ONLY salary-related classifications.
 * Reads ONLY payroll settings from the Company Policy layer.
 * Pure functions (no D365, no I/O) → fully unit-testable and reusable.
 *
 * Company leave policy (derived, NOT stored — resets every calendar month):
 *   first N approved leaves of the month  → Paid Leave   (N = policy.monthlyPaidLeave)
 *   the rest                              → LOP (Loss Of Pay)
 * No yearly balance, no carry-forward, no accumulation.
 */
const policy = require('./company.policy');

/**
 * Classify a month's APPROVED leaves into Paid vs LOP.
 * @param leaves array of { id, from:'YYYY-MM-DD', days:number } — already filtered
 *               to the target calendar month by the caller.
 */
function classifyMonthlyLeaves(leaves = []) {
  const paidBudget = policy.payroll.monthlyPaidLeave();
  const ordered = [...leaves]
    .filter(Boolean)
    .sort((a, b) => String(a.from || '').localeCompare(String(b.from || '')));

  let paidLeaves = 0, lopLeaves = 0, paidDays = 0, lopDays = 0;
  const items = ordered.map((lv, i) => {
    const days = Number(lv.days) || 0;
    const kind = i < paidBudget ? 'paid' : 'lop';
    if (kind === 'paid') { paidLeaves++; paidDays += days; } else { lopLeaves++; lopDays += days; }
    return { id: lv.id, from: lv.from, days, kind };
  });

  return { paidBudget, paidLeaves, lopLeaves, paidDays, lopDays, items };
}

/** Dashboard-facing monthly leave summary (dynamic; auto-resets by month). */
function monthlyLeaveSummary(leaves = []) {
  const c = classifyMonthlyLeaves(leaves);
  return {
    monthlyPaidLeave: c.paidBudget,
    paidLeaveUsed:    c.paidLeaves,
    paidLeaveRemaining: Math.max(0, c.paidBudget - c.paidLeaves),
    lopDays:          c.lopDays,
    approvedLeaveDays: c.paidDays + c.lopDays,
  };
}

/**
 * Resolve compensation from ATTENDANCE FACTS (never mutates attendance).
 * facts: { lateArrivalMin, earlyDepartureMin, metRequiredHours }
 */
function resolveCompensation(facts = {}) {
  const late = facts.lateArrivalMin || 0;
  const early = facts.earlyDepartureMin || 0;
  const hadDeviation = late > 0 || early > 0;

  if (!hadDeviation) return { status: 'on_time', deductLate: false };
  if (policy.payroll.compensationEnabled() && facts.metRequiredHours) {
    return { status: 'compensated', deductLate: false };            // completed required hours → no deduction
  }
  return { status: 'shortfall', deductLate: late > 0 && policy.payroll.lateDeductionEnabled() };
}

/** Lunch/break deduction — OFF unless explicitly enabled (breaks are informational). */
function lunchDeductionApplies() {
  return policy.payroll.lunchDeductionEnabled();
}

module.exports = { classifyMonthlyLeaves, monthlyLeaveSummary, resolveCompensation, lunchDeductionApplies };
