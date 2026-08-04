/**
 * Self-provisioning for the Employee Goals table (hr_hrgoals).
 *
 *   Entity  : hr_HRGoal        (logical hr_hrgoal, set hr_hrgoals, PK hr_hrgoalid)
 *   Primary : hr_HRGoal1       Text — Goal Title (logical hr_hrgoal1)
 *   Columns : hr_Description   Memo
 *             hr_Quarter       Text 10   — 'Q1'..'Q4'
 *             hr_FinancialYear Text 20   — '2025-26'
 *             hr_Priority      Text 20   — 'low'|'medium'|'high'|'critical'
 *             hr_Status        Text 20   — 'not_started'|'in_progress'|'completed'|'exceeded'|'missed'
 *             hr_Weightage     Whole Number
 *             hr_Progress      Whole Number  — completion %
 *             hr_DueDate       Text 10   — 'YYYY-MM-DD'
 *             hr_KeyResults    Memo
 *             hr_SelfRating / hr_ManagerRating   Whole Number
 *             hr_SelfComments (Employee Remarks) / hr_ManagerComments (Manager Remarks)  Memo
 *             hr_EmployeeId    Text 100  — employee GUID (stored, not a lookup)
 *             hr_EmployeeName  Text 200
 *             hr_AssignedBy    Text 200
 *             hr_AssignedDate  Text 30
 *
 * TEXT / MEMO / INTEGER columns only (Edm.String / Edm.Int32) — the backend stores
 * plain string codes and whole numbers. This mirrors hr_attendancerequests and
 * hr_holidays: no option-set integers or lookups (which Dataverse rejects on a
 * mismatched column and which are far more failure-prone to provision via the Web
 * API). The EntitySetName is fixed to 'hr_hrgoals' so it matches the name the
 * backend already uses (d365.service entities.goal).
 *
 * ensureGoalTable() is idempotent + best-effort: an existing entity/column is
 * skipped; per-column failures don't abort the rest; a missing customization
 * privilege bubbles up. addMissingColumn() repairs a partially-created schema.
 */
const axios = require('axios');
const d365 = require('./d365.service');

const ENTITY_LOGICAL = 'hr_hrgoal';
const ENTITY_SCHEMA = 'hr_HRGoal';
const ENTITY_SET = 'hr_hrgoals';

const label = (t) => ({
  '@odata.type': 'Microsoft.Dynamics.CRM.Label',
  LocalizedLabels: [{ '@odata.type': 'Microsoft.Dynamics.CRM.LocalizedLabel', Label: t, LanguageCode: 1033 }],
});
const req = () => ({ Value: 'None', CanBeChanged: true, ManagedPropertyLogicalName: 'canmodifyrequirementlevelsettings' });
const str = (schema, display, maxLength = 200) => ({
  '@odata.type': 'Microsoft.Dynamics.CRM.StringAttributeMetadata',
  SchemaName: schema, MaxLength: maxLength, FormatName: { Value: 'Text' },
  RequiredLevel: req(), DisplayName: label(display), Description: label(display),
});
const memo = (schema, display, maxLength = 2000) => ({
  '@odata.type': 'Microsoft.Dynamics.CRM.MemoAttributeMetadata',
  SchemaName: schema, MaxLength: maxLength, Format: 'Text',
  RequiredLevel: req(), DisplayName: label(display), Description: label(display),
});
const int = (schema, display, minValue = 0, maxValue = 1000000000) => ({
  '@odata.type': 'Microsoft.Dynamics.CRM.IntegerAttributeMetadata',
  SchemaName: schema, Format: 'None', MinValue: minValue, MaxValue: maxValue,
  RequiredLevel: req(), DisplayName: label(display), Description: label(display),
});

const COLUMNS = [
  memo('hr_Description', 'Description'),
  str('hr_Quarter', 'Quarter', 10),
  str('hr_FinancialYear', 'Financial Year', 20),
  str('hr_Priority', 'Priority', 20),
  str('hr_Status', 'Status', 20),
  int('hr_Weightage', 'Weightage', 0, 100),
  int('hr_Progress', 'Completion %', 0, 100),
  str('hr_DueDate', 'Due Date', 10),
  memo('hr_KeyResults', 'Key Results'),
  int('hr_SelfRating', 'Self Rating', 0, 5),
  int('hr_ManagerRating', 'Manager Rating', 0, 5),
  memo('hr_SelfComments', 'Employee Remarks'),
  memo('hr_ManagerComments', 'Manager Remarks'),
  str('hr_EmployeeId', 'Employee Id', 100),
  str('hr_EmployeeName', 'Employee Name', 200),
  str('hr_AssignedBy', 'Assigned By', 200),
  str('hr_AssignedDate', 'Assigned Date', 30),
];

