/**
 * CompanySettingsService — the ONE aggregated configuration facade (spec §21).
 *
 * It does NOT duplicate any policy: it READS the existing settings services
 * (company identity, payroll/leave/attendance policy, PT master) and returns one
 * typed config object, plus a single invalidateAll() so a save reloads everything
 * (spec §22). Business modules can read from here instead of wiring each source.
 *
 *   Company Settings ─┐
 *   Payroll Settings ─┼─▶ CompanySettingsService.getConfig() ─▶ engines / UI
 *   PT Master ────────┘
 */
const company = require('./company.service');
const payrollSettings = require('./payroll-settings.service');
let ptMaster; try { ptMaster = require('./pt-master.service'); } catch (_) { ptMaster = null; }
let celebrations; try { celebrations = require('./celebrations.service'); } catch (_) { celebrations = null; }

/** Typed company identity + locale/calendar block from the raw hr_companysettings row. */
function localeOf(c = {}) {
  return {
    name: c.hr_name || '', email: c.hr_email || '', phone: c.hr_phone || '', website: c.hr_website || '',
    logoUrl: c.hr_logourl || '', address: c.hr_addressline || '', city: c.hr_city || '', state: c.hr_state || '', pincode: c.hr_pincode || '',
    country: c.hr_country || 'India',
    currency: c.hr_currency || 'INR',
    currencySymbol: c.hr_currencysymbol || '₹',
    timezone: c.hr_timezone || 'Asia/Kolkata',
    dateFormat: c.hr_dateformat || 'DD MMM YYYY',
    timeFormat: c.hr_timeformat || '12h',
    financialYearStart: c.hr_financialyearstart || '04-01',
    leaveYearStart: c.hr_leaveyearstart || '01-01',
    requiredDocs: String(c.hr_requireddocs || '').split(',').map(s => s.trim()).filter(Boolean),
  };
}

/**
 * ONE aggregated, typed configuration for the whole app. Reuses the underlying
 * services (each cached) — no duplicated policy objects. Never throws.
 */
async function getConfig() {
  const [c, payroll] = await Promise.all([
    company.getCompany().catch(() => ({})),
    payrollSettings.getResolved().catch(() => payrollSettings.resolve(null)),
  ]);
  return {
    company: localeOf(c),
    // Full resolved payroll/leave/attendance policy (pf, professionalTax, incomeTax,
    // lopBasis, leavePolicy, compOff, lateLogin, historicalAttendance, earnedLeave,
    // defaultAllowances/Deductions, …).
    payroll,
    raw: { company: c },
  };
}

/** Invalidate EVERY settings cache so all modules read the latest after a save (§22). */
function invalidateAll() {
  try { company.invalidate(); } catch (_) {}
  try { payrollSettings.invalidate(); } catch (_) {}
  try { ptMaster?.invalidate?.(); } catch (_) {}
  try { celebrations?.invalidate?.(); } catch (_) {}
}

module.exports = { getConfig, invalidateAll, localeOf };
