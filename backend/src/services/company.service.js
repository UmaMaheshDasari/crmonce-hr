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
  hr_cin: 'U72900AP2020OPC115113',
  hr_companytype: 'One Person Company (OPC), Private Limited',
  hr_incorporationdate: '2020-07-25',
  hr_roc: 'Vijayawada',
  hr_addressline: 'Kodurupadu, Nellore, Andhra Pradesh 524314',
  hr_city: 'Nellore',
  hr_state: 'Andhra Pradesh',
  hr_pincode: '524314',
  hr_authorizedcapital: '100000',
  hr_paidupcapital: '10000',
  hr_director: 'Umamaheswaraiah Dasari',
  hr_business: 'IT Consulting; Microsoft Dynamics 365; Power Platform; Azure; CRM Solutions; Computer Related Services',
  hr_email: 'info@crmonce.com',
  hr_phone: '',
  hr_website: 'https://www.crmonce.com',
  hr_logourl: '/crmonce-logo.png',   // served from the frontend public root
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

/**
 * Read the company settings row, merged over defaults so every field is always
 * present. Cached for 5 min. Never throws — returns defaults if the table is not
 * provisioned yet.
 * @returns {Promise<object>} company object (logical field keys) + id
 */
async function getCompany() {
  const now = Date.now();
  if (cache && now - cacheAt < TTL) return cache;
  let row = {};
  let id = null;
  try {
    const { data } = await d365.getListOptional(ENTITY_SET, { select: 'hr_companysettingid,' + FIELDS.join(','), optionalSelect: '', top: 1, orderby: 'createdon asc' });
    if (data && data[0]) { row = data[0]; id = data[0].hr_companysettingid; }
  } catch (_) { /* table not provisioned — fall back to defaults */ }
  const merged = { ...COMPANY_DEFAULTS };
  for (const f of FIELDS) if (row[f] !== undefined && row[f] !== null && row[f] !== '') merged[f] = row[f];
  merged.hr_companysettingid = id;
  cache = merged;
  cacheAt = now;
  return merged;
}

/** Split the one-line registered office into printable lines (for payslip/email). */
function addressLines(company) {
  const raw = company?.hr_addressline || COMPANY_DEFAULTS.hr_addressline;
  return String(raw).split(/,\s*/).map(s => s.trim()).filter(Boolean);
}

module.exports = { getCompany, invalidate, addressLines, COMPANY_DEFAULTS, FIELDS, SELECT, ENTITY_SET, LOGO_FILE };
