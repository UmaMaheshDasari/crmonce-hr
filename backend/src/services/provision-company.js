/**
 * Self-provisioning for Company Settings (hr_companysettings) + a seeded default
 * row (CRMONCE OPC details). Mirrors provision-goal.js: TEXT/MEMO columns only,
 * idempotent, lock-aware (CustomizationLockException retried on startup).
 *
 *   Entity  : hr_CompanySetting (logical hr_companysetting, set hr_companysettings)
 *   Primary : hr_Name  — Company Name
 *   Columns : CIN, CompanyType, IncorporationDate, ROC, AddressLine, City, State,
 *             Pincode, AuthorizedCapital, PaidUpCapital, Director, Business,
 *             Email, Phone, Website, LogoUrl
 */
const axios = require('axios');
const d365 = require('./d365.service');
const { COMPANY_DEFAULTS } = require('./company.service');

const ENTITY_LOGICAL = 'hr_companysetting';
const ENTITY_SCHEMA = 'hr_CompanySetting';
const ENTITY_SET = 'hr_companysettings';

const label = (t) => ({ '@odata.type': 'Microsoft.Dynamics.CRM.Label', LocalizedLabels: [{ '@odata.type': 'Microsoft.Dynamics.CRM.LocalizedLabel', Label: t, LanguageCode: 1033 }] });
const req = () => ({ Value: 'None', CanBeChanged: true, ManagedPropertyLogicalName: 'canmodifyrequirementlevelsettings' });
const str = (schema, display, maxLength = 200) => ({
  '@odata.type': 'Microsoft.Dynamics.CRM.StringAttributeMetadata',
  SchemaName: schema, MaxLength: maxLength, FormatName: { Value: 'Text' }, RequiredLevel: req(), DisplayName: label(display), Description: label(display),
});
const memo = (schema, display, maxLength = 2000) => ({
  '@odata.type': 'Microsoft.Dynamics.CRM.MemoAttributeMetadata',
  SchemaName: schema, MaxLength: maxLength, Format: 'Text', RequiredLevel: req(), DisplayName: label(display), Description: label(display),
});

const COLUMNS = [
  str('hr_GSTIN', 'GSTIN', 20),
  str('hr_CIN', 'CIN', 30),
  str('hr_CompanyType', 'Company Type', 120),
  str('hr_IncorporationDate', 'Date of Incorporation', 20),
  str('hr_ROC', 'ROC', 60),
  memo('hr_AddressLine', 'Registered Office'),
  str('hr_City', 'City', 60),
  str('hr_State', 'State', 60),
  str('hr_Pincode', 'Pincode', 10),
  str('hr_AuthorizedCapital', 'Authorized Share Capital', 30),
  str('hr_PaidUpCapital', 'Paid-up Share Capital', 30),
  str('hr_Director', 'Director', 120),
  memo('hr_Business', 'Business'),
  str('hr_Email', 'Email', 120),
  str('hr_Phone', 'Phone', 20),
  str('hr_Website', 'Website', 120),
  str('hr_LogoUrl', 'Logo Url', 500),
  str('hr_RequiredDocs', 'Required Documents', 500),
];

const ENTITY_BODY = {
  '@odata.type': 'Microsoft.Dynamics.CRM.EntityMetadata',
  SchemaName: ENTITY_SCHEMA, EntitySetName: ENTITY_SET, OwnershipType: 'UserOwned', HasActivities: false, HasNotes: false,
  DisplayName: label('Company Setting'), DisplayCollectionName: label('Company Settings'),
  Description: label('Company identity — the single source of truth for company details.'),
  Attributes: [{
    '@odata.type': 'Microsoft.Dynamics.CRM.StringAttributeMetadata',
    SchemaName: 'hr_Name', MaxLength: 200, FormatName: { Value: 'Text' }, IsPrimaryName: true,
    RequiredLevel: req(), DisplayName: label('Company Name'), Description: label('Company name'),
  }],
};

