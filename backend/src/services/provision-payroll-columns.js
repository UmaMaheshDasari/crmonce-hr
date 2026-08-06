/**
 * Adds payroll computation + workflow columns to the EXISTING Payroll table
 * (hr_hrpayroll). Integer amounts (whole ₹) + attendance counts + TEXT workflow
 * fields. Idempotent, best-effort, lock-aware. Basic/Allowances/Deductions/NetPay
 * already exist as Money columns on the entity — untouched.
 */
const axios = require('axios');
const d365 = require('./d365.service');

const ENTITY_LOGICAL = 'hr_hrpayroll';

const label = (t) => ({ '@odata.type': 'Microsoft.Dynamics.CRM.Label', LocalizedLabels: [{ '@odata.type': 'Microsoft.Dynamics.CRM.LocalizedLabel', Label: t, LanguageCode: 1033 }] });
const req = () => ({ Value: 'None', CanBeChanged: true, ManagedPropertyLogicalName: 'canmodifyrequirementlevelsettings' });
const int = (schema, display, minValue = 0, maxValue = 100000000) => ({
  '@odata.type': 'Microsoft.Dynamics.CRM.IntegerAttributeMetadata',
  SchemaName: schema, Format: 'None', MinValue: minValue, MaxValue: maxValue, RequiredLevel: req(), DisplayName: label(display), Description: label(display),
});
const str = (schema, display, maxLength = 40) => ({
  '@odata.type': 'Microsoft.Dynamics.CRM.StringAttributeMetadata',
  SchemaName: schema, MaxLength: maxLength, FormatName: { Value: 'Text' }, RequiredLevel: req(), DisplayName: label(display), Description: label(display),
});

const COLUMNS = [
  int('hr_Gross', 'Gross Salary'),
  int('hr_Overtime', 'Overtime Pay'),
  int('hr_LOP', 'LOP Amount'),
  int('hr_Advance', 'Advance Salary Recovery'),
  // Itemised earnings (from the Salary Structure) — payslip renders these.
  int('hr_HRA', 'House Rent Allowance'),
  int('hr_Special', 'Special Allowance'),
  int('hr_Medical', 'Medical Allowance'),
  int('hr_Conveyance', 'Conveyance Allowance'),
  // Itemised statutory deductions (from Payroll Settings / structure overrides).
  int('hr_PF', 'Provident Fund'),
  int('hr_ProfessionalTax', 'Professional Tax'),
  int('hr_IncomeTax', 'Income Tax (TDS)'),
  // Payroll process: lock flag + full audit snapshot.
  str('hr_Locked', 'Locked', 10),
  str('hr_LockedBy', 'Locked By', 200),
  str('hr_LockedDate', 'Locked Date', 30),
  int('hr_PresentDays', 'Present Days', 0, 366),
  int('hr_AbsentDays', 'Absent Days', 0, 366),
  int('hr_WorkingDays', 'Salary Working Days', 0, 366),
  int('hr_PayDays', 'Payable Days', 0, 366),
  str('hr_ApprovedBy', 'Approved By', 200),
  str('hr_ApprovedDate', 'Approved Date', 30),
  str('hr_ReleasedBy', 'Released By', 200),
  str('hr_ReleasedDate', 'Released Date', 30),
  str('hr_EmailSent', 'Payslip Email Sent', 10),
  str('hr_EmailSentTime', 'Payslip Email Time', 30),
];

const isExists = (m) => /already exists|duplicate|with the name|with a name|is not unique/i.test(m || '');
async function post(path, body) { const headers = await d365.getHeaders({ 'Content-Type': 'application/json' }); return axios.post(`${d365.baseUrl}/${path}`, body, { headers }); }

async function ensurePayrollColumns(log = console) {
  let added = 0, existing = 0; const failed = [];
  for (const col of COLUMNS) {
    try { await post(`EntityDefinitions(LogicalName='${ENTITY_LOGICAL}')/Attributes`, col); added++; log?.info?.(`[provision] added payroll column ${col.SchemaName}`); }
    catch (e) { const m = e.response?.data?.error?.message || e.message; if (isExists(m)) { existing++; continue; } failed.push(col.SchemaName); log?.warn?.(`[provision] payroll column ${col.SchemaName}: ${m}`); }
  }
  log?.info?.(`[provision] payroll columns → added ${added}, existing ${existing}, failed ${failed.length}`);
  return { status: failed.length ? 'partial' : 'ok', added, existing, failed };
}

module.exports = { ensurePayrollColumns };
