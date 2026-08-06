/**
 * Self-provisioning for Payroll Settings (hr_payrollsettings) + a seeded default
 * row. Mirrors provision-company.js exactly: TEXT/MEMO columns only, idempotent,
 * lock-aware (CustomizationLockException retried on startup).
 *
 *   Entity  : hr_PayrollSetting (logical hr_payrollsetting, set hr_payrollsettings)
 *   Primary : hr_Name
 *   Columns : PF %/ceiling/applicable, PT, IT, LOP basis, working hours, OT rate,
 *             weekly off, leave policy, default allowances/deductions (JSON memo)
 */
const axios = require('axios');
const d365 = require('./d365.service');
const { PAYROLL_SETTINGS_DEFAULTS } = require('./payroll-settings.service');

const ENTITY_LOGICAL = 'hr_payrollsetting';
const ENTITY_SCHEMA = 'hr_PayrollSetting';
const ENTITY_SET = 'hr_payrollsettings';

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

const COLUMNS = [
  str('hr_PfEmployeePercent', 'PF Employee %', 10),
  str('hr_PfEmployerPercent', 'PF Employer %', 10),
  str('hr_PfWageCeiling', 'PF Wage Ceiling', 15),
  str('hr_PfApplicable', 'PF Applicable', 10),
  str('hr_PtAmount', 'Professional Tax (₹/month)', 15),
  str('hr_PtApplicable', 'Professional Tax Applicable', 10),
  str('hr_DefaultPtState', 'Default PT State', 80),
  str('hr_ItPercent', 'Income Tax %', 10),
  str('hr_ItApplicable', 'Income Tax Applicable', 10),
  str('hr_LopBasis', 'LOP Basis', 40),
  str('hr_WorkingHoursPerDay', 'Working Hours / Day', 10),
  str('hr_OtMultiplier', 'Overtime Multiplier', 10),
  str('hr_WeeklyOff', 'Weekly Off', 100),
  str('hr_PaidLeavesPerYear', 'Paid Leaves / Year', 10),
  str('hr_CasualLeaves', 'Casual Leaves', 10),
  str('hr_SickLeaves', 'Sick Leaves', 10),
  memo('hr_DefaultAllowances', 'Default Allowances (JSON)'),
  memo('hr_DefaultDeductions', 'Default Deductions (JSON)'),
];

const ENTITY_BODY = {
  '@odata.type': 'Microsoft.Dynamics.CRM.EntityMetadata',
  SchemaName: ENTITY_SCHEMA, EntitySetName: ENTITY_SET, OwnershipType: 'UserOwned', HasActivities: false, HasNotes: false,
  DisplayName: label('Payroll Setting'), DisplayCollectionName: label('Payroll Settings'),
  Description: label('Configurable payroll parameters — the single source of truth for PF, tax, LOP, overtime and leave policy.'),
  Attributes: [{
    '@odata.type': 'Microsoft.Dynamics.CRM.StringAttributeMetadata',
    SchemaName: 'hr_Name', MaxLength: 200, FormatName: { Value: 'Text' }, IsPrimaryName: true,
    RequiredLevel: req(), DisplayName: label('Profile Name'), Description: label('Payroll settings profile name'),
  }],
};

const isExists = (m) => /already exists|duplicate|with the name|with a name|is not unique/i.test(m || '');
const isMissing = (m) => /Could not find|does not exist|Resource not found|was not found|404/i.test(m || '');
const isLocked = (m) => /CustomizationLockException|customization is already running|another EntityCustomization|another customization/i.test(m || '');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function post(path, body) { const headers = await d365.getHeaders({ 'Content-Type': 'application/json' }); return axios.post(`${d365.baseUrl}/${path}`, body, { headers }); }

async function createSchema(log) {
  try { await post('EntityDefinitions', ENTITY_BODY); log?.info?.('[provision] created entity hr_PayrollSetting'); }
  catch (e) { const m = e.response?.data?.error?.message || e.message; if (isExists(m)) log?.info?.('[provision] entity hr_PayrollSetting already exists'); else if (isLocked(m)) throw Object.assign(new Error(m), { locked: true }); else throw new Error(m); }
  for (const c of COLUMNS) {
    try { await post(`EntityDefinitions(LogicalName='${ENTITY_LOGICAL}')/Attributes`, c); }
    catch (e) { const m = e.response?.data?.error?.message || e.message; if (isLocked(m)) throw Object.assign(new Error(m), { locked: true }); if (!isExists(m)) log?.warn?.(`[provision] payroll-settings column ${c.SchemaName}: ${m}`); }
  }
}

/** Insert the default settings row if the table has no rows yet. Idempotent. */
async function seedDefaults(log) {
  try {
    const { data } = await d365.getList(ENTITY_SET, { select: 'hr_payrollsettingid', top: 1 });
    if (data && data.length) { log?.info?.('[provision] payroll settings already seeded'); return; }
    await d365.create(ENTITY_SET, { ...PAYROLL_SETTINGS_DEFAULTS });
    log?.info?.('[provision] seeded default payroll settings');
  } catch (e) { log?.warn?.(`[provision] payroll-settings seed skipped: ${e.message}`); }
}

/**
 * @returns {Promise<{status:'exists'|'created'|'unavailable'|'locked', reason?:string}>}
 */
async function ensurePayrollSettingsTable(log = console, opts = {}) {
  const { retry = false, retryIntervalMs = 30000, retryTimeoutMs = 10 * 60 * 1000 } = opts;
  try {
    await d365.getList(ENTITY_SET, { top: 1 });
    await seedDefaults(log);
    return { status: 'exists' };
  } catch (e) {
    const m = e.response?.data?.error?.message || e.message;
    if (!isMissing(m)) { log?.warn?.(`[provision] payroll-settings probe inconclusive (${m}); skipping`); return { status: 'unavailable', reason: m }; }
  }
  const started = Date.now();
  for (;;) {
    try {
      await createSchema(log);
      await seedDefaults(log);
      log?.info?.('[provision] hr_payrollsettings ready');
      return { status: 'created' };
    } catch (e) {
      if (e.locked && retry && Date.now() - started + retryIntervalMs <= retryTimeoutMs) {
        log?.warn?.(`[provision] payroll-settings: Dataverse locked — retrying in ${retryIntervalMs / 1000}s`);
        await sleep(retryIntervalMs); continue;
      }
      log?.warn?.(`[provision] could not auto-create hr_payrollsettings: ${e.message}`);
      return { status: e.locked ? 'locked' : 'unavailable', reason: e.message };
    }
  }
}

module.exports = { ensurePayrollSettingsTable, seedDefaults };
