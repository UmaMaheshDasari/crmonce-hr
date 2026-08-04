/**
 * Adds Identity + Bank columns to the EXISTING Employee table (hr_hremployee).
 * TEXT columns only, idempotent (existing columns are skipped), best-effort +
 * lock-aware. Mirrors the addMissingColumn approach in provision-goal.js.
 *
 * Identity: Aadhaar, PAN, Passport, Driving Licence, UAN, ESIC, PF Number,
 *           Blood Group, Emergency Phone (Emergency Contact name already exists).
 * Bank:     Bank Name, Account Holder, Account Number, IFSC, Branch, Cheque URL.
 */
const axios = require('axios');
const d365 = require('./d365.service');

const ENTITY_LOGICAL = 'hr_hremployee';

const label = (t) => ({ '@odata.type': 'Microsoft.Dynamics.CRM.Label', LocalizedLabels: [{ '@odata.type': 'Microsoft.Dynamics.CRM.LocalizedLabel', Label: t, LanguageCode: 1033 }] });
const req = () => ({ Value: 'None', CanBeChanged: true, ManagedPropertyLogicalName: 'canmodifyrequirementlevelsettings' });
const str = (schema, display, maxLength = 200) => ({
  '@odata.type': 'Microsoft.Dynamics.CRM.StringAttributeMetadata',
  SchemaName: schema, MaxLength: maxLength, FormatName: { Value: 'Text' }, RequiredLevel: req(), DisplayName: label(display), Description: label(display),
});

// SchemaName → logical name (lower-cased) must match employee.routes select fields.
const COLUMNS = [
  // Identity
  str('hr_Aadhaar', 'Aadhaar Number', 12),
  str('hr_PAN', 'PAN Number', 10),
  str('hr_Passport', 'Passport Number', 20),
  str('hr_DrivingLicence', 'Driving Licence', 30),
  str('hr_UAN', 'UAN Number', 12),
  str('hr_ESIC', 'ESIC Number', 20),
  str('hr_PFNumber', 'PF Number', 30),
  str('hr_BloodGroup', 'Blood Group', 5),
  str('hr_EmergencyPhone', 'Emergency Phone', 20),
  // Bank
  str('hr_BankName', 'Bank Name', 120),
  str('hr_AccountHolder', 'Account Holder Name', 120),
  str('hr_AccountNumber', 'Account Number', 20),
  str('hr_IFSC', 'IFSC Code', 15),
  str('hr_Branch', 'Branch', 120),
  str('hr_ChequeUrl', 'Cancelled Cheque', 500),
];

const isExists = (m) => /already exists|duplicate|with the name|with a name|is not unique/i.test(m || '');
const isLocked = (m) => /CustomizationLockException|customization is already running|another EntityCustomization|another customization/i.test(m || '');
async function post(path, body) { const headers = await d365.getHeaders({ 'Content-Type': 'application/json' }); return axios.post(`${d365.baseUrl}/${path}`, body, { headers }); }

/**
 * Ensure all identity/bank columns exist on the employee table.
 * @returns {Promise<{status:'ok'|'partial', added:number, existing:number, failed:string[]}>}
 */
async function ensureEmployeeColumns(log = console) {
  let added = 0, existing = 0; const failed = [];
  for (const col of COLUMNS) {
    try {
      await post(`EntityDefinitions(LogicalName='${ENTITY_LOGICAL}')/Attributes`, col);
      added++; log?.info?.(`[provision] added employee column ${col.SchemaName}`);
    } catch (e) {
      const m = e.response?.data?.error?.message || e.message;
      if (isExists(m)) { existing++; continue; }
      failed.push(col.SchemaName);
      log?.[isLocked(m) ? 'warn' : 'warn']?.(`[provision] employee column ${col.SchemaName}: ${m}`);
    }
  }
  const status = failed.length ? 'partial' : 'ok';
  log?.info?.(`[provision] employee identity/bank columns → added ${added}, existing ${existing}, failed ${failed.length}`);
  return { status, added, existing, failed };
}

module.exports = { ensureEmployeeColumns };
