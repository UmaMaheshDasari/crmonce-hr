/**
 * Monthly Attendance report row builder (Excel Sheet 3).
 *
 * PURE — no I/O. This sheet is an ATTENDANCE reconciliation report: it carries NO
 * monetary values (no gross/net/PT/deductions — those live in the Payroll Register).
 * Every value here is attendance-derived from the authoritative calculations:
 *   • Day/hour counts — buildRangeSummary / summarizeEmployee (present, approved-leave,
 *     absent, half, incomplete, in-progress, effective & OT hours) — the same source the
 *     /stats cards and the Monthly Attendance UI use.
 *   • Shortage hours — buildMonthlyBalance (the monthly hour-balance the payroll engine
 *     itself uses); supplied by the caller so this stays pure.
 *
 * LOP Hours = genuine absent working days × full-day expected hours (the hours the
 * day-based LOP represents) — tied to the Absent Days column. Shortage Hours is the
 * attended-day working-hour shortfall, kept SEPARATE from LOP. Salary Working Days is
 * the payable-day BASIS (= the month's working days, the same value payroll uses as its
 * salaryWorkingDays divisor); it is a day count, NOT a salary amount, and approved leave
 * never reduces it.
 */

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const round2 = (v) => Math.round((num(v) + Number.EPSILON) * 100) / 100;

/** LOP is day-based (absent working days) → its hour equivalent is lopDays × full-day hours. */
function lopHoursOf(lopDays, fullDayHours) {
  return round2(num(lopDays) * num(fullDayHours));
}

/**
 * Build ONE attendance row (raw numbers — the Excel layer formats hours). No money.
 *
 * @param {object} p
 * @param {string} p.employeeId               display id (etimecode ?? guid)
 * @param {string} p.employeeName
 * @param {{calendar:number, working:number}} p.rc
 * @param {object} p.summary                  summarizeEmployee output
 * @param {number} p.approvedLeaveDays        approvedLeaveDaysWeighted (half-day aware)
 * @param {number} p.shortageHours            monthly-balance shortageHours (0 when none)
 * @param {number} p.fullDayHours             policy full-day expected hours (9)
 */
function buildAttendanceRow({ employeeId, employeeName, rc, summary, approvedLeaveDays, shortageHours, fullDayHours }) {
  const s = summary || {};
  return {
    // 1–2 identity
    employeeId,
    employeeName,
    // 3–11 day counts
    calendarDays: num(rc.calendar),
    workingDays: num(rc.working),
    presentDays: num(s.present),
    approvedLeaveDays: round2(approvedLeaveDays),
    absentDays: num(s.absent),
    halfDays: num(s.half),
    incompleteDays: num(s.incomplete),
    inProgressDays: num(s.inProgress),
    // Salary Working Days = payable-day basis = the month's working days (approved leave
    // NOT subtracted). Same value payroll uses as salaryWorkingDays. A day count, not money.
    salaryWorkingDays: num(rc.working),
    // 12–15 hours
    effectiveHours: round2(s.effectiveHours),
    lopHours: lopHoursOf(num(s.absent), fullDayHours),   // genuine absent days × full-day hours
    shortageHours: round2(shortageHours),                 // attended-day shortfall, SEPARATE from LOP
    otHours: round2(s.overtimeHours),
  };
}

module.exports = { buildAttendanceRow, lopHoursOf };
