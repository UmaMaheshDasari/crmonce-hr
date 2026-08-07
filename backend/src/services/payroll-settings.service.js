/**
 * Payroll Settings — the single source of truth for ALL configurable payroll
 * parameters (PF %, Professional Tax, Income Tax, LOP formula, working hours,
 * overtime rate, leave policy, default allowances/deductions).
 *
 * Nothing in the payroll engine may hardcode these numbers — every consumer
 * (calc engine, payslip, leave/LOP) reads them via getSettings()/resolve().
 * Modelled on company.service.js: one Dataverse row (hr_payrollsettings),
 * TEXT/MEMO columns, cached, merged over defaults so a value is always present.
 */
const d365 = require('./d365.service');

const ENTITY_SET = 'hr_payrollsettings';

// Sensible startup defaults for CRMONCE (OPC) PRIVATE LIMITED. Seeded once and
// used as a fallback before the table is provisioned. Admin edits win.
const PAYROLL_SETTINGS_DEFAULTS = {
  hr_name: 'Default Payroll Settings',
  // ── Provident Fund ──
  hr_pfemployeepercent: '12',      // % of PF wage (Basic, capped at ceiling)
  hr_pfemployerpercent: '12',
  hr_pfwageceiling: '15000',       // statutory PF wage ceiling (₹/month); 0 = no cap
  hr_pfapplicable: 'true',
  // ── Professional Tax (auto by the PT Master; toggle can switch it off) ──
  hr_ptamount: '200',           // legacy — no longer used (PT comes from the master)
  hr_ptapplicable: 'true',
  hr_defaultptstate: 'Andhra Pradesh',   // used when an employee has no PT state set
  // ── Income Tax (optional flat % override; slab-based TDS handled elsewhere) ──
  hr_itpercent: '0',
  hr_itapplicable: 'false',
  // ── LOP formula ──
  hr_lopbasis: 'salary_working_days',   // salary_working_days | calendar_days | fixed_30
  // ── Attendance / Overtime ──
  hr_workinghoursperday: '8',
  hr_otmultiplier: '2',            // overtime paid at N × per-hour rate
  hr_weeklyoff: 'Sunday',          // comma-separated weekday names
  // ── Leave policy (drives LOP): 18 paid/year = 12 Casual + 6 Sick, then LOP ──
  hr_paidleavesperyear: '18',
  hr_casualleaves: '12',
  hr_sickleaves: '6',
  // ── Sick-leave medical certificate policy (configurable — never hardcoded) ──
  hr_medcertrequired: 'true',     // require a certificate for longer sick leaves
  hr_medcertafterdays: '1',       // mandatory when Sick Leave days > this (i.e. 2+ days)
  // ── Comp-off policy ──
  hr_compoffexpirydays: '45',     // a comp-off credit expires N calendar days after the worked date (0 = never)
  hr_compoffautoearn: 'true',     // auto-detect comp-off when an employee works a holiday / weekly-off
  hr_compoffemployeeraise: 'true',// allow employees to raise a comp-off request themselves
  // ── Earned Leave (optional — shown on the Leave dashboard only when enabled) ──
  hr_earnedleaveenabled: 'false', // enable Earned Leave allocation + dashboard card
  hr_earnedleaves: '0',           // Earned Leave allocated per year (configurable)
  // ── Backdated leave + Late Login policy (configurable, never hardcoded) ──
  hr_maxbackdatedleavedays: '30', // employee may apply leave up to N calendar days in the past
  hr_gracetime: '15',             // late-login grace period (minutes after shift start)
  hr_maxlatelogins: '3',          // max approved Late Logins per employee per month before a warning
  // ── Default salary components applied to a new employee's Salary Structure.
  //    JSON: [{ name, type: 'percent'|'fixed', value }]. percent = % of Basic. ──
  hr_defaultallowances: JSON.stringify([
    { name: 'House Rent Allowance (HRA)', type: 'percent', value: 40 },
    { name: 'Special Allowance', type: 'percent', value: 0 },
    { name: 'Medical Allowance', type: 'fixed', value: 0 },
    { name: 'Conveyance Allowance', type: 'fixed', value: 0 },
    { name: 'Food Allowance', type: 'fixed', value: 0 },
    { name: 'Internet Allowance', type: 'fixed', value: 0 },
    { name: 'Travel Allowance', type: 'fixed', value: 0 },
    { name: 'Performance Allowance', type: 'fixed', value: 0 },
    { name: 'Other Allowance', type: 'fixed', value: 0 },
  ]),
  hr_defaultdeductions: JSON.stringify([]),
};

