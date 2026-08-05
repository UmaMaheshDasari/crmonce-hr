/**
 * Adds document-management columns to the EXISTING Documents table (hr_hrdocument).
 * TEXT/MEMO columns, idempotent, best-effort. Existing columns (hr_name, hr_fileurl,
 * hr_filesize, hr_originalname, hr_type) are untouched.
 *
 * New: DocumentType (free text so HR can add types), Remarks (employee), Status
 * (pending|verified|rejected|reupload), UploadedBy, VerifiedBy, VerifiedOn,
 * HRRemarks, ContentType.
 */
const axios = require('axios');
const d365 = require('./d365.service');

const ENTITY_LOGICAL = 'hr_hrdocument';

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
const int = (schema, display, min = 0, max = 100000) => ({
  '@odata.type': 'Microsoft.Dynamics.CRM.IntegerAttributeMetadata',
  SchemaName: schema, Format: 'None', MinValue: min, MaxValue: max, RequiredLevel: req(), DisplayName: label(display), Description: label(display),
});

const COLUMNS = [
  str('hr_DocumentType', 'Document Type', 60),
  memo('hr_Remarks', 'Remarks'),
  str('hr_Status', 'Verification Status', 20),   // pending | verified | rejected | reupload | superseded
  str('hr_UploadedBy', 'Uploaded By', 200),
  str('hr_VerifiedBy', 'Verified By', 200),
  str('hr_VerifiedOn', 'Verified On', 30),
  memo('hr_HRRemarks', 'HR Remarks'),
  str('hr_ContentType', 'Content Type', 100),
  int('hr_Version', 'Version', 1, 100000),        // V1, V2, V3 …
  str('hr_DocGroup', 'Document Group', 50),        // version-chain id
];

const isExists = (m) => /already exists|duplicate|with the name|with a name|is not unique/i.test(m || '');
async function post(path, body) { const headers = await d365.getHeaders({ 'Content-Type': 'application/json' }); return axios.post(`${d365.baseUrl}/${path}`, body, { headers }); }

async function ensureDocumentColumns(log = console) {
  let added = 0, existing = 0; const failed = [];
  for (const col of COLUMNS) {
    try { await post(`EntityDefinitions(LogicalName='${ENTITY_LOGICAL}')/Attributes`, col); added++; log?.info?.(`[provision] added document column ${col.SchemaName}`); }
    catch (e) { const m = e.response?.data?.error?.message || e.message; if (isExists(m)) { existing++; continue; } failed.push(col.SchemaName); log?.warn?.(`[provision] document column ${col.SchemaName}: ${m}`); }
  }
  log?.info?.(`[provision] document columns → added ${added}, existing ${existing}, failed ${failed.length}`);
  return { status: failed.length ? 'partial' : 'ok', added, existing, failed };
}

module.exports = { ensureDocumentColumns };
