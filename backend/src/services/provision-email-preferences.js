/**
 * Self-provisioning for per-employee, per-category Email Notification Preferences
 * (hr_emailpreferences). One row per (employee, category) holds the enabled/disabled
 * state plus who changed it and when. Mirrors provision-late-login (TEXT/MEMO only,
 * idempotent, lock-aware). Nothing here runs against production automatically — it is
 * invoked on demand; the preferences service fails OPEN (all categories enabled) until
 * the table exists, so email delivery is never affected by a missing table.
 *
 * Uniqueness of (employee + category) is enforced in the service (upsert by lookup),
 * because Dataverse alternate keys are not reliably provisionable by the app user.
 */
const axios = require('axios');
const d365 = require('./d365.service');

const ENTITY_LOGICAL = 'hr_emailpreference';
const ENTITY_SCHEMA = 'hr_EmailPreference';
const ENTITY_SET = 'hr_emailpreferences';

const label = (t) => ({ '@odata.type': 'Microsoft.Dynamics.CRM.Label', LocalizedLabels: [{ '@odata.type': 'Microsoft.Dynamics.CRM.LocalizedLabel', Label: t, LanguageCode: 1033 }] });
const reqLevel = () => ({ Value: 'None', CanBeChanged: true, ManagedPropertyLogicalName: 'canmodifyrequirementlevelsettings' });
const str = (schema, display, maxLength = 100) => ({
  '@odata.type': 'Microsoft.Dynamics.CRM.StringAttributeMetadata',
  SchemaName: schema, MaxLength: maxLength, FormatName: { Value: 'Text' }, RequiredLevel: reqLevel(), DisplayName: label(display), Description: label(display),
});

const COLUMNS = [
  str('hr_EmployeeId', 'Employee Id', 100),
  str('hr_EmployeeName', 'Employee Name', 200),
  str('hr_Category', 'Category Key', 60),       // stable category key (see email-categories.js)
  str('hr_Enabled', 'Enabled', 10),            // 'true' | 'false' (string boolean, project convention)
  str('hr_ChangedBy', 'Changed By', 200),
  str('hr_ChangedByRole', 'Changed By Role', 40),
  str('hr_ChangedOn', 'Changed On', 30),       // ISO timestamp
];

const ENTITY_BODY = {
  '@odata.type': 'Microsoft.Dynamics.CRM.EntityMetadata',
  SchemaName: ENTITY_SCHEMA, EntitySetName: ENTITY_SET, OwnershipType: 'UserOwned', HasActivities: false, HasNotes: false,
  DisplayName: label('Email Preference'), DisplayCollectionName: label('Email Preferences'),
  Description: label('Per-employee, per-category automated-email notification preference.'),
  Attributes: [{
    '@odata.type': 'Microsoft.Dynamics.CRM.StringAttributeMetadata',
    SchemaName: 'hr_Name', MaxLength: 250, FormatName: { Value: 'Text' }, IsPrimaryName: true,
    RequiredLevel: reqLevel(), DisplayName: label('Name'), Description: label('employeeId:category label'),
  }],
};

const isExists = (m) => /already exists|duplicate|with the name|with a name|is not unique/i.test(m || '');
const isMissing = (m) => /Could not find|does not exist|Resource not found|was not found|404/i.test(m || '');
const isLocked = (m) => /CustomizationLockException|customization is already running|another EntityCustomization|another customization/i.test(m || '');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function post(path, body) { const headers = await d365.getHeaders({ 'Content-Type': 'application/json' }); return axios.post(`${d365.baseUrl}/${path}`, body, { headers }); }

// Alternate key on (hr_employeeid, hr_category) — DB-level uniqueness for the pair, so a
// duplicate create is rejected atomically (and enables upsert). Activation is asynchronous in
// Dataverse; the service also catches duplicate-key conflicts, so correctness never depends on
// the key being active yet.
const ALT_KEY = {
  '@odata.type': 'Microsoft.Dynamics.CRM.EntityKeyMetadata',
  SchemaName: 'hr_EmployeeCategoryKey',
  DisplayName: label('Employee + Category'),
  KeyAttributes: ['hr_employeeid', 'hr_category'],
};

async function createSchema(log) {
  try { await post('EntityDefinitions', ENTITY_BODY); log?.info?.('[provision] created entity hr_EmailPreference'); }
  catch (e) { const m = e.response?.data?.error?.message || e.message; if (isExists(m)) log?.info?.('[provision] entity hr_EmailPreference already exists'); else if (isLocked(m)) throw Object.assign(new Error(m), { locked: true }); else throw new Error(m); }
  for (const c of COLUMNS) {
    try { await post(`EntityDefinitions(LogicalName='${ENTITY_LOGICAL}')/Attributes`, c); }
    catch (e) { const m = e.response?.data?.error?.message || e.message; if (isLocked(m)) throw Object.assign(new Error(m), { locked: true }); if (!isExists(m)) log?.warn?.(`[provision] email-pref column ${c.SchemaName}: ${m}`); }
  }
  // Alternate key (best-effort — requires the key columns above to exist first).
  try { await post(`EntityDefinitions(LogicalName='${ENTITY_LOGICAL}')/Keys`, ALT_KEY); log?.info?.('[provision] created alt key hr_EmployeeCategoryKey'); }
  catch (e) { const m = e.response?.data?.error?.message || e.message; if (!isExists(m)) log?.warn?.(`[provision] email-pref alt key: ${m}`); }
}

async function ensureEmailPreferencesTable(log = console, opts = {}) {
  const { retry = false, retryIntervalMs = 30000, retryTimeoutMs = 10 * 60 * 1000 } = opts;
  // Reachability probe only (NOT a decision to skip): if Dataverse is unreachable for a reason
  // OTHER than the table being missing, skip quietly. Otherwise ALWAYS run createSchema, which is
  // fully idempotent — it creates the entity if absent and BACKFILLS any missing columns / the
  // alternate key on an already-existing (possibly partially-provisioned) table. This repairs the
  // "entity created but columns missing → 0x80060888 'Could not find a property named hr_employeeid'"
  // state that a plain "exists → return" check would never fix.
  let existed = true;
  try { await d365.getList(ENTITY_SET, { top: 1 }); }
  catch (e) {
    const m = e.response?.data?.error?.message || e.message;
    if (isMissing(m)) { existed = false; }
    else { log?.warn?.(`[provision] email-pref probe inconclusive (${m}); skipping`); return { status: 'unavailable', reason: m }; }
  }
  const started = Date.now();
  for (;;) {
    try { await createSchema(log); log?.info?.(`[provision] hr_emailpreferences ready (${existed ? 'backfilled' : 'created'})`); return { status: existed ? 'backfilled' : 'created' }; }
    catch (e) {
      if (e.locked && retry && Date.now() - started + retryIntervalMs <= retryTimeoutMs) {
        log?.warn?.(`[provision] email-pref: Dataverse locked — retrying in ${retryIntervalMs / 1000}s`);
        await sleep(retryIntervalMs); continue;
      }
      log?.warn?.(`[provision] could not ensure hr_emailpreferences schema: ${e.message}`);
      return { status: e.locked ? 'locked' : 'unavailable', reason: e.message };
    }
  }
}

module.exports = { ensureEmailPreferencesTable, ENTITY_SET, ENTITY_LOGICAL, COLUMNS };
