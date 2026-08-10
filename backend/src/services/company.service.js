/**
 * Company Settings — the single source of truth for company identity.
 *
 * Company details (name, CIN, registered office, capital, director, …) live in
 * the hr_companysettings Dataverse table (one row). NOTHING in the app should
 * hardcode these — every module (payslip header, emails, UI) calls getCompany().
 *
 * COMPANY_DEFAULTS below is used for two things: (1) to SEED the table on first
 * provision, and (2) as a fallback so the app still renders sensible values
 * before the table is provisioned. The DB row always wins once it exists.
 */
const d365 = require('./d365.service');

const ENTITY_SET = 'hr_companysettings';

// CRMONCE (OPC) PRIVATE LIMITED — seeded once; editable via Company Settings UI.
const COMPANY_DEFAULTS = {
  hr_name: 'CRMONCE (OPC) PRIVATE LIMITED',
  hr_gstin: '37AAICC8445J1Z7',
  hr_cin: 'U72900AP2020OPC115113',
  hr_companytype: 'One Person Company (OPC), Private Limited',
  hr_incorporationdate: '2020-07-25',
  hr_roc: 'Vijayawada',
  hr_addressline: '28/1-C/8-112, Gamalapalem, Kodurupadu, Nellore, SPSR Nellore, Andhra Pradesh – 524314',
  hr_city: 'Nellore',
  hr_state: 'Andhra Pradesh',
  hr_pincode: '524314',
  hr_authorizedcapital: '100000',
  hr_paidupcapital: '10000',
  hr_director: 'Umamaheswaraiah Dasari',
  hr_business: 'IT Consulting; Microsoft Dynamics 365; Power Platform; Azure; CRM Solutions; Computer Related Services',
  hr_email: 'info@crmonce.com',
  hr_phone: '',
  hr_website: 'https://hr.crmonce.com',
  hr_logourl: '/crmonce-logo.png',   // served from the frontend public root
  // Documents that must be uploaded AND verified for a profile to reach 100%.
  hr_requireddocs: 'Aadhaar Card, PAN Card, Photo, Cancelled Cheque',
  // ── Locale / calendar (company-configurable — NEVER hard-code India/INR/IST) ──
  // These are DEFAULTS for OUR company; any customer overrides them in the UI.
  hr_country: 'India',
  hr_currency: 'INR',
  hr_currencysymbol: '₹',
  hr_timezone: 'Asia/Kolkata',
  hr_dateformat: 'DD MMM YYYY',
  hr_timeformat: '12h',              // 12h | 24h
  hr_financialyearstart: '04-01',    // MM-DD — India FY starts 1 April
  hr_leaveyearstart: '01-01',        // MM-DD — leave year (Jan–Dec)
};

// Absolute path to the bundled logo file — used by the payslip PDF (pdfkit reads
// it from disk). Kept here so nothing hardcodes the path elsewhere.
const LOGO_FILE = require('path').resolve(__dirname, '../../assets/crmonce-logo.png');

const FIELDS = Object.keys(COMPANY_DEFAULTS);
const SELECT = ['hr_companysettingid', ...FIELDS, 'createdon', 'modifiedon'].join(',');

let cache = null;
let cacheAt = 0;
const TTL = 5 * 60 * 1000;

/** Invalidate the cache (call after an update). */
function invalidate() { cache = null; cacheAt = 0; }

const isPresent = (v) => v !== undefined && v !== null && v !== '';

/**
 * Merge a raw row with the CORRECT priority: latest DB column > JSON blob
 * (hr_settingsjson) > defaults. A populated column ALWAYS wins; the blob only FILLS
 * columns that are absent/empty (e.g. a newly-added field not yet provisioned).
 * (Same rule proven for payroll-settings — never let a stale blob shadow a live
 * column.) Pure.
 */
function mergeSaved(row = {}) {
  const r = { ...row };
  if (isPresent(r.hr_settingsjson)) {
    try {
      const blob = JSON.parse(r.hr_settingsjson);
      if (blob && typeof blob === 'object') for (const f of FIELDS) if (!isPresent(r[f]) && isPresent(blob[f])) r[f] = blob[f];
    } catch { /* corrupt blob → columns/defaults only */ }
  }
  const merged = { ...COMPANY_DEFAULTS };
  for (const f of FIELDS) if (isPresent(r[f])) merged[f] = r[f];
  merged.hr_companysettingid = r.hr_companysettingid || null;
  if (r.modifiedon) merged.modifiedon = r.modifiedon;   // "Last updated" (§24)
  return merged;
}

/**
 * Read the company settings row, merged over defaults so every field is always
 * present. Cached for 5 min. Never throws — returns defaults if the table is not
 * provisioned yet. Resilient read: a not-yet-provisioned column is stripped from
 * the select and retried (never drops the whole row / the blob → defaults).
 * @returns {Promise<object>} company object (logical field keys) + id
 */
async function getCompany() {
  const now = Date.now();
  if (cache && now - cacheAt < TTL) return cache;
  let row = {};
  let cols = ['hr_companysettingid', 'hr_settingsjson', 'modifiedon', ...FIELDS];
  for (let i = 0; i <= cols.length; i++) {
    try {
      const { data } = await d365.getList(ENTITY_SET, { select: cols.join(','), top: 1, orderby: 'createdon asc' });
      row = (data && data[0]) || {};
      break;
    } catch (err) {
      if (d365._isMissingProperty?.(err)) {
        const prop = d365._missingPropertyName?.(err);
        if (prop && cols.includes(prop)) { cols = cols.filter((c) => c !== prop); continue; }
      }
      break;   // table missing / other error → defaults (row stays {})
    }
  }
  cache = mergeSaved(row);
  cacheAt = now;
  return cache;
}

/** Split the one-line registered office into printable lines (for payslip/email). */
function addressLines(company) {
  const raw = company?.hr_addressline || COMPANY_DEFAULTS.hr_addressline;
  return String(raw).split(/,\s*/).map(s => s.trim()).filter(Boolean);
}

module.exports = { getCompany, invalidate, mergeSaved, addressLines, COMPANY_DEFAULTS, FIELDS, SELECT, ENTITY_SET, LOGO_FILE };
