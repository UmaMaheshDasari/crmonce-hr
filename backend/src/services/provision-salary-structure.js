/**
 * Self-provisioning for the Salary Structure table (hr_salarystructures) — an
 * effective-dated salary revision per employee. Mirrors provision-goal.js:
 * TEXT / MEMO / INTEGER columns only (the employee is stored as a GUID string in
 * hr_employeeid + denormalised hr_employeename, then joined to the Employee master
 * for display — the same proven pattern the Goals table uses). Idempotent,
 * best-effort, lock-aware (CustomizationLockException retried on startup).
 *
 *   Entity  : hr_SalaryStructure (logical hr_salarystructure, set hr_salarystructures)
 *   Primary : hr_Name  — auto-labelled "<EmployeeName> · <EffectiveFrom>"
 */
const axios = require('axios');
const d365 = require('./d365.service');

const ENTITY_LOGICAL = 'hr_salarystructure';
const ENTITY_SCHEMA = 'hr_SalaryStructure';
const ENTITY_SET = 'hr_salarystructures';

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
const int = (schema, display, minValue = 0, maxValue = 1000000000) => ({
  '@odata.type': 'Microsoft.Dynamics.CRM.IntegerAttributeMetadata',
  SchemaName: schema, Format: 'None', MinValue: minValue, MaxValue: maxValue, RequiredLevel: req(), DisplayName: label(display), Description: label(display),
});

const COLUMNS = [
  str('hr_EmployeeId', 'Employee Id', 100),
  str('hr_EmployeeName', 'Employee Name', 200),
  str('hr_EffectiveFrom', 'Effective From', 10),
  int('hr_Basic', 'Basic Salary'),
  int('hr_HRA', 'House Rent Allowance'),
  int('hr_Special', 'Special Allowance'),
  int('hr_Medical', 'Medical Allowance'),
  int('hr_Conveyance', 'Conveyance Allowance'),
  int('hr_OtherAllowance', 'Other Allowance'),
  int('hr_Gross', 'Gross Salary'),
  str('hr_PFApplicable', 'PF Applicable', 10),
  int('hr_PFAmount', 'PF Amount'),
  int('hr_ProfessionalTax', 'Professional Tax'),
  int('hr_IncomeTax', 'Income Tax (TDS)'),
  int('hr_OtherDeductions', 'Other Deductions'),
  str('hr_Status', 'Status', 20),
  memo('hr_Remarks', 'Remarks'),
  str('hr_CreatedBy', 'Created By', 200),
];

const ENTITY_BODY = {
  '@odata.type': 'Microsoft.Dynamics.CRM.EntityMetadata',
  SchemaName: ENTITY_SCHEMA, EntitySetName: ENTITY_SET, OwnershipType: 'UserOwned', HasActivities: false, HasNotes: false,
  DisplayName: label('Salary Structure'), DisplayCollectionName: label('Salary Structures'),
  Description: label('Effective-dated salary revision per employee (never overwritten — each change is a new version).'),
  Attributes: [{
    '@odata.type': 'Microsoft.Dynamics.CRM.StringAttributeMetadata',
    SchemaName: 'hr_Name', MaxLength: 250, FormatName: { Value: 'Text' }, IsPrimaryName: true,
    RequiredLevel: req(), DisplayName: label('Name'), Description: label('Salary structure label'),
  }],
};

const isExists = (m) => /already exists|duplicate|with the name|with a name|is not unique/i.test(m || '');
const isMissing = (m) => /Could not find|does not exist|Resource not found|was not found|404/i.test(m || '');
const isLocked = (m) => /CustomizationLockException|customization is already running|another EntityCustomization|another customization/i.test(m || '');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function post(path, body) { const headers = await d365.getHeaders({ 'Content-Type': 'application/json' }); return axios.post(`${d365.baseUrl}/${path}`, body, { headers }); }

/** Create a single missing column by its logical name. Repairs a partial schema. */
async function addMissingColumn(logicalName, log) {
  const col = COLUMNS.find(c => c.SchemaName.toLowerCase() === String(logicalName).toLowerCase());
  if (!col) return false;
  try { await post(`EntityDefinitions(LogicalName='${ENTITY_LOGICAL}')/Attributes`, col); log?.info?.(`[provision] added salary-structure column ${col.SchemaName}`); return true; }
  catch (e) { const m = e.response?.data?.error?.message || e.message; if (isExists(m)) return true; log?.warn?.(`[provision] salary-structure column ${col.SchemaName}: ${m}`); return false; }
}

async function createSchema(log) {
  try { await post('EntityDefinitions', ENTITY_BODY); log?.info?.('[provision] created entity hr_SalaryStructure'); }
  catch (e) { const m = e.response?.data?.error?.message || e.message; if (isExists(m)) log?.info?.('[provision] entity hr_SalaryStructure already exists'); else if (isLocked(m)) throw Object.assign(new Error(m), { locked: true }); else throw new Error(m); }
  for (const c of COLUMNS) {
    try { await post(`EntityDefinitions(LogicalName='${ENTITY_LOGICAL}')/Attributes`, c); }
    catch (e) { const m = e.response?.data?.error?.message || e.message; if (isLocked(m)) throw Object.assign(new Error(m), { locked: true }); if (!isExists(m)) log?.warn?.(`[provision] salary-structure column ${c.SchemaName}: ${m}`); }
  }
}

/**
 * @returns {Promise<{status:'exists'|'created'|'unavailable'|'locked', reason?:string}>}
 */
async function ensureSalaryStructureTable(log = console, opts = {}) {
  const { retry = false, retryIntervalMs = 30000, retryTimeoutMs = 10 * 60 * 1000 } = opts;
  try {
    await d365.getList(ENTITY_SET, { top: 1 });
    return { status: 'exists' };
  } catch (e) {
    const m = e.response?.data?.error?.message || e.message;
    if (!isMissing(m)) { log?.warn?.(`[provision] salary-structure probe inconclusive (${m}); skipping`); return { status: 'unavailable', reason: m }; }
  }
  const started = Date.now();
  for (;;) {
    try {
      await createSchema(log);
      log?.info?.('[provision] hr_salarystructures ready');
      return { status: 'created' };
    } catch (e) {
      if (e.locked && retry && Date.now() - started + retryIntervalMs <= retryTimeoutMs) {
        log?.warn?.(`[provision] salary-structure: Dataverse locked — retrying in ${retryIntervalMs / 1000}s`);
        await sleep(retryIntervalMs); continue;
      }
      log?.warn?.(`[provision] could not auto-create hr_salarystructures: ${e.message}`);
      return { status: e.locked ? 'locked' : 'unavailable', reason: e.message };
    }
  }
}

module.exports = { ensureSalaryStructureTable, addMissingColumn };
