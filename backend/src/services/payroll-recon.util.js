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

/**
 * Build ONE "Attendance & LOP Reconciliation" row (Sheet 4). Same attendance sources,
 * but with a stricter LOP model: PENDING leave is NOT paid — it contributes to LOP —
 * while APPROVED leave stays salary-protected (0 LOP, full Salary-Working-Day credit).
 *
 * LOP Hours = genuine-absent hours + pending-leave hours + attended-day shortage. The
 * three sets are DISJOINT (absent = no punch/no leave; pending = no punch + pending leave;
 * shortage = attended-day shortfall from buildMonthlyBalance, which already removed the
 * absent/pending day hours from its required pool) → summed with NO double counting.
 *
 * Salary Working Days = the PAID-day basis = Working Days − (LOP Hours ÷ daily required
 * hours). Approved leave carries 0 LOP so it preserves full credit; pending, absent and
 * shortage reduce it proportionally. It is a day count, never a salary amount, and is NOT
 * hardcoded to Working Days.
 *
 * @param {object} p
 * @param {string} p.employeeId
 * @param {string} p.employeeName
 * @param {{calendar:number, working:number}} p.rc
 * @param {object} p.summary                summarizeEmployee output (present/half/incomplete/inProgress/absent/effectiveHours/overtimeHours)
 * @param {number} p.approvedLeaveDays      approvedLeaveDaysWeighted (paid, 0 LOP)
 * @param {number} p.pendingLeaveDays       finalized pending-leave working days with no punch (→ LOP)
 * @param {number} p.shortageHours          buildMonthlyBalance.shortageHours (attended-day shortfall)
 * @param {number} p.fullDayHours           authoritative daily required hours (policy, default 9)
 */
function buildLopReconRow({ employeeId, employeeName, rc, summary, approvedLeaveDays, pendingLeaveDays, shortageHours, fullDayHours }) {
  const s = summary || {};
  const fd = num(fullDayHours);
  const working = num(rc.working);
  const absent = num(s.absent);                 // genuine absent (no punch, no approved, no pending)
  const pending = round2(pendingLeaveDays);     // pending leave, no punch, finalized past days
  const shortage = round2(shortageHours);       // attended-day shortfall (present partial / half / incomplete)
  const lopHours = round2(absent * fd + pending * fd + shortage);   // disjoint components → no double count
  const requiredHours = round2(working * fd);
  const salaryWorkingDays = fd > 0 ? round2(Math.max(0, working - lopHours / fd)) : working;
  return {
    employeeId,
    employeeName,
    calendarDays: num(rc.calendar),
    workingDays: working,
    presentDays: num(s.present),
    approvedLeaveDays: round2(approvedLeaveDays),   // paid — never LOP
    pendingLeaveDays: pending,                      // unpaid — drives LOP
    absentDays: absent,
    halfDays: num(s.half),
    incompleteDays: num(s.incomplete),
    inProgressDays: num(s.inProgress),
    salaryWorkingDays,                              // paid-day basis, NOT hardcoded to workingDays
    effectiveHours: round2(s.effectiveHours),
    requiredHours,
    shortageHours: shortage,                        // attended-day shortfall, SEPARATE column (also in LOP)
    lopHours,                                        // single reconciliation total
    otHours: round2(s.overtimeHours),
  };
}

/**
 * Count PENDING-leave LOP days for Sheet 4: every pending-leave working date that has NO
 * attendance record. Today is NOT excluded — a pending request is unpaid/LOP until it is
 * approved (final business rule). Attendance takes precedence: a present / incomplete /
 * in-progress record on the date means the day is Present (or handled by the attendance
 * path), never a pending-LOP day — so a day is never double-counted and an in-progress
 * attendance record creates no pending-LOP.
 *
 * @param {Iterable<[string, {status:string}]>} leaveEntries  date→{status}, already bounded
 *        to the selected month & working days (expandLeaveDays); approved wins over pending.
 * @param {(date:string)=>boolean} hasRecord  the employee's attendance-record predicate
 */
function pendingLopDayCount(leaveEntries, hasRecord) {
  let n = 0;
  for (const [date, info] of (leaveEntries || [])) {
    if (!info || info.status !== 'pending') continue;   // only pending (approved is paid)
    if (hasRecord && hasRecord(date)) continue;         // attendance precedence → not pending-LOP
    n++;
  }
  return n;
}

module.exports = { buildAttendanceRow, buildLopReconRow, lopHoursOf, pendingLopDayCount };
