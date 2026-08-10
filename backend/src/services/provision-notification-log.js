/**
 * Self-provisioning for the Notification Ledger — ONE table, TEXT/MEMO columns,
 * idempotent + lock-aware (mirrors provision-celebrations.js).
 *
 *   hr_notificationlogs — one row per notification the system decided to send. It
 *     is BOTH the duplicate-send guard AND the email audit (§10 + §17):
 *       • idempotency key  hr_key = `${employeeId}|${date}|${type}` (+ hr_status)
 *       • audit fields      type / entity / requestId / employee / to / cc / status
 *                           / error / attemptedAt / sentAt
 *
 * A notification is recorded 'sent' ONLY after Graph confirms delivery; a failure
 * is recorded 'failed' (with the error) so it can be retried WITHOUT ever sending a
 * duplicate of one that already succeeded.
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

const LOG = {
  logical: 'hr_notificationlog', schema: 'hr_NotificationLog', set: 'hr_notificationlogs',
  display: 'Notification Log', displayColl: 'Notification Logs',
  columns: [
    str('hr_Key', 'Idempotency Key', 300),        // `${employeeId}|${date}|${type}`
    str('hr_EmployeeId', 'Employee Id', 100),
    str('hr_Date', 'Date', 10),                   // YYYY-MM-DD (or '' for date-less types)
    str('hr_Type', 'Notification Type', 60),      // MISSING_PUNCH | LATE_LOGIN | ...
    str('hr_Status', 'Status', 20),               // sent | failed
    str('hr_To', 'To', 300),
    str('hr_Cc', 'Cc', 400),
    str('hr_Subject', 'Subject', 300),
    str('hr_Entity', 'Entity', 60),               // e.g. attendance / leave
    str('hr_RequestId', 'Request Id', 100),
    str('hr_AttemptedAt', 'Attempted At', 30),    // ISO
    str('hr_SentAt', 'Sent At', 30),              // ISO (only when status=sent)
    memo('hr_Error', 'Error'),
  ],
};

const primaryAttr = (schema) => ({
  '@odata.type': 'Microsoft.Dynamics.CRM.StringAttributeMetadata',
  SchemaName: `${schema.split('_')[0]}_Name`, MaxLength: 250, FormatName: { Value: 'Text' }, IsPrimaryName: true,
  RequiredLevel: req(), DisplayName: label('Name'), Description: label('Label'),
});
const entityBody = (t) => ({
  '@odata.type': 'Microsoft.Dynamics.CRM.EntityMetadata',
  SchemaName: t.schema, EntitySetName: t.set, OwnershipType: 'UserOwned', HasActivities: false, HasNotes: false,
  DisplayName: label(t.display), DisplayCollectionName: label(t.displayColl), Description: label(t.display),
  Attributes: [{ ...primaryAttr(t.schema), SchemaName: 'hr_Name' }],
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

/** Ensure the notification-log table exists. Best-effort, lock-aware. */
async function ensureNotificationLogTable(log = console, opts = {}) {
  return ensureOne(LOG, log, opts);
}

module.exports = { ensureNotificationLogTable, LOG_SET: LOG.set };
