/**
 * Self-provisioning for the Missing Punch table (hr_attendancerequests).
 *
 * ensureAttendanceRequestTable() is called once on server startup and is fully
 * idempotent + best-effort: if the table already exists it does nothing; if it is
 * missing it tries to create it (and any missing columns) via the Dataverse
 * metadata API. When the app registration lacks customization rights it simply
 * logs and returns — the feature stays in graceful-degradation mode and an admin
 * can create the table manually (see scripts/create-attendance-request-entity.js).
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

const isExists = (msg) => /already exists|duplicate|with the name|with a name/i.test(msg || '');
const isMissing = (msg) => /Could not find|does not exist|Resource not found|was not found|404/i.test(msg || '');

async function createEntity(log) {
  const headers = await d365.getHeaders({ 'Content-Type': 'application/json' });
  try {
    await axios.post(`${d365.baseUrl}/EntityDefinitions`, ENTITY_BODY, { headers });
    log?.info?.('[provision] created entity hr_AttendanceRequest');
  } catch (e) {
    const msg = e.response?.data?.error?.message || e.message;
    if (isExists(msg)) log?.info?.('[provision] entity hr_AttendanceRequest already exists');
    else throw new Error(msg);   // e.g. missing customization privilege — bubble up
  }
  for (const c of COLUMNS) {
    const h = await d365.getHeaders({ 'Content-Type': 'application/json' });
    try {
      await axios.post(`${d365.baseUrl}/EntityDefinitions(LogicalName='${ENTITY_LOGICAL}')/Attributes`, c, { headers: h });
    } catch (e) {
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
  // 1) Cheap existence probe — if it reads, we're done.
  try {
    await d365.getList('hr_attendancerequests', { top: 1 });
    return { status: 'exists' };
  } catch (e) {
    const msg = e.response?.data?.error?.message || e.message;
    if (!isMissing(msg)) {
      log?.warn?.(`[provision] attendance-request probe inconclusive (${msg}); skipping auto-create`);
      return { status: 'unavailable', reason: msg };
    }
  }
  // 2) Missing → try to create it (needs System Customizer on the app registration).
  try {
    await createEntity(log);
    log?.info?.('[provision] hr_attendancerequests ready — Missing Punch workflow enabled');
    return { status: 'created' };
  } catch (e) {
    log?.warn?.(`[provision] could not auto-create hr_attendancerequests: ${e.message}. ` +
      `Create it manually (scripts/create-attendance-request-entity.js --apply) — the feature stays disabled until then.`);
    return { status: 'unavailable', reason: e.message };
  }
}

module.exports = { ensureAttendanceRequestTable };
