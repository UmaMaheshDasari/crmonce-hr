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
  str('hr_MedCertRequired', 'Medical Certificate Required for Sick Leave', 10),
  str('hr_MedCertAfterDays', 'Medical Certificate Required After (days)', 10),
  str('hr_CompOffExpiryDays', 'Comp Off Expiry (days after worked date)', 10),
  str('hr_CompOffAutoEarn', 'Auto-earn Comp Off on Holiday / Weekly-off Work', 10),
  str('hr_CompOffEmployeeRaise', 'Allow Employees to Raise Comp Off', 10),
  str('hr_EarnedLeaveEnabled', 'Earned Leave Enabled', 10),
  str('hr_EarnedLeaves', 'Earned Leaves / Year', 10),
  str('hr_MaxBackdatedLeaveDays', 'Maximum Backdated Leave Days', 10),
  str('hr_HistAttendanceMonths', 'Historical Attendance Months Back', 10),
  str('hr_GraceTime', 'Late Login Grace Time (minutes)', 10),
  str('hr_MaxLateLogins', 'Maximum Late Logins Per Month', 10),
  str('hr_LateLoginDaysBack', 'Late Login Maximum Backdated Days', 10),
  str('hr_LateLoginAllowFuture', 'Late Login Allow Future Requests', 10),
  str('hr_LateLoginApprovalRequired', 'Late Login Approval Required', 10),
  str('hr_LateLoginMode', 'Late Login Attendance Mode', 20),
  str('hr_LateLoginPenalty', 'Late Login Payroll Penalty (future)', 10),
  memo('hr_DefaultAllowances', 'Default Allowances (JSON)'),
  memo('hr_DefaultDeductions', 'Default Deductions (JSON)'),
  // The COMPLETE settings as one JSON blob — the persistence source of truth, so a
  // save survives even if individual scalar columns aren't provisioned yet.
  memo('hr_SettingsJson', 'Settings (JSON)'),
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

// Add every column (idempotent — existing columns return "already exists" and are
// skipped). Used both when creating the entity AND to self-heal an existing table
// whose columns were never fully provisioned.
async function addColumns(log) {
  for (const c of COLUMNS) {
    try { await post(`EntityDefinitions(LogicalName='${ENTITY_LOGICAL}')/Attributes`, c); log?.info?.(`[provision] added payroll-settings column ${c.SchemaName}`); }
    catch (e) { const m = e.response?.data?.error?.message || e.message; if (isLocked(m)) throw Object.assign(new Error(m), { locked: true }); if (!isExists(m)) log?.warn?.(`[provision] payroll-settings column ${c.SchemaName}: ${m}`); }
  }
}

async function createSchema(log) {
  try { await post('EntityDefinitions', ENTITY_BODY); log?.info?.('[provision] created entity hr_PayrollSetting'); }
  catch (e) { const m = e.response?.data?.error?.message || e.message; if (isExists(m)) log?.info?.('[provision] entity hr_PayrollSetting already exists'); else if (isLocked(m)) throw Object.assign(new Error(m), { locked: true }); else throw new Error(m); }
  await addColumns(log);
}

// A cheap probe: does a core column exist on the (existing) table? If not, the
// table was created without its columns — repair by adding them all.
async function repairColumnsIfMissing(log) {
  try { await d365.getList(ENTITY_SET, { select: 'hr_settingsjson,hr_pfemployeepercent,hr_histattendancemonths', top: 1 }); return; }
  catch (e) {
    const m = e.response?.data?.error?.message || e.message;
    if (!/does not exist|Could not find a property|property named '|Invalid property/i.test(m)) return;   // some other error → leave it
  }
  log?.warn?.('[provision] hr_payrollsettings exists but is missing columns — repairing');
  try { await addColumns(log); } catch (e) { log?.warn?.(`[provision] payroll-settings column repair skipped: ${e.message}`); }
}

/** Insert the default settings row if the table has no rows yet. Idempotent. */
async function seedDefaults(log) {
  try {
    const { data } = await d365.getList(ENTITY_SET, { select: 'hr_payrollsettingid', top: 1 });
    if (data && data.length) { log?.info?.('[provision] payroll settings already seeded'); return; }
    // Resilient: strip any column that isn't provisioned yet so the seed row still saves.
    let body = { ...PAYROLL_SETTINGS_DEFAULTS };
    for (let i = 0; i < 60; i++) {
      try { await d365.create(ENTITY_SET, body); break; }
      catch (err) {
        if (d365._isMissingProperty(err)) { const p = d365._missingPropertyName(err); if (p && body[p] !== undefined) { delete body[p]; continue; } }
        throw err;
      }
    }
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
    await repairColumnsIfMissing(log);   // self-heal a table created without its columns
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
