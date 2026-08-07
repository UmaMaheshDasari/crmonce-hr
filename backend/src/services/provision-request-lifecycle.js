/**
 * Self-provisioning for the shared Request Lifecycle (TEXT/MEMO columns only,
 * idempotent + lock-aware — mirrors provision-celebrations.js):
 *
 *   hr_requestaudit        — one row per lifecycle action (edited / deleted /
 *      resubmitted / cancellation_requested / cancellation_approved /
 *      cancellation_rejected) across EVERY request module. The single audit trail.
 *   hr_cancellationrequests — the cancellation workflow for an APPROVED request:
 *      employee → manager → HR. Keyed by (requestType, requestId) so ANY module
 *      reuses it with no schema change of its own.
 *
 * These two tables + request-lifecycle.service.js are the whole reusable core:
 * a new request module joins the lifecycle by registering an adapter, never by
 * duplicating delete/resubmit/cancel/audit/notify logic.
 */
const axios = require('axios');
const d365 = require('./d365.service');

const label = (t) => ({ '@odata.type': 'Microsoft.Dynamics.CRM.Label', LocalizedLabels: [{ '@odata.type': 'Microsoft.Dynamics.CRM.LocalizedLabel', Label: t, LanguageCode: 1033 }] });
const req = () => ({ Value: 'None', CanBeChanged: true, ManagedPropertyLogicalName: 'canmodifyrequirementlevelsettings' });
const str = (schema, display, maxLength = 200) => ({
  '@odata.type': 'Microsoft.Dynamics.CRM.StringAttributeMetadata',
  SchemaName: schema, MaxLength: maxLength, FormatName: { Value: 'Text' }, RequiredLevel: req(), DisplayName: label(display), Description: label(display),
});
const memo = (schema, display, maxLength = 4000) => ({
  '@odata.type': 'Microsoft.Dynamics.CRM.MemoAttributeMetadata',
  SchemaName: schema, MaxLength: maxLength, Format: 'Text', RequiredLevel: req(), DisplayName: label(display), Description: label(display),
});

const AUDIT = {
  logical: 'hr_requestaudit', schema: 'hr_RequestAudit', set: 'hr_requestaudits',
  display: 'Request Audit', displayColl: 'Request Audit',
  columns: [
    str('hr_EmployeeId', 'Employee Id', 100),
    str('hr_EmployeeName', 'Employee Name', 200),
    str('hr_RequestId', 'Request Id', 100),
    str('hr_RequestType', 'Request Type', 40),
    str('hr_Action', 'Action', 40),
    str('hr_PerformedBy', 'Performed By', 200),
    str('hr_At', 'Timestamp', 30),
    memo('hr_Detail', 'Detail'),
  ],
};

const CANCEL = {
  logical: 'hr_cancellationrequest', schema: 'hr_CancellationRequest', set: 'hr_cancellationrequests',
  display: 'Cancellation Request', displayColl: 'Cancellation Requests',
  columns: [
    str('hr_EmployeeId', 'Employee Id', 100),
    str('hr_EmployeeName', 'Employee Name', 200),
    str('hr_RequestId', 'Request Id', 100),
    str('hr_RequestType', 'Request Type', 40),
    str('hr_Status', 'Status', 20),            // pending | approved | rejected
    str('hr_ManagerStatus', 'Manager Status', 20),
    str('hr_ApprovedBy', 'Approved By', 200),
    str('hr_ApprovedDate', 'Approved Date', 30),
    memo('hr_Reason', 'Reason'),
    memo('hr_Remarks', 'Remarks'),
  ],
};

const primary = { '@odata.type': 'Microsoft.Dynamics.CRM.StringAttributeMetadata', SchemaName: 'hr_Name', MaxLength: 250, FormatName: { Value: 'Text' }, IsPrimaryName: true, RequiredLevel: req(), DisplayName: label('Name'), Description: label('Label') };
const entityBody = (t) => ({
  '@odata.type': 'Microsoft.Dynamics.CRM.EntityMetadata',
  SchemaName: t.schema, EntitySetName: t.set, OwnershipType: 'UserOwned', HasActivities: false, HasNotes: false,
  DisplayName: label(t.display), DisplayCollectionName: label(t.displayColl), Description: label(t.display),
  Attributes: [primary],
});

const isExists = (m) => /already exists|duplicate|with the name|with a name|is not unique/i.test(m || '');
const isMissing = (m) => /Could not find|does not exist|Resource not found|was not found|404/i.test(m || '');
const isLocked = (m) => /CustomizationLockException|customization is already running|another EntityCustomization|another customization/i.test(m || '');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function post(path, body) { const headers = await d365.getHeaders({ 'Content-Type': 'application/json' }); return axios.post(`${d365.baseUrl}/${path}`, body, { headers }); }

async function createSchema(t, log) {
  try { await post('EntityDefinitions', entityBody(t)); log?.info?.(`[provision] created entity ${t.schema}`); }
  catch (e) { const m = e.response?.data?.error?.message || e.message; if (isExists(m)) log?.info?.(`[provision] entity ${t.schema} already exists`); else if (isLocked(m)) throw Object.assign(new Error(m), { locked: true }); else throw new Error(m); }
  for (const c of t.columns) {
    try { await post(`EntityDefinitions(LogicalName='${t.logical}')/Attributes`, c); }
    catch (e) { const m = e.response?.data?.error?.message || e.message; if (isLocked(m)) throw Object.assign(new Error(m), { locked: true }); if (!isExists(m)) log?.warn?.(`[provision] ${t.schema} column ${c.SchemaName}: ${m}`); }
  }
}

async function ensureOne(t, log, opts) {
  const { retry = false, retryIntervalMs = 30000, retryTimeoutMs = 10 * 60 * 1000 } = opts;
  try { await d365.getList(t.set, { top: 1 }); return { status: 'exists' }; }
  catch (e) {
    const m = e.response?.data?.error?.message || e.message;
    if (!isMissing(m)) { log?.warn?.(`[provision] ${t.set} probe inconclusive (${m}); skipping`); return { status: 'unavailable', reason: m }; }
  }
  const started = Date.now();
  for (;;) {
    try { await createSchema(t, log); log?.info?.(`[provision] ${t.set} ready`); return { status: 'created' }; }
    catch (e) {
      if (e.locked && retry && Date.now() - started + retryIntervalMs <= retryTimeoutMs) {
        log?.warn?.(`[provision] ${t.set}: Dataverse locked — retrying in ${retryIntervalMs / 1000}s`);
        await sleep(retryIntervalMs); continue;
      }
      log?.warn?.(`[provision] could not auto-create ${t.set}: ${e.message}`);
      return { status: e.locked ? 'locked' : 'unavailable', reason: e.message };
    }
  }
}

/** Ensure BOTH lifecycle tables exist. Best-effort, lock-aware. */
async function ensureRequestLifecycleTables(log = console, opts = {}) {
  const audit = await ensureOne(AUDIT, log, opts);
  const cancel = await ensureOne(CANCEL, log, opts);
  return { audit, cancel };
}

module.exports = { ensureRequestLifecycleTables, AUDIT_SET: AUDIT.set, CANCEL_SET: CANCEL.set };