// Columns that hold JSON — validated on write, parsed on read.
const JSON_FIELDS = ['hr_defaultallowances', 'hr_defaultdeductions'];

const FIELDS = Object.keys(PAYROLL_SETTINGS_DEFAULTS);
const SELECT = ['hr_payrollsettingid', ...FIELDS].join(',');

let cache = null;
let cacheAt = 0;
const TTL = 5 * 60 * 1000;

function invalidate() { cache = null; cacheAt = 0; }

const num = (v, d = 0) => { const n = Number(v); return Number.isFinite(n) ? n : d; };
const bool = (v) => v === true || /^(true|yes|1|on)$/i.test(String(v ?? ''));
const parseJson = (v, fallback) => {
  if (Array.isArray(v) || (v && typeof v === 'object')) return v;
  try { const p = JSON.parse(v); return p == null ? fallback : p; } catch { return fallback; }
};

/** Merge a raw DB row over the defaults so every field is always present. */
function merge(row = {}) {
  const m = { ...PAYROLL_SETTINGS_DEFAULTS };
  for (const f of FIELDS) if (row[f] !== undefined && row[f] !== null && row[f] !== '') m[f] = row[f];
  if (row.hr_payrollsettingid) m.hr_payrollsettingid = row.hr_payrollsettingid;
  return m;
}

/**
 * Turn raw (string) settings into a typed, ready-to-use config object. This is
 * the shape the payroll engine consumes — no parsing anywhere else.
 */
function resolve(settings = null) {
  const g = merge(settings || {});
  return {
    pf: {
      employeePercent: num(g.hr_pfemployeepercent, 12),
      employerPercent: num(g.hr_pfemployerpercent, 12),
      wageCeiling: num(g.hr_pfwageceiling, 15000),
      applicable: bool(g.hr_pfapplicable),
    },
    professionalTax: { amount: num(g.hr_ptamount, 200), applicable: bool(g.hr_ptapplicable) },
    defaultPtState: g.hr_defaultptstate || 'Andhra Pradesh',
    incomeTax: { percent: num(g.hr_itpercent, 0), applicable: bool(g.hr_itapplicable) },
    lopBasis: g.hr_lopbasis || 'salary_working_days',
    workingHoursPerDay: num(g.hr_workinghoursperday, 8),
    overtimeMultiplier: num(g.hr_otmultiplier, 2),
    weeklyOff: String(g.hr_weeklyoff || 'Sunday').split(',').map(s => s.trim()).filter(Boolean),
    leavePolicy: {
      paidPerYear: num(g.hr_paidleavesperyear, 18),
      casual: num(g.hr_casualleaves, 12),
      sick: num(g.hr_sickleaves, 6),
    },
    // Sick-leave medical-certificate policy.
    medCert: { required: bool(g.hr_medcertrequired), afterDays: num(g.hr_medcertafterdays, 1) },
    // Comp-off policy.
    compOff: {
      expiryDays: num(g.hr_compoffexpirydays, 45),
      autoEarn: bool(g.hr_compoffautoearn),
      employeeRaise: bool(g.hr_compoffemployeeraise),
    },
    // Earned Leave (optional dashboard card).
    earnedLeave: { enabled: bool(g.hr_earnedleaveenabled), allocated: num(g.hr_earnedleaves, 0) },
    // Backdated leave window + Late Login policy.
    maxBackdatedLeaveDays: num(g.hr_maxbackdatedleavedays, 30),
    lateLogin: { graceMinutes: num(g.hr_gracetime, 15), maxPerMonth: num(g.hr_maxlatelogins, 3) },
    defaultAllowances: parseJson(g.hr_defaultallowances, []),
    defaultDeductions: parseJson(g.hr_defaultdeductions, []),
  };
}

/**
 * Read the payroll-settings row (merged over defaults). Cached 5 min. Never
 * throws — returns defaults if the table is not provisioned yet.
 */
async function getSettings() {
  const now = Date.now();
  if (cache && now - cacheAt < TTL) return cache;
  let row = {};
  try {
    const { data } = await d365.getListOptional(ENTITY_SET, { select: SELECT, optionalSelect: '', top: 1, orderby: 'createdon asc' });
    if (data && data[0]) row = data[0];
  } catch (_) { /* not provisioned — fall back to defaults */ }
  cache = merge(row);
  cacheAt = now;
  return cache;
}

/** Convenience: typed config in one call. */
async function getResolved() { return resolve(await getSettings()); }

module.exports = {
  getSettings, getResolved, resolve, merge, invalidate,
  PAYROLL_SETTINGS_DEFAULTS, FIELDS, JSON_FIELDS, ENTITY_SET, SELECT,
};
