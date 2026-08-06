/**
 * Self-provisioning for Historical Leave Opening Balance.
 *
 *   hr_leaveopenings       — one row per employee per leave-year holding the
 *                            already-used CL/SL/LOP and opening comp-off balance
 *                            migrated from the previous (Excel) system.
 *   hr_leaveopeningaudits  — an immutable edit trail (old/new/by/when/reason),
 *                            one row per changed field. Mirrors provision-profile-audit.
 *
 * TEXT/MEMO columns only, idempotent, lock-aware — mirrors provision-advance.js.
 */
const axios = require('axios');
const d365 = require('./d365.service');

const label = (t) => ({ '@odata.type': 'Microsoft.Dynamics.CRM.Label', LocalizedLabels: [{ '@odata.type': 'Microsoft.Dynamics.CRM.LocalizedLabel', Label: t, LanguageCode: 1033 }] });
const req = () => ({ Value: 'None', CanBeChanged: true, ManagedPropertyLogicalName: 'canmodifyrequirementlevelsettings' });
const str = (schema, display, maxLength = 100) => ({
  '@odata.type': 'Microsoft.Dynamics.CRM.StringAttributeMetadata',
  SchemaName: schema, MaxLength: maxLength, FormatName: { Value: 'Text' }, RequiredLevel: req(), DisplayName: label(display), Description: label(display),
});
const memo = (schema, display, maxLength = 2000) => ({
  '@odata.type': 'Microsoft.Dynamics.CRM.MemoAttributeMetadata',
  SchemaName: schema, MaxLength: maxLength, Format: 'Text', RequiredLevel: req(), DisplayName: label(display), Description: label(display),
});

// ── Opening-balance table ────────────────────────────────────────────────────
const OPEN_LOGICAL = 'hr_leaveopening';
const OPEN_SCHEMA = 'hr_LeaveOpening';
const OPEN_SET = 'hr_leaveopenings';
const OPEN_COLUMNS = [
  str('hr_EmployeeId', 'Employee Id', 100),
  str('hr_EmployeeName', 'Employee Name', 200),
  str('hr_Year', 'Leave Year', 6),
  str('hr_CasualUsed', 'Casual Leave Already Used', 10),
  str('hr_SickUsed', 'Sick Leave Already Used', 10),
  str('hr_LopUsed', 'LOP Already Used', 10),
  str('hr_CompOff', 'Comp Off Opening Balance', 10),
  memo('hr_Remarks', 'Remarks'),
  str('hr_CreatedBy', 'Created By', 200),
];
const OPEN_BODY = {
  '@odata.type': 'Microsoft.Dynamics.CRM.EntityMetadata',
  SchemaName: OPEN_SCHEMA, EntitySetName: OPEN_SET, OwnershipType: 'UserOwned', HasActivities: false, HasNotes: false,
  DisplayName: label('Leave Opening Balance'), DisplayCollectionName: label('Leave Opening Balances'),
  Description: label('One-time historical leave opening balance per employee per year (migration).'),
  Attributes: [{
    '@odata.type': 'Microsoft.Dynamics.CRM.StringAttributeMetadata',
    SchemaName: 'hr_Name', MaxLength: 250, FormatName: { Value: 'Text' }, IsPrimaryName: true,
    RequiredLevel: req(), DisplayName: label('Name'), Description: label('Opening-balance label'),
  }],
};

