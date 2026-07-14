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
  halfDayThreshold:      null,   // null → shift duration / 2
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
