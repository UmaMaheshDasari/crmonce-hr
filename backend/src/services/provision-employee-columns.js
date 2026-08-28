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
const memo = (schema, display, maxLength = 2000) => ({
  '@odata.type': 'Microsoft.Dynamics.CRM.MemoAttributeMetadata',
  SchemaName: schema, MaxLength: maxLength, Format: 'Text', RequiredLevel: req(), DisplayName: label(display), Description: label(display),
});

// SchemaName → logical name (lower-cased) must match employee.routes select fields.
const COLUMNS = [
  // Identity
  str('hr_Aadhaar', 'Aadhaar Number', 12),
  str('hr_PAN', 'PAN Number', 10),
  str('hr_Passport', 'Passport Number', 20),
  str('hr_UAN', 'UAN Number', 12),
  str('hr_PFNumber', 'PF Number', 30),
  str('hr_BloodGroup', 'Blood Group', 5),
  // Employee master
  str('hr_EmployeeId', 'Employee ID', 20),            // EMP1039 — eTime business ID (primary, shown everywhere)
  str('hr_EmployeeCode', 'Employee Code', 20),        // legacy generated code (fallback)
  str('hr_ConfirmationDate', 'Confirmation Date', 20),
  str('hr_RelievingDate', 'Relieving Date', 20),
  str('hr_EmploymentType', 'Employment Type', 30),    // Full-time | Part-time | Contract | Intern
  str('hr_WorkLocation', 'Work Location', 120),
  str('hr_PTState', 'Professional Tax State', 80),    // drives the PT Master slab lookup
  // Personal
  str('hr_AltPhone', 'Alternate Mobile', 20),
  str('hr_PersonalEmail', 'Personal Email', 120),
  str('hr_DOB', 'Date of Birth', 20),
  str('hr_CertificateDOB', 'Certificate Date of Birth', 20),   // HR/document reference — NEVER used for birthday wishes
  str('hr_Gender', 'Gender', 20),
  str('hr_MaritalStatus', 'Marital Status', 20),
  str('hr_MarriageDate', 'Marriage Date', 20),          // shown only when Marital Status = Married
  str('hr_Nationality', 'Nationality', 60),
  str('hr_PhotoUrl', 'Photo', 500),                 // HR/Admin DEFAULT employee photo
  str('hr_PersonalPhotoUrl', 'Personal Photo', 500), // employee-chosen personal photo (wins over default)
  str('hr_PhotoRemoved', 'Photo Removed', 6),        // 'true' → suppress the default fallback (show initials)
  // Web Check-In access — Admin-controlled, per employee. 'true' | 'false' (absent = false = DISABLED).
  str('hr_WebCheckinEnabled', 'Web Check-In Enabled', 6),
  // Address
  memo('hr_PermAddress', 'Permanent Address'),
  str('hr_City', 'City', 60),
  str('hr_State', 'State', 60),
  str('hr_Country', 'Country', 60),
  str('hr_Pincode', 'PIN Code', 10),
  // Emergency
  str('hr_EmergencyPhone', 'Emergency Phone', 20),
  str('hr_EmergencyRelation', 'Emergency Relationship', 40),
  // Verification workflow
  str('hr_VerifyStatus', 'Verification Status', 20),   // verified | pending | rejected | changes
  str('hr_VerifiedBy', 'Verified By', 200),
  str('hr_VerifiedDate', 'Verified Date', 30),
  memo('hr_VerifyNote', 'Verification Note'),
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
