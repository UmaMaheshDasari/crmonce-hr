/**
 * Self-provisioning for the RBAC Security Audit Log (hr_auditlogs) — an APPEND-ONLY
 * record of security-sensitive / admin actions covered by the RBAC guards: who did
 * what action on which target, what permission was required, and whether it was
 * allowed or denied. Complements (does NOT duplicate) the field-diff trails
 * hr_settingsaudits / hr_attendanceaudits / hr_profileaudits.
 * TEXT/MEMO columns, idempotent, lock-aware. Mirrors provision-settings-audit.js.
 *
 *   Entity : hr_AuditLog (logical hr_auditlog, set hr_auditlogs)
 *   Primary: hr_Name
 */
const axios = require('axios');
const d365 = require('./d365.service');

const ENTITY_LOGICAL = 'hr_auditlog';
const ENTITY_SCHEMA = 'hr_AuditLog';
const ENTITY_SET = 'hr_auditlogs';

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

const COLUMNS = [
  str('hr_Action', 'Action', 100),          // e.g. 'leave.approve' or 'PATCH /api/payroll/:id/unlock'
  str('hr_Category', 'Category', 40),        // module, e.g. 'leave' | 'payroll'
  str('hr_Actor', 'Actor', 200),            // name / email
  str('hr_ActorId', 'Actor Id', 60),
  str('hr_ActorRole', 'Actor Role', 40),
  str('hr_Required', 'Required Permission', 150),
  str('hr_Method', 'HTTP Method', 10),
  memo('hr_Path', 'Request Path'),
  str('hr_TargetId', 'Target Id', 100),
  str('hr_Outcome', 'Outcome', 20),          // success | denied | error
  str('hr_StatusCode', 'Status Code', 10),
  str('hr_Ip', 'IP Address', 60),
  str('hr_OccurredOn', 'Occurred On', 30),   // ISO timestamp
  memo('hr_Details', 'Details'),
];

const ENTITY_BODY = {
  '@odata.type': 'Microsoft.Dynamics.CRM.EntityMetadata',
  SchemaName: ENTITY_SCHEMA, EntitySetName: ENTITY_SET, OwnershipType: 'UserOwned', HasActivities: false, HasNotes: false,
  DisplayName: label('Audit Log'), DisplayCollectionName: label('Audit Logs'),
  Description: label('Append-only security audit of RBAC-protected admin actions (who / what / target / outcome).'),
  Attributes: [{
    '@odata.type': 'Microsoft.Dynamics.CRM.StringAttributeMetadata',
    SchemaName: 'hr_Name', MaxLength: 250, FormatName: { Value: 'Text' }, IsPrimaryName: true,
    RequiredLevel: req(), DisplayName: label('Name'), Description: label('Audit title'),
  }],
};

const isExists = (m) => /already exists|duplicate|with the name|with a name|is not unique/i.test(m || '');
const isMissing = (m) => /Could not find|does not exist|Resource not found|was not found|404/i.test(m || '');
const isLocked = (m) => /CustomizationLockException|customization is already running|another EntityCustomization|another customization/i.test(m || '');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function post(path, body) { const headers = await d365.getHeaders({ 'Content-Type': 'application/json' }); return axios.post(`${d365.baseUrl}/${path}`, body, { headers }); }

async function createSchema(log) {
  try { await post('EntityDefinitions', ENTITY_BODY); log?.info?.('[provision] created entity hr_AuditLog'); }
  catch (e) { const m = e.response?.data?.error?.message || e.message; if (isExists(m)) log?.info?.('[provision] entity hr_AuditLog already exists'); else if (isLocked(m)) throw Object.assign(new Error(m), { locked: true }); else throw new Error(m); }
  for (const c of COLUMNS) {
    try { await post(`EntityDefinitions(LogicalName='${ENTITY_LOGICAL}')/Attributes`, c); }
    catch (e) { const m = e.response?.data?.error?.message || e.message; if (isLocked(m)) throw Object.assign(new Error(m), { locked: true }); if (!isExists(m)) log?.warn?.(`[provision] audit-log column ${c.SchemaName}: ${m}`); }
  }
}

async function ensureAuditLogTable(log = console, opts = {}) {
  const { retry = false, retryIntervalMs = 30000, retryTimeoutMs = 10 * 60 * 1000 } = opts;
  try { await d365.getList(ENTITY_SET, { top: 1 }); return { status: 'exists' }; }
  catch (e) { const m = e.response?.data?.error?.message || e.message; if (!isMissing(m)) return { status: 'unavailable', reason: m }; }
  const started = Date.now();
  for (;;) {
    try { await createSchema(log); log?.info?.('[provision] hr_auditlogs ready'); return { status: 'created' }; }
    catch (e) {
      if (e.locked && retry && Date.now() - started + retryIntervalMs <= retryTimeoutMs) { log?.warn?.('[provision] audit-log: Dataverse locked — retrying in 30s'); await sleep(retryIntervalMs); continue; }
      log?.warn?.(`[provision] could not auto-create hr_auditlogs: ${e.message}`);
      return { status: e.locked ? 'locked' : 'unavailable', reason: e.message };
    }
  }
}

module.exports = { ensureAuditLogTable, ENTITY_SET };
