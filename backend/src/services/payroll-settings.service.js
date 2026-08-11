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
  // Treat an absence with NO approved leave as LOP (non-payable, deducted). ON (default):
  // Payable Days = paid attendance (Present + ½·Half-day + Paid Leave + Comp Off) and every
  // other working day is LOP. OFF: only explicitly-applied LOP (LOP-type leave + approved
  // leave beyond the paid cap) is deducted; an uncovered absence stays payable until HR
  // records leave/LOP (the legacy "flag, don't auto-deduct" behaviour).
  hr_unapprovedabsenceaslop: 'true',
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
  hr_histattendancemonths: '6',   // Historical Attendance: employees may raise requests for the last N months
  hr_gracetime: '15',             // late-login grace period (minutes after shift start)
  hr_maxlatelogins: '3',          // max approved Late Logins per employee per month before a warning
  hr_latelogindaysback: '30',     // Late Login backdated window (calendar days)
  hr_lateloginallowfuture: 'true',// allow Late Login requests for today + future dates
  hr_lateloginapprovalrequired: 'true', // manager → HR approval required (else auto-approved)
  hr_lateloginmode: 'late_present',     // attendance label for an approved late login: present | late_present
  hr_lateloginpenalty: 'false',   // FUTURE: deduct salary for excess late logins (off by default)
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
// Base = always-present columns; the value columns are OPTIONAL so a read still
// returns the row (and its id) even before every column is provisioned — otherwise
// a single missing column would throw, hide the row id, and force the save onto the
// CREATE path (duplicate rows / never updates → "not saving").
const BASE_SELECT = 'hr_payrollsettingid,hr_name';
const OPT_SELECT = FIELDS.filter((f) => f !== 'hr_name').join(',');

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

const isPresent = (v) => v !== undefined && v !== null && v !== '';

/**
 * Resolve a settings row with the CORRECT priority:
 *
 *   latest database column  >  JSON blob (hr_settingsjson)  >  defaults
 *
 * A populated database column ALWAYS wins. The JSON blob only FILLS fields whose
 * column is absent/empty (e.g. a column that isn't provisioned yet). An older blob
 * value must NEVER overwrite a live column. Applies uniformly to every setting
 * (PF, Professional Tax, Default Allowances/Deductions, Late Login, Comp Off,
 * Leave, …) because they all flow through here. Pure.
 */
function mergeSaved(row = {}) {
  const r = { ...row };
  if (isPresent(r.hr_settingsjson)) {
    try {
      const blob = JSON.parse(r.hr_settingsjson);
      if (blob && typeof blob === 'object') {
        for (const f of FIELDS) {
          if (!isPresent(r[f]) && isPresent(blob[f])) r[f] = blob[f];   // blob fills ONLY missing columns
        }
      }
    } catch { /* corrupt blob → columns/defaults only */ }
  }
  return merge(r);
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
    unapprovedAbsenceAsLop: bool(g.hr_unapprovedabsenceaslop),   // absence with no approved leave → LOP (default ON)
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
    // Historical Attendance: how many months back an employee may raise a request.
    historicalAttendance: { monthsBack: num(g.hr_histattendancemonths, 6) },
    lateLogin: {
      graceMinutes: num(g.hr_gracetime, 15),
      maxPerMonth: num(g.hr_maxlatelogins, 3),
      backdatedDays: num(g.hr_latelogindaysback, 30),
      allowFuture: bool(g.hr_lateloginallowfuture),
      approvalRequired: bool(g.hr_lateloginapprovalrequired),
      attendanceMode: (g.hr_lateloginmode === 'present' ? 'present' : 'late_present'),
      penaltyEnabled: bool(g.hr_lateloginpenalty),   // future payroll deduction hook
    },
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
  // Resilient read: select id + name + the JSON blob + every value column. If a
  // column isn't provisioned yet (e.g. a newly-added field), strip ONLY that column
  // and retry — so we still get every EXISTING column AND the blob. (getListOptional
  // is all-or-nothing: one missing column would drop it to base-only, losing every
  // value AND the blob, which made getSettings return defaults — the read bug.)
  let cols = ['hr_payrollsettingid', 'hr_name', 'hr_settingsjson', ...FIELDS.filter((f) => f !== 'hr_name')];
  for (let i = 0; i <= cols.length; i++) {
    try {
      const { data } = await d365.getList(ENTITY_SET, { select: cols.join(','), top: 1, orderby: 'createdon asc' });
      row = (data && data[0]) || {};
      break;
    } catch (err) {
      if (d365._isMissingProperty?.(err)) {
        const prop = d365._missingPropertyName?.(err);
        if (prop && cols.includes(prop)) { cols = cols.filter((c) => c !== prop); continue; }   // drop only the missing column
      }
      break;   // table missing / other error → defaults (row stays {})
    }
  }
  // Priority: latest database column > JSON blob > defaults (a live column wins).
  cache = mergeSaved(row);
  cacheAt = now;
  return cache;
}

/** Convenience: typed config in one call. */
async function getResolved() { return resolve(await getSettings()); }

module.exports = {
  getSettings, getResolved, resolve, merge, mergeSaved, invalidate,
  PAYROLL_SETTINGS_DEFAULTS, FIELDS, JSON_FIELDS, ENTITY_SET, SELECT,
};
