/**
 * Self-provisioning for Historical Attendance Requests (hr_histattendances).
 *
 * An employee raises a request to record attendance for a PAST date they were
 * marked Absent (Date, In/Out time, Reason, Comments, optional Attachment). HR
 * approves/rejects/asks for more info. On approval the SINGLE attendance record
 * for that date is created-or-updated (never a second row). TEXT/MEMO columns
 * only, idempotent, lock-aware. Mirrors provision-late-login.js.
 */
const axios = require('axios');
const d365 = require('./d365.service');

const ENTITY_LOGICAL = 'hr_histattendance';
const ENTITY_SCHEMA = 'hr_HistAttendance';
const ENTITY_SET = 'hr_histattendances';

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

const COLUMNS = [
  str('hr_EmployeeId', 'Employee Id', 100),
  str('hr_EmployeeName', 'Employee Name', 200),
  str('hr_Date', 'Date', 10),
  str('hr_Month', 'Month (YYYY-MM)', 7),
  str('hr_InTime', 'In Time', 10),
  str('hr_OutTime', 'Out Time', 10),
  memo('hr_Reason', 'Reason'),
  memo('hr_Comments', 'Comments'),
  str('hr_AttachmentId', 'Attachment Document Id', 100),
  str('hr_Status', 'Status', 20),            // pending | approved | rejected | more_info
  str('hr_ApprovedBy', 'Approved By', 200),
  str('hr_ApprovedDate', 'Approved Date', 30),
  memo('hr_ApproverComment', 'Approver Comment'),
  str('hr_OldStatus', 'Old Attendance Status', 20),   // audit — before approval
  str('hr_NewStatus', 'New Attendance Status', 20),   // audit — after approval
  str('hr_Ip', 'Submitted From IP', 60),
];

const ENTITY_BODY = {
  '@odata.type': 'Microsoft.Dynamics.CRM.EntityMetadata',
  SchemaName: ENTITY_SCHEMA, EntitySetName: ENTITY_SET, OwnershipType: 'UserOwned', HasActivities: false, HasNotes: false,
  DisplayName: label('Historical Attendance Request'), DisplayCollectionName: label('Historical Attendance Requests'),
  Description: label('Employee requests to record attendance for a past Absent date — HR approval upserts the single attendance record.'),
  Attributes: [{
    '@odata.type': 'Microsoft.Dynamics.CRM.StringAttributeMetadata',
    SchemaName: 'hr_Name', MaxLength: 250, FormatName: { Value: 'Text' }, IsPrimaryName: true,
    RequiredLevel: req(), DisplayName: label('Name'), Description: label('Request label'),
  }],
};

const isExists = (m) => /already exists|duplicate|with the name|with a name|is not unique/i.test(m || '');
const isMissing = (m) => /Could not find|does not exist|Resource not found|was not found|404/i.test(m || '');
const isLocked = (m) => /CustomizationLockException|customization is already running|another EntityCustomization|another customization/i.test(m || '');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function post(path, body) { const headers = await d365.getHeaders({ 'Content-Type': 'application/json' }); return axios.post(`${d365.baseUrl}/${path}`, body, { headers }); }

async function createEntity(log) {
  try { await post('EntityDefinitions', ENTITY_BODY); log?.info?.('[provision] created entity hr_HistAttendance'); }
  catch (e) { const m = e.response?.data?.error?.message || e.message; if (isExists(m)) log?.info?.('[provision] entity hr_HistAttendance already exists'); else if (isLocked(m)) throw Object.assign(new Error(m), { locked: true }); else throw new Error(m); }
}

/**
 * Idempotently ensure EVERY column in COLUMNS exists — safe whether the table was just created
 * or already existed (schema-drift repair). An "already exists" column is left untouched (never
 * recreated/overwritten/deleted). A lock bubbles up (so the caller can retry); any OTHER failure
 * (e.g. insufficient privilege) is COLLECTED and returned so the caller can surface it — it is
 * never swallowed as success. Returns { added:[], existing:[], failed:[{column,error}] }.
 */
async function ensureColumns(log) {
  const added = [], existing = [], failed = [];
  for (const c of COLUMNS) {
    try { await post(`EntityDefinitions(LogicalName='${ENTITY_LOGICAL}')/Attributes`, c); added.push(c.SchemaName); }
    catch (e) {
      const m = e.response?.data?.error?.message || e.message;
      if (isExists(m)) existing.push(c.SchemaName);
      else if (isLocked(m)) throw Object.assign(new Error(m), { locked: true });
      else { failed.push({ column: c.SchemaName, error: m }); log?.warn?.(`[provision] hist-attendance column ${c.SchemaName}: ${m}`); }
    }
  }
  return { added, existing, failed };
}

// Coalesce concurrent in-process callers onto ONE provisioning attempt (no overlap / duplicate
// metadata POSTs within this worker). Cross-process safety relies on Dataverse's own
// customization lock + the retry loop below (matches the other provisioners' pattern).
let _inflight = null;

async function _run(log, opts) {
  const { retry = false, retryIntervalMs = 30000, retryTimeoutMs = 10 * 60 * 1000 } = opts;

  // 1) Probe existence. "Missing" → create; any OTHER probe error is inconclusive (don't guess).
  let tableExists = false;
  try { await d365.getList(ENTITY_SET, { top: 1 }); tableExists = true; }
  catch (e) {
    const m = e.response?.data?.error?.message || e.message;
    if (!isMissing(m)) { log?.warn?.(`[provision] hist-attendance probe inconclusive (${m}); skipping`); return { status: 'unavailable', reason: m }; }
  }

  // 2) Lock-aware loop: create the entity if absent, then ALWAYS ensure columns (repairs drift on
  //    an existing table). Column failures are surfaced as 'incomplete' — never a false success.
  const started = Date.now();
  for (;;) {
    try {
      if (!tableExists) await createEntity(log);
      const res = await ensureColumns(log);
      if (res.failed.length) {
        return { status: 'incomplete', created: !tableExists, added: res.added, existing: res.existing, failed: res.failed.map(f => f.column), reason: res.failed[0].error };
      }
      log?.info?.(`[provision] hr_histattendances ready (added ${res.added.length}, existing ${res.existing.length})`);
      return { status: tableExists ? 'exists' : 'created', added: res.added, existing: res.existing };
    } catch (e) {
      if (e.locked && retry && Date.now() - started + retryIntervalMs <= retryTimeoutMs) {
        log?.warn?.(`[provision] hist-attendance: Dataverse locked — retrying in ${retryIntervalMs / 1000}s`);
        await sleep(retryIntervalMs); continue;
      }
      log?.warn?.(`[provision] could not provision hr_histattendances: ${e.message}`);
      return { status: e.locked ? 'locked' : 'unavailable', reason: e.message };
    }
  }
}

/**
 * Ensure the hr_histattendances table AND all its columns exist (idempotent, drift-repairing,
 * lock-aware). On an existing table it verifies/adds any missing column; it never recreates,
 * overwrites or deletes an existing one. Returns a status object: 'created' | 'exists' |
 * 'incomplete' (some columns could not be added — e.g. privilege) | 'locked' | 'unavailable'.
 * NEVER reports success when a column add failed.
 */
async function ensureHistoricalAttendanceTable(log = console, opts = {}) {
  if (_inflight) return _inflight;
  _inflight = _run(log, opts).finally(() => { _inflight = null; });
  return _inflight;
}

module.exports = { ensureHistoricalAttendanceTable, ensureColumns, ENTITY_SET, COLUMNS };
