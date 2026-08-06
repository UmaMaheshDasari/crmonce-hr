/**
 * Self-provisioning for the HR Holiday Calendar (hr_holidays).
 *   Entity  : hr_Holiday  (set: hr_holidays)
 *   Primary : hr_Name        Text  — holiday name (e.g. "Diwali")
 *   Columns : hr_Date        Text 10  — 'YYYY-MM-DD'
 *             hr_Description  Memo
 * Text columns (Edm.String) — no option-set ints, matching the attendance-request
 * approach. Idempotent + best-effort; addMissingColumn repairs a partial schema.
 */
const axios = require('axios');
const d365 = require('./d365.service');

const ENTITY_LOGICAL = 'hr_holiday';
const ENTITY_SCHEMA = 'hr_Holiday';
const ENTITY_SET = 'hr_holidays';

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
  str('hr_Date', 'Date', 10),
  memo('hr_Description', 'Description'),
  // Historical-holiday fields (all optional; existing rows keep working).
  str('hr_Type', 'Holiday Type', 30),          // National | Festival | Company | Optional
  str('hr_Department', 'Applicable Department', 200),   // blank = all departments
  str('hr_Status', 'Status', 20),              // active | inactive
  memo('hr_Remarks', 'Remarks'),
];
const ENTITY_BODY = {
  '@odata.type': 'Microsoft.Dynamics.CRM.EntityMetadata',
  SchemaName: ENTITY_SCHEMA, EntitySetName: ENTITY_SET, OwnershipType: 'UserOwned', HasActivities: false, HasNotes: false,
  DisplayName: label('Holiday'), DisplayCollectionName: label('Holidays'), Description: label('HR-managed holiday calendar.'),
  Attributes: [{
    '@odata.type': 'Microsoft.Dynamics.CRM.StringAttributeMetadata',
    SchemaName: 'hr_Name', MaxLength: 200, FormatName: { Value: 'Text' }, IsPrimaryName: true,
    RequiredLevel: req(), DisplayName: label('Name'), Description: label('Holiday name'),
  }],
};

const isExists = (m) => /already exists|duplicate|with the name|with a name|is not unique/i.test(m || '');
const isMissing = (m) => /Could not find|does not exist|Resource not found|was not found|404/i.test(m || '');
async function post(path, body) { const headers = await d365.getHeaders({ 'Content-Type': 'application/json' }); return axios.post(`${d365.baseUrl}/${path}`, body, { headers }); }

async function addMissingColumn(logicalName, log) {
  const col = COLUMNS.find(c => c.SchemaName.toLowerCase() === String(logicalName).toLowerCase());
  if (!col) return false;
  try { await post(`EntityDefinitions(LogicalName='${ENTITY_LOGICAL}')/Attributes`, col); log?.info?.(`[provision] added holiday column ${col.SchemaName}`); return true; }
  catch (e) { const m = e.response?.data?.error?.message || e.message; if (isExists(m)) return true; log?.warn?.(`[provision] holiday column ${col.SchemaName}: ${m}`); return false; }
}

async function createSchema(log) {
  try { await post('EntityDefinitions', ENTITY_BODY); log?.info?.('[provision] created entity hr_Holiday'); }
  catch (e) { const m = e.response?.data?.error?.message || e.message; if (isExists(m)) log?.info?.('[provision] entity hr_Holiday already exists'); else throw new Error(m); }
  for (const c of COLUMNS) {
    try { await post(`EntityDefinitions(LogicalName='${ENTITY_LOGICAL}')/Attributes`, c); }
    catch (e) { const m = e.response?.data?.error?.message || e.message; if (!isExists(m)) log?.warn?.(`[provision] holiday column ${c.SchemaName}: ${m}`); }
  }
}

async function ensureHolidayTable(log = console) {
  try { await d365.getList(ENTITY_SET, { top: 1 }); return { status: 'exists' }; }
  catch (e) { const m = e.response?.data?.error?.message || e.message; if (!isMissing(m)) return { status: 'unavailable', reason: m }; }
  try { await createSchema(log); log?.info?.('[provision] hr_holidays ready'); return { status: 'created' }; }
  catch (e) { log?.warn?.(`[provision] could not auto-create hr_holidays: ${e.message}`); return { status: 'unavailable', reason: e.message }; }
}

module.exports = { ensureHolidayTable, addMissingColumn };