const isExists = (m) => /already exists|duplicate|with the name|with a name|is not unique/i.test(m || '');
const isMissing = (m) => /Could not find|does not exist|Resource not found|was not found|404/i.test(m || '');
const isLocked = (m) => /CustomizationLockException|customization is already running|another EntityCustomization|another customization/i.test(m || '');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function post(path, body) { const headers = await d365.getHeaders({ 'Content-Type': 'application/json' }); return axios.post(`${d365.baseUrl}/${path}`, body, { headers }); }

async function addMissingColumn(logicalName, log) {
  const col = COLUMNS.find(c => c.SchemaName.toLowerCase() === String(logicalName).toLowerCase());
  if (!col) return false;
  try { await post(`EntityDefinitions(LogicalName='${ENTITY_LOGICAL}')/Attributes`, col); log?.info?.(`[provision] added company column ${col.SchemaName}`); return true; }
  catch (e) { const m = e.response?.data?.error?.message || e.message; if (isExists(m)) return true; log?.warn?.(`[provision] company column ${col.SchemaName}: ${m}`); return false; }
}

async function createSchema(log) {
  try { await post('EntityDefinitions', ENTITY_BODY); log?.info?.('[provision] created entity hr_CompanySetting'); }
  catch (e) { const m = e.response?.data?.error?.message || e.message; if (isExists(m)) log?.info?.('[provision] entity hr_CompanySetting already exists'); else if (isLocked(m)) throw Object.assign(new Error(m), { locked: true }); else throw new Error(m); }
  for (const c of COLUMNS) {
    try { await post(`EntityDefinitions(LogicalName='${ENTITY_LOGICAL}')/Attributes`, c); }
    catch (e) { const m = e.response?.data?.error?.message || e.message; if (isLocked(m)) throw Object.assign(new Error(m), { locked: true }); if (!isExists(m)) log?.warn?.(`[provision] company column ${c.SchemaName}: ${m}`); }
  }
}

/** Insert the CRMONCE default row if the table has no rows yet. Idempotent. */
async function seedDefaults(log) {
  try {
    const { data } = await d365.getList(ENTITY_SET, { select: 'hr_companysettingid', top: 1 });
    if (data && data.length) { log?.info?.('[provision] company settings already seeded'); return; }
    await d365.create(ENTITY_SET, { ...COMPANY_DEFAULTS });
    log?.info?.('[provision] seeded company settings — CRMONCE (OPC) PRIVATE LIMITED');
  } catch (e) { log?.warn?.(`[provision] company seed skipped: ${e.message}`); }
}

/**
 * @param {{retry?:boolean, retryIntervalMs?:number, retryTimeoutMs?:number}} [opts]
 * @returns {Promise<{status:'exists'|'created'|'unavailable'|'locked', reason?:string}>}
 */
async function ensureCompanyTable(log = console, opts = {}) {
  const { retry = false, retryIntervalMs = 30000, retryTimeoutMs = 10 * 60 * 1000 } = opts;
  try {
    await d365.getList(ENTITY_SET, { top: 1 });
    await seedDefaults(log);            // ensure a row exists even if the table pre-existed
    return { status: 'exists' };
  } catch (e) {
    const m = e.response?.data?.error?.message || e.message;
    if (!isMissing(m)) { log?.warn?.(`[provision] company probe inconclusive (${m}); skipping`); return { status: 'unavailable', reason: m }; }
  }
  const started = Date.now();
  for (;;) {
    try {
      await createSchema(log);
      await seedDefaults(log);
      log?.info?.('[provision] hr_companysettings ready');
      return { status: 'created' };
    } catch (e) {
      if (e.locked && retry && Date.now() - started + retryIntervalMs <= retryTimeoutMs) {
        log?.warn?.(`[provision] company: Dataverse locked — retrying in ${retryIntervalMs / 1000}s`);
        await sleep(retryIntervalMs); continue;
      }
      log?.warn?.(`[provision] could not auto-create hr_companysettings: ${e.message}`);
      return { status: e.locked ? 'locked' : 'unavailable', reason: e.message };
    }
  }
}

module.exports = { ensureCompanyTable, addMissingColumn, seedDefaults };