// ── Edit-audit table ─────────────────────────────────────────────────────────
const AUDIT_LOGICAL = 'hr_leaveopeningaudit';
const AUDIT_SCHEMA = 'hr_LeaveOpeningAudit';
const AUDIT_SET = 'hr_leaveopeningaudits';
const AUDIT_COLUMNS = [
  str('hr_EmployeeId', 'Employee Id', 100),
  str('hr_EmployeeName', 'Employee Name', 200),
  str('hr_Year', 'Leave Year', 6),
  str('hr_Field', 'Field', 60),
  memo('hr_OldValue', 'Old Value'),
  memo('hr_NewValue', 'New Value'),
  str('hr_Action', 'Action', 30),        // created | updated
  str('hr_UpdatedBy', 'Modified By', 200),
  str('hr_UpdatedOn', 'Modified On', 30),
  memo('hr_Reason', 'Reason'),
];
const AUDIT_BODY = {
  '@odata.type': 'Microsoft.Dynamics.CRM.EntityMetadata',
  SchemaName: AUDIT_SCHEMA, EntitySetName: AUDIT_SET, OwnershipType: 'UserOwned', HasActivities: false, HasNotes: false,
  DisplayName: label('Leave Opening Audit'), DisplayCollectionName: label('Leave Opening Audits'),
  Description: label('Edit trail for leave opening-balance changes.'),
  Attributes: [{
    '@odata.type': 'Microsoft.Dynamics.CRM.StringAttributeMetadata',
    SchemaName: 'hr_Name', MaxLength: 250, FormatName: { Value: 'Text' }, IsPrimaryName: true,
    RequiredLevel: req(), DisplayName: label('Name'), Description: label('Audit entry label'),
  }],
};

const isExists = (m) => /already exists|duplicate|with the name|with a name|is not unique/i.test(m || '');
const isMissing = (m) => /Could not find|does not exist|Resource not found|was not found|404/i.test(m || '');
const isLocked = (m) => /CustomizationLockException|customization is already running|another EntityCustomization|another customization/i.test(m || '');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function post(path, body) { const headers = await d365.getHeaders({ 'Content-Type': 'application/json' }); return axios.post(`${d365.baseUrl}/${path}`, body, { headers }); }

async function createOne(logical, entityBody, columns, log) {
  try { await post('EntityDefinitions', entityBody); log?.info?.(`[provision] created entity ${entityBody.SchemaName}`); }
  catch (e) { const m = e.response?.data?.error?.message || e.message; if (isExists(m)) log?.info?.(`[provision] entity ${entityBody.SchemaName} already exists`); else if (isLocked(m)) throw Object.assign(new Error(m), { locked: true }); else throw new Error(m); }
  for (const c of columns) {
    try { await post(`EntityDefinitions(LogicalName='${logical}')/Attributes`, c); }
    catch (e) { const m = e.response?.data?.error?.message || e.message; if (isLocked(m)) throw Object.assign(new Error(m), { locked: true }); if (!isExists(m)) log?.warn?.(`[provision] ${logical} column ${c.SchemaName}: ${m}`); }
  }
}

async function ensureLeaveOpeningTable(log = console, opts = {}) {
  const { retry = false, retryIntervalMs = 30000, retryTimeoutMs = 10 * 60 * 1000 } = opts;
  let needOpen = false, needAudit = false;
  try { await d365.getList(OPEN_SET, { top: 1 }); } catch (e) { if (isMissing(e.response?.data?.error?.message || e.message)) needOpen = true; }
  try { await d365.getList(AUDIT_SET, { top: 1 }); } catch (e) { if (isMissing(e.response?.data?.error?.message || e.message)) needAudit = true; }
  if (!needOpen && !needAudit) return { status: 'exists' };

  const started = Date.now();
  for (;;) {
    try {
      if (needOpen) await createOne(OPEN_LOGICAL, OPEN_BODY, OPEN_COLUMNS, log);
      if (needAudit) await createOne(AUDIT_LOGICAL, AUDIT_BODY, AUDIT_COLUMNS, log);
      log?.info?.('[provision] hr_leaveopenings ready');
      return { status: 'created' };
    } catch (e) {
      if (e.locked && retry && Date.now() - started + retryIntervalMs <= retryTimeoutMs) {
        log?.warn?.(`[provision] leave-opening: Dataverse locked — retrying in ${retryIntervalMs / 1000}s`);
        await sleep(retryIntervalMs); continue;
      }
      log?.warn?.(`[provision] could not auto-create leave-opening tables: ${e.message}`);
      return { status: e.locked ? 'locked' : 'unavailable', reason: e.message };
    }
  }
}

module.exports = { ensureLeaveOpeningTable, OPEN_SET, AUDIT_SET };
