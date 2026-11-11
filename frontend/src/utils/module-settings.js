/**
 * Module ON/OFF switches (Company Settings, DB-backed) — pure helpers (no React).
 * Stored as 'true'/'false' strings like every company setting. Missing/blank
 * defaults to ON so existing installs keep every module visible.
 */
export const PAYROLL_MODULE = Object.freeze({
  key: 'hr_payrollenabled',
  label: 'Payroll Module',
  help: 'When off, Payroll, Payslips, Advances, Professional Tax, Tax Declarations and Payroll Automation are hidden and their APIs are blocked. Existing data is preserved.',
});
export const SALARY_STRUCTURE_MODULE = Object.freeze({
  key: 'hr_salarystructureenabled',
  label: 'Salary Structure Module',
  help: 'When off, the Salary Structure screen is hidden and its APIs are blocked. Payroll still uses existing structures. Existing data is preserved.',
});
export const MODULE_ENABLE_KEYS = Object.freeze([PAYROLL_MODULE.key, SALARY_STRUCTURE_MODULE.key]);

/** Truthy company-setting value → boolean. */
export function isModuleEnabled(v) {
  if (v === undefined || v === null || v === '') return true;
  return v === true || /^(true|1|yes|on)$/i.test(String(v));
}

/** Normalize the module toggle fields (string → boolean) for the form; missing/blank → ON. */
export function normalizeModuleToggles(company = {}) {
  const out = {};
  for (const k of MODULE_ENABLE_KEYS) out[k] = isModuleEnabled(company[k]);
  return out;
}
