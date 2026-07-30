/**
 * Self-provisioning for the Missing Punch table (hr_attendancerequests) with the
 * FULL Dataverse schema: Choice (hr_punchtype, hr_status), Date-Only
 * (hr_attendancedate), Date-and-Time (hr_approveddate), a Lookup to Attendance
 * (hr_attendancerecordid), and Text/Memo for the rest.
 *
 * ensureAttendanceRequestTable() runs on startup / on POST-create fallback /
 * via the Super-Admin /setup endpoint. It is idempotent + best-effort: existing
 * items are skipped; per-column failures don't abort the rest; a missing
 * customization privilege bubbles up so the caller can report it.
 *
 * NOTE: Dataverse has no native "Time Only" primitive — hr_requestedtime is stored
 * as "HH:MM" text (the portable representation the engine already uses).
 */
const axios = require('axios');
const d365 = require('./d365.service');

const ENTITY_LOGICAL = 'hr_attendancerequest';
const ENTITY_SCHEMA = 'hr_AttendanceRequest';
const ENTITY_SET = 'hr_attendancerequests';
const ATTENDANCE_LOGICAL = 'hr_hrattendance';

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
const dateAttr = (schema, display, dateOnly) => ({
  '@odata.type': 'Microsoft.Dynamics.CRM.DateTimeAttributeMetadata',
  SchemaName: schema, Format: dateOnly ? 'DateOnly' : 'DateAndTime',
  DateTimeBehavior: { Value: dateOnly ? 'DateOnly' : 'UserLocal' },
  RequiredLevel: req(), DisplayName: label(display), Description: label(display),
});
const choice = (schema, display, options) => ({
  '@odata.type': 'Microsoft.Dynamics.CRM.PicklistAttributeMetadata',
  SchemaName: schema, RequiredLevel: req(), DisplayName: label(display), Description: label(display),
  OptionSet: {
    '@odata.type': 'Microsoft.Dynamics.CRM.OptionSetMetadata', IsGlobal: false, OptionSetType: 'Picklist',
    Options: options.map(([value, text]) => ({ Value: value, Label: label(text) })),
  },
});

// Primary name lives on the entity create; everything else is added after.
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

const COLUMNS = [
  str('hr_EmployeeId', 'Employee Id', 100),
  str('hr_EmployeeName', 'Employee Name', 200),
  str('hr_EmployeeEmail', 'Employee Email', 200),
  dateAttr('hr_AttendanceDate', 'Attendance Date', true),
  choice('hr_PunchType', 'Punch Type', [
    [123140000, 'Missing Check In'], [123140001, 'Missing Check Out'], [123140002, 'Lunch Out'], [123140003, 'Lunch In'],
  ]),
  str('hr_RequestedTime', 'Requested Time', 10),   // HH:MM (Dataverse has no Time-Only type)
  memo('hr_Reason', 'Reason'),
  memo('hr_Remarks', 'Remarks'),
  str('hr_AttachmentUrl', 'Attachment Url', 500),
  choice('hr_Status', 'Status', [[123140000, 'Pending'], [123140001, 'Approved'], [123140002, 'Rejected']]),
  memo('hr_OriginalPunches', 'Original Punches'),
  memo('hr_CorrectedPunches', 'Corrected Punches'),
  str('hr_ApprovedBy', 'Approved By', 200),
  dateAttr('hr_ApprovedDate', 'Approved Date', false),
  memo('hr_ApproverComment', 'Approver Comment'),
];

// Lookup hr_attendancerecordid → Attendance (created as a 1:N relationship).
const LOOKUP_RELATIONSHIP = {
  '@odata.type': 'Microsoft.Dynamics.CRM.OneToManyRelationshipMetadata',
  SchemaName: 'hr_hrattendance_AttendanceRequest',
  ReferencedEntity: ATTENDANCE_LOGICAL, ReferencingEntity: ENTITY_LOGICAL, ReferencedAttribute: 'hr_hrattendanceid',
  Lookup: {
    '@odata.type': 'Microsoft.Dynamics.CRM.LookupAttributeMetadata',
    SchemaName: 'hr_AttendanceRecordId', RequiredLevel: req(),
    DisplayName: label('Attendance Record'), Description: label('Corrected attendance record'),
  },
  CascadeConfiguration: { Assign: 'NoCascade', Delete: 'RemoveLink', Merge: 'NoCascade', Reparent: 'NoCascade', Share: 'NoCascade', Unshare: 'NoCascade' },
};

const isExists = (msg) => /already exists|duplicate|with the name|with a name|SchemaName.*is not unique/i.test(msg || '');
const isMissing = (msg) => /Could not find|does not exist|Resource not found|was not found|404/i.test(msg || '');

async function post(path, body) {
  const headers = await d365.getHeaders({ 'Content-Type': 'application/json' });
  return axios.post(`${d365.baseUrl}/${path}`, body, { headers });
}

async function createSchema(log) {
  // 1) Entity + primary name.
  try {
    await post('EntityDefinitions', ENTITY_BODY);
    log?.info?.('[provision] created entity hr_AttendanceRequest');
  } catch (e) {
    const msg = e.response?.data?.error?.message || e.message;
    if (isExists(msg)) log?.info?.('[provision] entity hr_AttendanceRequest already exists');
    else throw new Error(msg);   // e.g. missing prvCreateEntity — bubble up as "unavailable"
  }

  // 2) Columns (Text / Memo / Date / Choice) — resilient per column.
  for (const c of COLUMNS) {
    try { await post(`EntityDefinitions(LogicalName='${ENTITY_LOGICAL}')/Attributes`, c); log?.info?.(`[provision] column ${c.SchemaName}`); }
    catch (e) {
      const msg = e.response?.data?.error?.message || e.message;
      if (!isExists(msg)) log?.warn?.(`[provision] column ${c.SchemaName} failed: ${msg}`);
    }
  }

  // 3) Lookup relationship → Attendance (best-effort; audit still works without it).
  try { await post('RelationshipDefinitions', LOOKUP_RELATIONSHIP); log?.info?.('[provision] lookup hr_AttendanceRecordId → Attendance'); }
  catch (e) {
    const msg = e.response?.data?.error?.message || e.message;
    if (!isExists(msg)) log?.warn?.(`[provision] lookup hr_AttendanceRecordId failed: ${msg}`);
  }
}

/**
 * @param {{info?:Function,warn?:Function,error?:Function}} [log]
 * @returns {Promise<{status:'exists'|'created'|'unavailable', reason?:string}>}
 */
async function ensureAttendanceRequestTable(log = console) {
  try {
    await d365.getList(ENTITY_SET, { top: 1 });
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
    log?.info?.('[provision] hr_attendancerequests ready — Missing Punch workflow enabled');
    return { status: 'created' };
  } catch (e) {
    log?.warn?.(`[provision] could not auto-create hr_attendancerequests: ${e.message}. ` +
      `Grant the D365 app registration the System Customizer role (metadata write), then retry.`);
    return { status: 'unavailable', reason: e.message };
  }
}

module.exports = { ensureAttendanceRequestTable };
