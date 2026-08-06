/**
 * Self-provisioning for the Advance Salary table (hr_advancesalaries) — an
 * advance request + its EMI recovery tracker. Mirrors provision-goal.js: TEXT /
 * MEMO / INTEGER columns, employee as a GUID string + denormalised name (joined
 * to the Employee master for display), idempotent, lock-aware.
 *
 *   Entity  : hr_AdvanceSalary (logical hr_advancesalary, set hr_advancesalaries)
 *   Primary : hr_Name
 *
 * The monthly recovery ledger is stored as JSON on hr_RecoverySchedule
 * ([{period:'YYYY-MM', amount}]) — one table, idempotent recovery.
 */
const axios = require('axios');
const d365 = require('./d365.service');

const ENTITY_LOGICAL = 'hr_advancesalary';
const ENTITY_SCHEMA = 'hr_AdvanceSalary';
const ENTITY_SET = 'hr_advancesalaries';

const label = (t) => ({ '@odata.type': 'Microsoft.Dynamics.CRM.Label', LocalizedLabels: [{ '@odata.type': 'Microsoft.Dynamics.CRM.LocalizedLabel', Label: t, LanguageCode: 1033 }] });
const req = () => ({ Value: 'None', CanBeChanged: true, ManagedPropertyLogicalName: 'canmodifyrequirementlevelsettings' });
const str = (schema, display, maxLength = 100) => ({
  '@odata.type': 'Microsoft.Dynamics.CRM.StringAttributeMetadata',
  SchemaName: schema, MaxLength: maxLength, FormatName: { Value: 'Text' }, RequiredLevel: req(), DisplayName: label(display), Description: label(display),
});
const memo = (schema, display, maxLength = 4000) => ({
  '@odata.type': 'Microsoft.Dynamics.CRM.MemoAttributeMetadata',
  SchemaName: schema, MaxLength: maxLength, Format: 'Text', RequiredLevel: req(), DisplayName: label(display), Description: label(display),
});
const int = (schema, display, minValue = 0, maxValue = 1000000000) => ({
  '@odata.type': 'Microsoft.Dynamics.CRM.IntegerAttributeMetadata',
  SchemaName: schema, Format: 'None', MinValue: minValue, MaxValue: maxValue, RequiredLevel: req(), DisplayName: label(display), Description: label(display),
});

const COLUMNS = [
  str('hr_EmployeeId', 'Employee Id', 100),
  str('hr_EmployeeName', 'Employee Name', 200),
  int('hr_Amount', 'Advance Amount'),
  memo('hr_Reason', 'Reason', 2000),
  str('hr_RequestedDate', 'Requested Date', 10),
  int('hr_EMI', 'Monthly EMI'),
  str('hr_RecoverFrom', 'Recover From', 7),        // 'YYYY-MM'
  int('hr_Recovered', 'Recovered Amount'),
  memo('hr_RecoverySchedule', 'Recovery Schedule (JSON)'),
  str('hr_Status', 'Status', 20),                  // pending|approved|rejected|completed|cancelled
  str('hr_ApprovedBy', 'Approved By', 200),
  str('hr_ApprovedDate', 'Approved Date', 30),
  memo('hr_Remarks', 'Remarks', 2000),
  str('hr_CreatedBy', 'Created By', 200),
  str('hr_EmailSent', 'Email Sent', 10),
  str('hr_EmailSentTime', 'Email Sent Time', 30),
];

const ENTITY_BODY = {
  '@odata.type': 'Microsoft.Dynamics.CRM.EntityMetadata',
  SchemaName: ENTITY_SCHEMA, EntitySetName: ENTITY_SET, OwnershipType: 'UserOwned', HasActivities: false, HasNotes: false,
  DisplayName: label('Advance Salary'), DisplayCollectionName: label('Advance Salaries'),
  Description: label('Employee advance salary requests with HR approval and EMI recovery.'),
  Attributes: [{
    '@odata.type': 'Microsoft.Dynamics.CRM.StringAttributeMetadata',
    SchemaName: 'hr_Name', MaxLength: 250, FormatName: { Value: 'Text' }, IsPrimaryName: true,
    RequiredLevel: req(), DisplayName: label('Name'), Description: label('Advance request label'),
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
  try { await post(`EntityDefinitions(LogicalName='${ENTITY_LOGICAL}')/Attributes`, col); log?.info?.(`[provision] added advance column ${col.SchemaName}`); return true; }
  catch (e) { const m = e.response?.data?.error?.message || e.message; if (isExists(m)) return true; log?.warn?.(`[provision] advance column ${col.SchemaName}: ${m}`); return false; }
}

async function createSchema(log) {
  try { await post('EntityDefinitions', ENTITY_BODY); log?.info?.('[provision] created entity hr_AdvanceSalary'); }
  catch (e) { const m = e.response?.data?.error?.message || e.message; if (isExists(m)) log?.info?.('[provision] entity hr_AdvanceSalary already exists'); else if (isLocked(m)) throw Object.assign(new Error(m), { locked: true }); else throw new Error(m); }
  for (const c of COLUMNS) {
    try { await post(`EntityDefinitions(LogicalName='${ENTITY_LOGICAL}')/Attributes`, c); }
    catch (e) { const m = e.response?.data?.error?.message || e.message; if (isLocked(m)) throw Object.assign(new Error(m), { locked: true }); if (!isExists(m)) log?.warn?.(`[provision] advance column ${c.SchemaName}: ${m}`); }
  }
}

async function ensureAdvanceTable(log = console, opts = {}) {
  const { retry = false, retryIntervalMs = 30000, retryTimeoutMs = 10 * 60 * 1000 } = opts;
  try { await d365.getList(ENTITY_SET, { top: 1 }); return { status: 'exists' }; }
  catch (e) {
    const m = e.response?.data?.error?.message || e.message;
    if (!isMissing(m)) { log?.warn?.(`[provision] advance probe inconclusive (${m}); skipping`); return { status: 'unavailable', reason: m }; }
  }
  const started = Date.now();
  for (;;) {
    try { await createSchema(log); log?.info?.('[provision] hr_advancesalaries ready'); return { status: 'created' }; }
    catch (e) {
      if (e.locked && retry && Date.now() - started + retryIntervalMs <= retryTimeoutMs) {
        log?.warn?.(`[provision] advance: Dataverse locked — retrying in ${retryIntervalMs / 1000}s`);
        await sleep(retryIntervalMs); continue;
      }
      log?.warn?.(`[provision] could not auto-create hr_advancesalaries: ${e.message}`);
      return { status: e.locked ? 'locked' : 'unavailable', reason: e.message };
    }
  }
}

module.exports = { ensureAdvanceTable, addMissingColumn };
