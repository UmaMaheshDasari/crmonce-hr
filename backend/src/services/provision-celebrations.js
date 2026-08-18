/**
 * Self-provisioning for the Celebrations module — two tables, TEXT/MEMO columns
 * only, idempotent + lock-aware (mirrors provision-late-login.js):
 *
 *   hr_celebrationsettings — a single config row: per-event enable toggles,
 *      email subject/body + notification templates, and the daily send time.
 *   hr_celebrationlogs     — the audit trail: one row per (employee, event, day)
 *      with email + in-app notification status (also the duplicate-send guard).
 *
 * The module is FUTURE-READY: new event types (Festival / New Year / Diwali /
 * Christmas / Appreciation Day) reuse BOTH tables unchanged — an event type is
 * just a new `hr_type` code + template columns, never a schema change.
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

// ── hr_celebrationsettings (single-row config) ────────────────────────────────
const SETTINGS = {
  logical: 'hr_celebrationsetting', schema: 'hr_CelebrationSetting', set: 'hr_celebrationsettings',
  display: 'Celebration Settings', displayColl: 'Celebration Settings',
  columns: [
    str('hr_BirthdayEnabled', 'Enable Birthday Wishes', 6),
    str('hr_MarriageEnabled', 'Enable Marriage Anniversary Wishes', 6),
    str('hr_WorkAnnivEnabled', 'Enable Work Anniversary Wishes', 6),
    str('hr_SendTime', 'Send Time (HH:MM)', 5),
    str('hr_CCRecipients', 'Information CC Recipients', 2000),  // comma-separated info-only addresses

    // Per-event email subject + body + in-app notification templates.
    str('hr_BirthdaySubject', 'Birthday Email Subject', 200),
    memo('hr_BirthdayBody', 'Birthday Email Body'),
    memo('hr_BirthdayNotif', 'Birthday Notification Template'),
    str('hr_MarriageSubject', 'Marriage Anniversary Email Subject', 200),
    memo('hr_MarriageBody', 'Marriage Anniversary Email Body'),
    memo('hr_MarriageNotif', 'Marriage Anniversary Notification Template'),
    str('hr_WorkSubject', 'Work Anniversary Email Subject', 200),
    memo('hr_WorkBody', 'Work Anniversary Email Body'),
    memo('hr_WorkNotif', 'Work Anniversary Notification Template'),
  ],
};

// ── hr_celebrationlogs (audit + duplicate-send guard) ─────────────────────────
const LOGS = {
  logical: 'hr_celebrationlog', schema: 'hr_CelebrationLog', set: 'hr_celebrationlogs',
  display: 'Celebration Log', displayColl: 'Celebration Logs',
  columns: [
    str('hr_EmployeeId', 'Employee Id', 100),
    str('hr_EmployeeName', 'Employee Name', 200),
    str('hr_Type', 'Event Type', 40),          // birthday | marriage_anniversary | work_anniversary | (future)
    str('hr_Date', 'Date', 10),                // YYYY-MM-DD (the day the wish was sent for)
    str('hr_Time', 'Time', 30),                // ISO timestamp of the send
    str('hr_EmailStatus', 'Email Status', 20), // sent | failed | skipped | disabled
    str('hr_NotifStatus', 'Notification Status', 20),
    memo('hr_Detail', 'Detail'),               // e.g. "5 years" / recipient email / error
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

// Add every column (idempotent): an already-present column is a no-op, a lock
// bubbles up so the caller can retry, any other failure is a warning only.
async function addColumns(t, log) {
  for (const c of t.columns) {
    try { await post(`EntityDefinitions(LogicalName='${t.logical}')/Attributes`, c); }
    catch (e) { const m = e.response?.data?.error?.message || e.message; if (isLocked(m)) throw Object.assign(new Error(m), { locked: true }); if (!isExists(m)) log?.warn?.(`[provision] ${t.schema} column ${c.SchemaName}: ${m}`); }
  }
}

async function createSchema(t, log) {
  try { await post('EntityDefinitions', entityBody(t)); log?.info?.(`[provision] created entity ${t.schema}`); }
  catch (e) { const m = e.response?.data?.error?.message || e.message; if (isExists(m)) log?.info?.(`[provision] entity ${t.schema} already exists`); else if (isLocked(m)) throw Object.assign(new Error(m), { locked: true }); else throw new Error(m); }
  await addColumns(t, log);
}

async function ensureOne(t, log, opts) {
  const { retry = false, retryIntervalMs = 30000, retryTimeoutMs = 10 * 60 * 1000, ensureColumns = false } = opts;
  try {
    await d365.getList(t.set, { top: 1 });
    // Table already exists — best-effort add of any NEW columns (e.g. hr_ccrecipients
    // added after the table was first created). Idempotent; failures are non-fatal.
    if (ensureColumns) { try { await addColumns(t, log); } catch (e) { if (!e.locked) log?.warn?.(`[provision] ${t.set} column ensure skipped: ${e.message}`); } }
    return { status: 'exists' };
  }
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

/** Ensure BOTH celebration tables exist. Best-effort, lock-aware. */
async function ensureCelebrationTables(log = console, opts = {}) {
  // ensureColumns on the settings table so a newly-added column (hr_ccrecipients)
  // is provisioned onto an already-existing table, not only on fresh installs.
  const settings = await ensureOne(SETTINGS, log, { ...opts, ensureColumns: true });
  const logs = await ensureOne(LOGS, log, opts);
  return { settings, logs };
}

module.exports = { ensureCelebrationTables, SETTINGS_SET: SETTINGS.set, LOGS_SET: LOGS.set };
