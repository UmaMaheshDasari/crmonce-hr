/**
 * Self-provisioning for the Professional Tax Master (hr_ptslabs) — a configurable,
 * effective-dated slab table so PT is NEVER hardcoded (government rules change every
 * year). Seeds the current Andhra Pradesh slabs on first run. Mirrors
 * provision-advance.js: TEXT/MEMO/INTEGER columns, idempotent, lock-aware.
 *
 *   Entity  : hr_PtSlab (logical hr_ptslab, set hr_ptslabs)
 *   Primary : hr_Name  — auto label "<State> · <from>-<to> · ₹<amount>"
 */
const axios = require('axios');
const d365 = require('./d365.service');

const ENTITY_LOGICAL = 'hr_ptslab';
const ENTITY_SCHEMA = 'hr_PtSlab';
const ENTITY_SET = 'hr_ptslabs';

const label = (t) => ({ '@odata.type': 'Microsoft.Dynamics.CRM.Label', LocalizedLabels: [{ '@odata.type': 'Microsoft.Dynamics.CRM.LocalizedLabel', Label: t, LanguageCode: 1033 }] });
const req = () => ({ Value: 'None', CanBeChanged: true, ManagedPropertyLogicalName: 'canmodifyrequirementlevelsettings' });
const str = (schema, display, maxLength = 60) => ({
  '@odata.type': 'Microsoft.Dynamics.CRM.StringAttributeMetadata',
  SchemaName: schema, MaxLength: maxLength, FormatName: { Value: 'Text' }, RequiredLevel: req(), DisplayName: label(display), Description: label(display),
});
const memo = (schema, display, maxLength = 2000) => ({
  '@odata.type': 'Microsoft.Dynamics.CRM.MemoAttributeMetadata',
  SchemaName: schema, MaxLength: maxLength, Format: 'Text', RequiredLevel: req(), DisplayName: label(display), Description: label(display),
});
const int = (schema, display) => ({
  '@odata.type': 'Microsoft.Dynamics.CRM.IntegerAttributeMetadata',
  SchemaName: schema, Format: 'None', MinValue: 0, MaxValue: 1000000000, RequiredLevel: req(), DisplayName: label(display), Description: label(display),
});

const COLUMNS = [
  str('hr_State', 'State', 80),
  str('hr_EffectiveFrom', 'Effective From', 10),
  str('hr_EffectiveTo', 'Effective To', 10),   // blank = open-ended
  int('hr_SalaryFrom', 'Salary From'),
  int('hr_SalaryTo', 'Salary To'),             // 0 = no upper bound
  int('hr_Amount', 'Professional Tax'),
  str('hr_Status', 'Status', 12),              // active | inactive
  memo('hr_Remarks', 'Remarks'),
];

const ENTITY_BODY = {
  '@odata.type': 'Microsoft.Dynamics.CRM.EntityMetadata',
  SchemaName: ENTITY_SCHEMA, EntitySetName: ENTITY_SET, OwnershipType: 'UserOwned', HasActivities: false, HasNotes: false,
  DisplayName: label('Professional Tax Slab'), DisplayCollectionName: label('Professional Tax Master'),
  Description: label('Configurable, effective-dated Professional Tax slabs by state and salary band.'),
  Attributes: [{
    '@odata.type': 'Microsoft.Dynamics.CRM.StringAttributeMetadata',
    SchemaName: 'hr_Name', MaxLength: 200, FormatName: { Value: 'Text' }, IsPrimaryName: true,
    RequiredLevel: req(), DisplayName: label('Name'), Description: label('Slab label'),
  }],
};