const ENTITY_BODY = {
  '@odata.type': 'Microsoft.Dynamics.CRM.EntityMetadata',
  SchemaName: ENTITY_SCHEMA, EntitySetName: ENTITY_SET, OwnershipType: 'UserOwned', HasActivities: false, HasNotes: true,
  DisplayName: label('HR Goal'), DisplayCollectionName: label('HR Goals'),
  Description: label('Employee performance goals / objectives.'),
  Attributes: [{
    '@odata.type': 'Microsoft.Dynamics.CRM.StringAttributeMetadata',
    SchemaName: 'hr_HRGoal1', MaxLength: 300, FormatName: { Value: 'Text' }, IsPrimaryName: true,
    RequiredLevel: req(), DisplayName: label('Goal Title'), Description: label('Goal title'),
  }],
};

const isExists = (m) => /already exists|duplicate|with the name|with a name|is not unique/i.test(m || '');
const isMissing = (m) => /Could not find|does not exist|Resource not found|was not found|404/i.test(m || '');
async function post(path, body) {
  const headers = await d365.getHeaders({ 'Content-Type': 'application/json' });
  return axios.post(`${d365.baseUrl}/${path}`, body, { headers });
}

/** Read + log the ACTUAL column types from Dataverse metadata (no guessing). */
async function inspectColumns(log) {
  try {
    const headers = await d365.getHeaders();
    const url = `${d365.baseUrl}/EntityDefinitions(LogicalName='${ENTITY_LOGICAL}')/Attributes?$select=LogicalName,AttributeType`;
    const res = await axios.get(url, { headers });
    const cols = (res.data.value || []).filter(a => String(a.LogicalName).startsWith('hr_'))
      .map(a => `${a.LogicalName}:${a.AttributeType}`).sort();
    log?.info?.(`[provision] hr_hrgoal column types → ${cols.join(', ')}`);
    return res.data.value || [];
  } catch (e) {
    log?.warn?.(`[provision] goal column inspect failed: ${e.response?.data?.error?.message || e.message}`);
    return [];
  }
}

/** Create a single missing column by its logical name (e.g. 'hr_progress'). */
async function addMissingColumn(logicalName, log) {
  const col = COLUMNS.find(c => c.SchemaName.toLowerCase() === String(logicalName).toLowerCase());
  if (!col) return false;
  try {
    await post(`EntityDefinitions(LogicalName='${ENTITY_LOGICAL}')/Attributes`, col);
    log?.info?.(`[provision] added missing goal column ${col.SchemaName}`);
    return true;
  } catch (e) {
    const m = e.response?.data?.error?.message || e.message;
    if (isExists(m)) return true;
    log?.warn?.(`[provision] could not add goal column ${col.SchemaName}: ${m}`);
    return false;
  }
}

async function createSchema(log) {
  try {
    await post('EntityDefinitions', ENTITY_BODY);
    log?.info?.('[provision] created entity hr_HRGoal');
  } catch (e) {
    const m = e.response?.data?.error?.message || e.message;
    if (isExists(m)) log?.info?.('[provision] entity hr_HRGoal already exists');
    else throw new Error(m);   // e.g. missing prvCreateEntity — bubble up
  }
  for (const c of COLUMNS) {
    try { await post(`EntityDefinitions(LogicalName='${ENTITY_LOGICAL}')/Attributes`, c); }
    catch (e) {
      const m = e.response?.data?.error?.message || e.message;
      if (!isExists(m)) log?.warn?.(`[provision] goal column ${c.SchemaName} failed: ${m}`);
    }
  }
}

/**
 * @param {{info?:Function,warn?:Function,error?:Function}} [log]
 * @returns {Promise<{status:'exists'|'created'|'unavailable', reason?:string}>}
 */
async function ensureGoalTable(log = console) {
  try {
    await d365.getList(ENTITY_SET, { top: 1 });
    await inspectColumns(log);                 // log the real column types
    return { status: 'exists' };
  } catch (e) {
    const m = e.response?.data?.error?.message || e.message;
    if (!isMissing(m)) {
      log?.warn?.(`[provision] goal probe inconclusive (${m}); skipping auto-create`);
      return { status: 'unavailable', reason: m };
    }
  }
  try {
    await createSchema(log);
    await inspectColumns(log);
    log?.info?.('[provision] hr_hrgoals ready — Goal Assignment enabled');
    return { status: 'created' };
  } catch (e) {
    log?.warn?.(`[provision] could not auto-create hr_hrgoals: ${e.message}. ` +
      `Grant the D365 app registration the System Customizer role, then retry.`);
    return { status: 'unavailable', reason: e.message };
  }
}

module.exports = { ensureGoalTable, inspectColumns, addMissingColumn };
