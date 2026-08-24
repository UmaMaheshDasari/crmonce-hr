/**
 * Company Policy — the SINGLE SOURCE OF TRUTH for configurable company rules.
 *
 * Read-namespaced so each engine only sees its own concerns:
 *   companyPolicy.attendance.*  → Attendance Engine (thresholds only)
 *   companyPolicy.payroll.*     → Payroll Engine (money rules only)
 *
 * Source abstraction: values come from a PROVIDER. Today it's env vars; moving
 * to a database settings table later means implementing one DbProvider and
 * calling setProvider(db) — NO changes to any reader. Getters stay synchronous
 * via an in-memory cache (call reload() when settings change).
 */
const round2 = (n) => Math.round(n * 100) / 100;

const DEFAULTS = {
  monthlyPaidLeave:      1,      // paid leave RECORDS per calendar month (rest = LOP)
  requiredShiftHours:    null,   // null → use the shift's own duration
  halfDayThreshold:      null,   // null → shift duration / 2 (legacy; superseded by fullDay/halfDayMinHours)
  // Daily attendance classification (fixed worked-hour rules — NOT office timings;
  // the employee shift still governs late/early/overtime). Effective hours decide:
  //   >= fullDayMinHours → Full Day (present) ; >= halfDayMinHours and below full → Half Day.
  fullDayMinHours:       7,      // effective hours >= this → Full Day
  halfDayMinHours:       5,      // effective hours in [this, fullDay) → Half Day; below → existing handling
  fullDayExpectedHours:  9,      // hours a Full Day is expected to have contributed (monthly prep)
  halfDayExpectedHours:  5,      // hours a Half Day is expected to have contributed (monthly prep)
  // EFFECTIVE DATE for the hour-based rules (daily 7/5 classification, monthly balance,
  // carry-forward, month-end LOP). Attendance dates BEFORE this keep the legacy behaviour
  // exactly (shift/2 half-day + 'incomplete'); dates on/after it use the new rules.
  newAttendanceRulesFrom: '2026-08-01',
  overtimeAfterHours:    9,      // overtime accrues on EFFECTIVE hours beyond this (company standard)
  graceMinutes:          5,      // late is counted only AFTER this many minutes past shift start
  compensationEnabled:   true,
  lateDeductionEnabled:  false,
  lunchDeductionEnabled: false,
};

// ── Providers ──────────────────────────────────────────────────────────────
const bool = (v, d) => (v == null || v === '') ? d : ['true', '1', 'yes'].includes(String(v).toLowerCase());
const numOrNull = (v) => { const x = parseFloat(v); return Number.isFinite(x) ? x : null; };
const num = (v, d) => { const x = parseFloat(v); return Number.isFinite(x) ? x : d; };

const envProvider = {
  name: 'env',
  load() {
    return {
      monthlyPaidLeave:      num(process.env.POLICY_MONTHLY_PAID_LEAVE, DEFAULTS.monthlyPaidLeave),
      requiredShiftHours:    numOrNull(process.env.POLICY_REQUIRED_HOURS),
      halfDayThreshold:      numOrNull(process.env.POLICY_HALFDAY_HOURS),
      fullDayMinHours:       num(process.env.POLICY_FULLDAY_MIN_HOURS, DEFAULTS.fullDayMinHours),
      halfDayMinHours:       num(process.env.POLICY_HALFDAY_MIN_HOURS, DEFAULTS.halfDayMinHours),
      fullDayExpectedHours:  num(process.env.POLICY_FULLDAY_EXPECTED_HOURS, DEFAULTS.fullDayExpectedHours),
      halfDayExpectedHours:  num(process.env.POLICY_HALFDAY_EXPECTED_HOURS, DEFAULTS.halfDayExpectedHours),
      newAttendanceRulesFrom: process.env.POLICY_NEW_ATTENDANCE_RULES_FROM || DEFAULTS.newAttendanceRulesFrom,
      overtimeAfterHours:    num(process.env.POLICY_OVERTIME_AFTER_HOURS, DEFAULTS.overtimeAfterHours),
      graceMinutes:          num(process.env.POLICY_GRACE_MINUTES, DEFAULTS.graceMinutes),
      compensationEnabled:   bool(process.env.POLICY_COMPENSATION_ENABLED, DEFAULTS.compensationEnabled),
      lateDeductionEnabled:  bool(process.env.POLICY_LATE_DEDUCTION, DEFAULTS.lateDeductionEnabled),
      lunchDeductionEnabled: bool(process.env.POLICY_LUNCH_DEDUCTION, DEFAULTS.lunchDeductionEnabled),
    };
  },
};

let provider = envProvider;
let cache = null;

/** Swap the source (e.g. a future DbProvider). Providers may load() sync or seed the cache. */
function setProvider(p) { provider = p || envProvider; cache = null; }
function reload() { cache = { ...DEFAULTS, ...(provider.load ? provider.load() : {}) }; return cache; }
function settings() { return cache || reload(); }

module.exports = {
  setProvider, reload, settings,
  _defaults: DEFAULTS,
  // Attendance Engine reads ONLY these (thresholds; fall back to the shift).
  attendance: {
    requiredShiftHours: (shiftDuration) => settings().requiredShiftHours ?? shiftDuration,
    halfDayThreshold:   (shiftDuration) => settings().halfDayThreshold ?? round2(shiftDuration / 2),
    // Fixed daily worked-hour rules (Full / Half classification + expected hours).
    fullDayMinHours:      () => settings().fullDayMinHours,
    halfDayMinHours:      () => settings().halfDayMinHours,
    fullDayExpectedHours: () => settings().fullDayExpectedHours,
    halfDayExpectedHours: () => settings().halfDayExpectedHours,
    // Effective date (YYYY-MM-DD) from which the new hour-based rules apply.
    newRulesFrom:         () => settings().newAttendanceRulesFrom,
    // Overtime accrues on effective hours beyond this many hours (default 9).
    overtimeAfterHours: () => settings().overtimeAfterHours,
    // Grace window (minutes) after shift start within which a check-in is On Time.
    graceMinutes:       () => settings().graceMinutes,
  },
  // Payroll Engine reads ONLY these (money rules).
  payroll: {
    monthlyPaidLeave:      () => settings().monthlyPaidLeave,
    compensationEnabled:   () => settings().compensationEnabled,
    lateDeductionEnabled:  () => settings().lateDeductionEnabled,
    lunchDeductionEnabled: () => settings().lunchDeductionEnabled,
  },
};