// Default slabs seeded on first run (Andhra Pradesh — current rules).
const SEED = [
  { hr_state: 'Andhra Pradesh', hr_effectivefrom: '2020-04-01', hr_effectiveto: '', hr_salaryfrom: 0, hr_salaryto: 15000, hr_amount: 0, hr_status: 'active', hr_remarks: 'Up to ₹15,000' },
  { hr_state: 'Andhra Pradesh', hr_effectivefrom: '2020-04-01', hr_effectiveto: '', hr_salaryfrom: 15001, hr_salaryto: 20000, hr_amount: 150, hr_status: 'active', hr_remarks: '₹15,001 – ₹20,000' },
  { hr_state: 'Andhra Pradesh', hr_effectivefrom: '2020-04-01', hr_effectiveto: '', hr_salaryfrom: 20001, hr_salaryto: 0, hr_amount: 200, hr_status: 'active', hr_remarks: 'Above ₹20,000' },
];

const isExists = (m) => /already exists|duplicate|with the name|with a name|is not unique/i.test(m || '');
const isMissing = (m) => /Could not find|does not exist|Resource not found|was not found|404/i.test(m || '');
const isLocked = (m) => /CustomizationLockException|customization is already running|another EntityCustomization|another customization/i.test(m || '');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function post(path, body) { const headers = await d365.getHeaders({ 'Content-Type': 'application/json' }); return axios.post(`${d365.baseUrl}/${path}`, body, { headers }); }

async function createSchema(log) {
  try { await post('EntityDefinitions', ENTITY_BODY); log?.info?.('[provision] created entity hr_PtSlab'); }
  catch (e) { const m = e.response?.data?.error?.message || e.message; if (isExists(m)) log?.info?.('[provision] entity hr_PtSlab already exists'); else if (isLocked(m)) throw Object.assign(new Error(m), { locked: true }); else throw new Error(m); }
  for (const c of COLUMNS) {
    try { await post(`EntityDefinitions(LogicalName='${ENTITY_LOGICAL}')/Attributes`, c); }
    catch (e) { const m = e.response?.data?.error?.message || e.message; if (isLocked(m)) throw Object.assign(new Error(m), { locked: true }); if (!isExists(m)) log?.warn?.(`[provision] pt-slab column ${c.SchemaName}: ${m}`); }
  }
}

async function seedDefaults(log) {
  try {
    const { data } = await d365.getList(ENTITY_SET, { select: 'hr_ptslabid', top: 1 });
    if (data && data.length) { log?.info?.('[provision] PT master already seeded'); return; }
    for (const s of SEED) {
      const name = `${s.hr_state} · ${s.hr_salaryfrom}-${s.hr_salaryto || '∞'} · ₹${s.hr_amount}`;
      await d365.create(ENTITY_SET, { hr_name: name, ...s }).catch((e) => log?.warn?.(`[provision] PT seed row: ${e.message}`));
    }
    log?.info?.('[provision] seeded default PT slabs (Andhra Pradesh)');
  } catch (e) { log?.warn?.(`[provision] PT seed skipped: ${e.message}`); }
}

async function ensurePtSlabTable(log = console, opts = {}) {
  const { retry = false, retryIntervalMs = 30000, retryTimeoutMs = 10 * 60 * 1000 } = opts;
  try { await d365.getList(ENTITY_SET, { top: 1 }); await seedDefaults(log); return { status: 'exists' }; }
  catch (e) {
    const m = e.response?.data?.error?.message || e.message;
    if (!isMissing(m)) { log?.warn?.(`[provision] pt-slab probe inconclusive (${m}); skipping`); return { status: 'unavailable', reason: m }; }
  }
  const started = Date.now();
  for (;;) {
    try { await createSchema(log); await seedDefaults(log); log?.info?.('[provision] hr_ptslabs ready'); return { status: 'created' }; }
    catch (e) {
      if (e.locked && retry && Date.now() - started + retryIntervalMs <= retryTimeoutMs) {
        log?.warn?.(`[provision] pt-slab: Dataverse locked — retrying in ${retryIntervalMs / 1000}s`);
        await sleep(retryIntervalMs); continue;
      }
      log?.warn?.(`[provision] could not auto-create hr_ptslabs: ${e.message}`);
      return { status: e.locked ? 'locked' : 'unavailable', reason: e.message };
    }
  }
}

module.exports = { ensurePtSlabTable, seedDefaults, SEED };
