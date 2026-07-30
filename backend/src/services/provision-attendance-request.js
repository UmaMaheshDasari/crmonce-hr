/**
 * Self-provisioning for the Missing Punch table (hr_attendancerequests).
 *
 * The columns are TEXT / MULTILINE (Edm.String) — the backend stores plain string
 * codes ('lunch_out', 'pending', 'YYYY-MM-DD', 'HH:MM'). This matches the table
 * already created in the tenant and keeps the create payload free of option-set
 * integers (which Dataverse rejects on a String column).
 *
 * ensureAttendanceRequestTable() is idempotent + best-effort: existing items are
 * skipped; per-column failures don't abort the rest; a missing customization
 * privilege bubbles up. inspectColumns() logs the ACTUAL column types read from
 * Dataverse metadata so the payload can always be matched to reality (no guessing).
 */
const axios = require('axios');
const d365 = require('./d365.service');

const ENTITY_LOGICAL = 'hr_attendancerequest';
const ENTITY_SCHEMA = 'hr_AttendanceRequest';
const ENTITY_SET = 'hr_attendancerequests';

const label = (text) => ({
  '@odata.type': 'Microsoft.Dynamics.CRM.Label',
  LocalizedLabels: [{ '@odata.type': 'Microsoft.Dynamics.CRM.LocalizedLabel', Label: text, LanguageCode: 1033 }],
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

const COLUMNS = [
  str('hr_EmployeeId', 'Employee Id', 100), str('hr_EmployeeName', 'Employee Name', 200), str('hr_EmployeeEmail', 'Employee Email', 200),
  str('hr_AttendanceDate', 'Attendance Date', 10), str('hr_PunchType', 'Punch Type', 40), str('hr_RequestedTime', 'Requested Time', 10),
  memo('hr_Reason', 'Reason'), memo('hr_Remarks', 'Remarks'), str('hr_AttachmentUrl', 'Attachment Url', 500),
  str('hr_Status', 'Status', 20), memo('hr_OriginalPunches', 'Original Punches'), memo('hr_CorrectedPunches', 'Corrected Punches'),
  str('hr_ApprovedBy', 'Approved By', 200), str('hr_ApprovedDate', 'Approved Date', 30), memo('hr_ApproverComment', 'Approver Comment'),
  str('hr_AttendanceRecordId', 'Attendance Record Id', 100),
];

const ENTITY_BODY = {
  '@odata.type': 'Microsoft.Dynamics.CRM.EntityMetadata',
  SchemaName: ENTITY_SCHEMA, EntitySetName: ENTITY_SET, OwnershipType: 'UserOwned', HasActivities: false, HasNotes: true,
  DisplayName: label('Attendance Request'), DisplayCollectionName: label('Attendance Requests'),
  Description: label('Missing Punch / attendance correction requests.'),
  Attributes: [{
    '@odata.type': 'Microsoft.Dynamics.CRM.StringAttributeMetadata',
    SchemaName: 'hr_Name', MaxLength: 300, FormatName: { Value: 'Text' }, IsPrimaryName: true,
    RequiredLevel: req(), DisplayName: label('Name'), Description: label('Request title'),
  }],
};

const isExists = (msg) => /already exists|duplicate|with the name|with a name|is not unique/i.test(msg || '');
const isMissing = (msg) => /Could not find|does not exist|Resource not found|was not found|404/i.test(msg || '');

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
    log?.info?.(`[provision] hr_attendancerequest column types → ${cols.join(', ')}`);
    return res.data.value || [];
  } catch (e) {
    log?.warn?.(`[provision] column inspect failed: ${e.response?.data?.error?.message || e.message}`);
    return [];
  }
}

async function createSchema(log) {
  try {
    await post('EntityDefinitions', ENTITY_BODY);
    log?.info?.('[provision] created entity hr_AttendanceRequest');
  } catch (e) {
    const msg = e.response?.data?.error?.message || e.message;
    if (isExists(msg)) log?.info?.('[provision] entity hr_AttendanceRequest already exists');
    else throw new Error(msg);   // e.g. missing prvCreateEntity — bubble up
  }
  for (const c of COLUMNS) {
    try { await post(`EntityDefinitions(LogicalName='${ENTITY_LOGICAL}')/Attributes`, c); }
    catch (e) {
      const msg = e.response?.data?.error?.message || e.message;
      if (!isExists(msg)) log?.warn?.(`[provision] column ${c.SchemaName} failed: ${msg}`);
    }
  }
}

/**
 * @param {{info?:Function,warn?:Function,error?:Function}} [log]
 * @returns {Promise<{status:'exists'|'created'|'unavailable', reason?:string}>}
 */
async function ensureAttendanceRequestTable(log = console) {
  try {
    await d365.getList(ENTITY_SET, { top: 1 });
    await inspectColumns(log);                 // log the real column types
    return { status: 'exists' };
  } catch (e) {
    const msg = e.response?.data?.error?.message || e.message;
    if (!isMissing(msg)) {
      log?.warn?.(`[provision] attendance-request probe inconclusive (${msg}); skipping auto-create`);
      return { status: 'unavailable', reason: msg };
    }
  }
  try {
    await createSchema(log);
    await inspectColumns(log);
    log?.info?.('[provision] hr_attendancerequests ready — Missing Punch workflow enabled');
    return { status: 'created' };
  } catch (e) {
    log?.warn?.(`[provision] could not auto-create hr_attendancerequests: ${e.message}. ` +
      `Grant the D365 app registration the System Customizer role, then retry.`);
    return { status: 'unavailable', reason: e.message };
  }
}

module.exports = { ensureAttendanceRequestTable, inspectColumns };
