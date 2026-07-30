/**
 * Provision the "Attendance Request" (Missing Punch) table via the Dataverse
 * metadata API. Idempotent — skips the entity/columns if they already exist.
 *
 *   Entity  : hr_AttendanceRequest  (set name: hr_attendancerequests)
 *   Primary : hr_Name               "Name"                Text
 *   Columns (all Text / Multiline — no option sets or lookups, so it provisions
 *   cleanly and the API can read/write string statuses):
 *     hr_EmployeeId         Text 100    submitter GUID
 *     hr_EmployeeName       Text 200
 *     hr_EmployeeEmail      Text 200
 *     hr_AttendanceDate     Text 10     YYYY-MM-DD
 *     hr_PunchType          Text 40     missing_check_in | missing_check_out | lunch_out | lunch_in
 *     hr_RequestedTime      Text 10     HH:MM
 *     hr_Reason             Memo 2000
 *     hr_Remarks            Memo 2000
 *     hr_AttachmentUrl      Text 500
 *     hr_Status             Text 20     pending | approved | rejected
 *     hr_OriginalPunches    Memo 2000   audit: punches before correction (JSON)
 *     hr_CorrectedPunches   Memo 2000   audit: punches after correction (JSON)
 *     hr_ApprovedBy         Text 200
 *     hr_ApprovedDate       Text 30
 *     hr_ApproverComment    Memo 2000
 *     hr_AttendanceRecordId Text 100    corrected hr_hrattendance GUID
 *
 * Requires an app registration with System Customizer / Administrator (metadata
 * write). Run ON THE SERVER (needs backend/.env):
 *   node scripts/create-attendance-request-entity.js            # preview (dry-run)
 *   node scripts/create-attendance-request-entity.js --apply    # actually create
 * Then publish customizations. The backend degrades gracefully until this exists.
 */
require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const axios = require('axios');
const DRY = !process.argv.includes('--apply');
const ENTITY_LOGICAL = 'hr_attendancerequest';
const ENTITY_SCHEMA = 'hr_AttendanceRequest';

const label = (text) => ({
  '@odata.type': 'Microsoft.Dynamics.CRM.Label',
  LocalizedLabels: [{ '@odata.type': 'Microsoft.Dynamics.CRM.LocalizedLabel', Label: text, LanguageCode: 1033 }],
});
const str = (schema, display, maxLength = 200) => ({
  '@odata.type': 'Microsoft.Dynamics.CRM.StringAttributeMetadata',
  SchemaName: schema, MaxLength: maxLength, FormatName: { Value: 'Text' },
  RequiredLevel: { Value: 'None', CanBeChanged: true, ManagedPropertyLogicalName: 'canmodifyrequirementlevelsettings' },
  DisplayName: label(display), Description: label(display),
});
const memo = (schema, display, maxLength = 2000) => ({
  '@odata.type': 'Microsoft.Dynamics.CRM.MemoAttributeMetadata',
  SchemaName: schema, MaxLength: maxLength, Format: 'Text',
  RequiredLevel: { Value: 'None', CanBeChanged: true, ManagedPropertyLogicalName: 'canmodifyrequirementlevelsettings' },
  DisplayName: label(display), Description: label(display),
});

const COLUMNS = [
  str('hr_EmployeeId', 'Employee Id', 100), str('hr_EmployeeName', 'Employee Name', 200), str('hr_EmployeeEmail', 'Employee Email', 200),
  str('hr_AttendanceDate', 'Attendance Date', 10), str('hr_PunchType', 'Punch Type', 40), str('hr_RequestedTime', 'Requested Time', 10),
  memo('hr_Reason', 'Reason'), memo('hr_Remarks', 'Remarks'), str('hr_AttachmentUrl', 'Attachment Url', 500),
  str('hr_Status', 'Status', 20), memo('hr_OriginalPunches', 'Original Punches'), memo('hr_CorrectedPunches', 'Corrected Punches'),
  str('hr_ApprovedBy', 'Approved By', 200), str('hr_ApprovedDate', 'Approved Date', 30), memo('hr_ApproverComment', 'Approver Comment'),
  str('hr_AttendanceRecordId', 'Attendance Record Id', 100),
];

const entityBody = {
  '@odata.type': 'Microsoft.Dynamics.CRM.EntityMetadata',
  SchemaName: ENTITY_SCHEMA, EntitySetName: 'hr_attendancerequests', OwnershipType: 'UserOwned', HasActivities: false, HasNotes: true,
  DisplayName: label('Attendance Request'), DisplayCollectionName: label('Attendance Requests'),
  Description: label('Missing Punch / attendance correction requests.'),
  Attributes: [{
    '@odata.type': 'Microsoft.Dynamics.CRM.StringAttributeMetadata',
    SchemaName: 'hr_Name', MaxLength: 300, FormatName: { Value: 'Text' }, IsPrimaryName: true,
    RequiredLevel: { Value: 'None', CanBeChanged: true, ManagedPropertyLogicalName: 'canmodifyrequirementlevelsettings' },
    DisplayName: label('Name'), Description: label('Request title'),
  }],
};

(async () => {
  const d365 = require('../src/services/d365.service');
  console.log(`\n=== Create ${ENTITY_SCHEMA} table (${DRY ? 'DRY-RUN' : 'APPLY'}) ===\n`);
  if (DRY) {
    console.log(`  [dry-run] entity ${ENTITY_SCHEMA} (set: hr_attendancerequests) + primary hr_Name`);
    COLUMNS.forEach(c => console.log(`  [dry-run] column ${c.SchemaName}`));
    console.log('\nDRY-RUN — nothing created. Re-run with --apply.\n');
    return;
  }

  // 1) Create the entity (with its primary name attribute).
  const headers = await d365.getHeaders({ 'Content-Type': 'application/json' });
  try {
    await axios.post(`${d365.baseUrl}/EntityDefinitions`, entityBody, { headers });
    console.log(`  created entity ${ENTITY_SCHEMA}`);
  } catch (e) {
    const msg = e.response?.data?.error?.message || e.message;
    if (/already exists|duplicate|with the name/i.test(msg)) console.log(`  exists  entity ${ENTITY_SCHEMA} (skipped)`);
    else { console.error(`  FAIL entity: ${msg}`); process.exit(1); }
  }

  // 2) Add the remaining columns.
  for (const c of COLUMNS) {
    const h = await d365.getHeaders({ 'Content-Type': 'application/json' });
    try {
      await axios.post(`${d365.baseUrl}/EntityDefinitions(LogicalName='${ENTITY_LOGICAL}')/Attributes`, c, { headers: h });
      console.log(`  created ${c.SchemaName}`);
    } catch (e) {
      const msg = e.response?.data?.error?.message || e.message;
      if (/already exists|duplicate|with the name/i.test(msg)) console.log(`  exists  ${c.SchemaName} (skipped)`);
      else console.error(`  FAIL    ${c.SchemaName}: ${msg}`);
    }
  }
  console.log('\nDone. Publish All Customizations in the maker portal, then restart the backend.\n');
})().catch(e => { console.error(e.message); process.exit(1); });
