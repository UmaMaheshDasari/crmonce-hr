/**
 * Self-provisioning for the Employee Goals table (hr_hrgoals).
 *
 *   Entity  : hr_HRGoal        (logical hr_hrgoal, set hr_hrgoals, PK hr_hrgoalid)
 *   Primary : hr_HRGoal1       Text — Goal Title (logical hr_hrgoal1)
 *   Columns : hr_Description   Memo
 *             hr_Quarter       Text 10   — 'Q1'..'Q4'
 *             hr_FinancialYear Text 20   — '2025-26'
 *             hr_Priority      Text 20   — 'low'|'medium'|'high'|'critical'
 *             hr_Status        Text 20   — 'not_started'|'in_progress'|'completed'|'exceeded'|'missed'
 *             hr_Weightage     Whole Number
 *             hr_Progress      Whole Number  — completion %
 *             hr_DueDate       Text 10   — 'YYYY-MM-DD'
 *             hr_KeyResults    Memo
 *             hr_SelfRating / hr_ManagerRating   Whole Number
 *             hr_SelfComments (Employee Remarks) / hr_ManagerComments (Manager Remarks)  Memo
 *             hr_EmployeeId    Text 100  — employee GUID (stored, not a lookup)
 *             hr_EmployeeName  Text 200
 *             hr_AssignedBy    Text 200
 *             hr_AssignedDate  Text 30
 *
 * TEXT / MEMO / INTEGER columns only (Edm.String / Edm.Int32) — the backend stores
 * plain string codes and whole numbers. This mirrors hr_attendancerequests and
 * hr_holidays: no option-set integers or lookups (which Dataverse rejects on a
 * mismatched column and which are far more failure-prone to provision via the Web
 * API). The EntitySetName is fixed to 'hr_hrgoals' so it matches the name the
 * backend already uses (d365.service entities.goal).
 *
 * ensureGoalTable() is idempotent + best-effort: an existing entity/column is
 * skipped; per-column failures don't abort the rest; a missing customization
 * privilege bubbles up. addMissingColumn() repairs a partially-created schema.
 */
const axios = require('axios');
const d365 = require('./d365.service');

const ENTITY_LOGICAL = 'hr_hrgoal';
const ENTITY_SCHEMA = 'hr_HRGoal';
const ENTITY_SET = 'hr_hrgoals';

const label = (t) => ({
  '@odata.type': 'Microsoft.Dynamics.CRM.Label',
  LocalizedLabels: [{ '@odata.type': 'Microsoft.Dynamics.CRM.LocalizedLabel', Label: t, LanguageCode: 1033 }],
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
const int = (schema, display, minValue = 0, maxValue = 1000000000) => ({
  '@odata.type': 'Microsoft.Dynamics.CRM.IntegerAttributeMetadata',
  SchemaName: schema, Format: 'None', MinValue: minValue, MaxValue: maxValue,
  RequiredLevel: req(), DisplayName: label(display), Description: label(display),
});

const COLUMNS = [
  memo('hr_Description', 'Description'),
  str('hr_Quarter', 'Quarter', 10),
  str('hr_FinancialYear', 'Financial Year', 20),
  str('hr_Priority', 'Priority', 20),
  str('hr_Status', 'Status', 20),
  int('hr_Weightage', 'Weightage', 0, 100),
  int('hr_Progress', 'Completion %', 0, 100),
  str('hr_DueDate', 'Due Date', 10),
  memo('hr_KeyResults', 'Key Results'),
  int('hr_SelfRating', 'Self Rating', 0, 5),
  int('hr_ManagerRating', 'Manager Rating', 0, 5),
  memo('hr_SelfComments', 'Employee Remarks'),
  memo('hr_ManagerComments', 'Manager Remarks'),
  str('hr_EmployeeId', 'Employee Id', 100),
  str('hr_EmployeeName', 'Employee Name', 200),
  str('hr_AssignedBy', 'Assigned By', 200),
  str('hr_AssignedDate', 'Assigned Date', 30),
];

const ENTITY_BODY = {
  '@odata.type': 'Microsoft.Dynamics.CRM.EntityMetadata',
  SchemaName: ENTITY_SCHEMA, EntitySetName: ENTITY_SET, OwnershipType: 'UserOwned', HasActivities: false, HasNotes: true,
  DisplayName: label('HR Goal'), DisplayCollectionName: label('HR Goals'),
  Description: label('Employee performance goals / objectives.'),
  Attributes: [{
    '@odata.type': 'Microsoft.Dynamics.CRM.StringAttributeMetadata',
    SchemaName: 'hr_HRGoal1', MaxLength: 300, FormatName: { Value: 'Text' }, IsPrimaryName: true,
    RequiredLevel: req(), DisplayName: label('Goal Title'), Description: label('Goal title'),
  }],
};

const isExists = (m) => /already exists|duplicate|with the name|with a name|is not unique/i.test(m || '');
const isMissing = (m) => /Could not find|does not exist|Resource not found|was not found|404/i.test(m || '');
// Dataverse is mid-publish/import — a TRANSIENT lock. Retryable.
const isLocked = (m) => /CustomizationLockException|customization is already running|another EntityCustomization|another customization/i.test(m || '');
// The app registration lacks create-metadata rights — a PERMANENT config problem,
// reported separately from a lock (never conflated with it).
const isPrivilege = (m) => /prvCreate(Entity|Attribute)|System Customizer|System Administrator|insufficient privileg|is missing prv|missing .*role|SecLib|Access is denied|is not authorized|do(es)? not have .*privilege/i.test(m || '');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Classify a Dataverse error into a retry decision (lock vs privilege vs other). */
function classify(e) {
  const status = e?.response?.status;
  const m = e?.response?.data?.error?.message || e?.message || '';
  if (isExists(m)) return { kind: 'exists', message: m };
  if (isLocked(m)) return { kind: 'locked', message: m };
  if (isPrivilege(m) || status === 401 || status === 403) return { kind: 'forbidden', message: m };
  return { kind: 'error', message: m };
}

const LOCKED_MESSAGE = 'Dataverse is currently publishing or importing customizations. ' +
  'Please wait until the current customization finishes and try again.';

async function post(path, body) {
  const headers = await d365.getHeaders({ 'Content-Type': 'application/json' });
  return axios.post(`${d365.baseUrl}/${path}`, body, { headers });
}

/** Read + log the ACTUAL column types from Dataverse metadata (no guessing). */
async function inspectColumns(log) {
  try {
    const headers = await d365.getHeaders();
    const url = `${d365.baseUrl}/EntityDefinitions(LogicalName='${ENTITY_LOGICAL}')/Attributes?$select=LogicalName,AttributeType`;
    const res = await axios.get(url, { headers });
    const cols = (res.data.value || []).filter(a => String(a.LogicalName).startsWith('hr_'))
      .map(a => `${a.LogicalName}:${a.AttributeType}`).sort();
    log?.info?.(`[provision] hr_hrgoal column types → ${cols.join(', ')}`);
    return res.data.value || [];
  } catch (e) {
    log?.warn?.(`[provision] goal column inspect failed: ${e.response?.data?.error?.message || e.message}`);
    return [];
  }
}

/** Create a single missing column by its logical name (e.g. 'hr_progress'). */
async function addMissingColumn(logicalName, log) {
  const col = COLUMNS.find(c => c.SchemaName.toLowerCase() === String(logicalName).toLowerCase());
  if (!col) return false;
  try {
    await post(`EntityDefinitions(LogicalName='${ENTITY_LOGICAL}')/Attributes`, col);
    log?.info?.(`[provision] added missing goal column ${col.SchemaName}`);
    return true;
  } catch (e) {
    const m = e.response?.data?.error?.message || e.message;
    if (isExists(m)) return true;
    log?.warn?.(`[provision] could not add goal column ${col.SchemaName}: ${m}`);
    return false;
  }
}

/**
 * Attempt ONE full create pass: entity, then every column. Returns a classified
 * result. A CustomizationLockException at any point stops the pass and returns
 * {kind:'locked'} so the caller can retry later WITHOUT creating duplicates (the
 * next pass skips whatever already exists — the whole thing is idempotent).
 * @returns {Promise<{kind:'created'|'locked'|'forbidden'|'error', message?:string}>}
 */
async function tryCreatePass(log) {
  // 1. Entity (primary name attribute is created with it)
  try {
    await post('EntityDefinitions', ENTITY_BODY);
    log?.info?.('[provision] created entity hr_HRGoal');
  } catch (e) {
    const c = classify(e);
    if (c.kind === 'exists') log?.info?.('[provision] entity hr_HRGoal already exists — resuming column creation');
    else if (c.kind === 'locked' || c.kind === 'forbidden') return c;
    else return c;   // {kind:'error'}
  }
  // 2. Columns — skip existing; a lock/privilege error aborts (so we retry cleanly)
  for (const col of COLUMNS) {
    try {
      await post(`EntityDefinitions(LogicalName='${ENTITY_LOGICAL}')/Attributes`, col);
      log?.info?.(`[provision] added goal column ${col.SchemaName}`);
    } catch (e) {
      const c = classify(e);
      if (c.kind === 'exists') continue;
      if (c.kind === 'locked' || c.kind === 'forbidden') return c;
      log?.warn?.(`[provision] goal column ${col.SchemaName} failed: ${c.message}`);
    }
  }
  return { kind: 'created' };
}

/** Best-effort publish of just this entity's customizations. Lock-aware. */
async function publishEntity(log) {
  try {
    await post('PublishXml', {
      ParameterXml: `<importexportxml><entities><entity>${ENTITY_LOGICAL}</entity></entities></importexportxml>`,
    });
    log?.info?.('[provision] published hr_hrgoal customizations');
    return true;
  } catch (e) {
    const c = classify(e);
    if (c.kind === 'locked') log?.warn?.('[provision] publish deferred — Dataverse locked (table is auto-published anyway)');
    else log?.warn?.(`[provision] publish note: ${c.message}`);
    return false;
  }
}

/**
 * Read the Azure AD application user's actual Dataverse security roles (via WhoAmI)
 * and report whether it holds System Administrator or System Customizer. Used to
 * give a precise, SEPARATE diagnosis when create-metadata is refused — so a missing
 * role is never mistaken for a customization lock.
 * @returns {Promise<{ok:boolean|null, roles:string[]}>}  ok=null → couldn't read.
 */
async function verifyAppRoles(log) {
  try {
    const headers = await d365.getHeaders();
    const who = await axios.get(`${d365.baseUrl}/WhoAmI`, { headers });
    const userId = who.data.UserId;
    const url = `${d365.baseUrl}/systemusers(${userId})?$select=fullname,applicationid` +
      `&$expand=systemuserroles_association($select=name)`;
    const res = await axios.get(url, { headers });
    const roles = (res.data.systemuserroles_association || []).map((r) => r.name).filter(Boolean);
    const ok = roles.some((r) => /System Administrator|System Customizer/i.test(r));
    log?.info?.(`[provision] app user "${res.data.fullname || userId}" roles → ${roles.join(', ') || '(none)'} ` +
      `→ ${ok ? 'has customization rights' : 'MISSING System Administrator / System Customizer'}`);
    return { ok, roles };
  } catch (e) {
    log?.warn?.(`[provision] could not read app user roles: ${e.response?.data?.error?.message || e.message}`);
    return { ok: null, roles: [] };
  }
}

/** Verify the table is actually queryable (published) before we enable the feature. */
async function verifyQueryable(log, tries = 6, waitMs = 5000) {
  for (let i = 0; i < tries; i++) {
    try { await d365.getList(ENTITY_SET, { top: 1 }); return true; }
    catch (e) {
      if (!isMissing(e?.message || '')) { /* transient publish delay */ }
      log?.info?.(`[provision] waiting for hr_hrgoals to become queryable (${i + 1}/${tries})…`);
      await sleep(waitMs);
    }
  }
  return false;
}

/**
 * Ensure the Goals table exists, handling the Dataverse customization lock
 * gracefully.
 *
 * @param {{info?:Function,warn?:Function,error?:Function}} [log]
 * @param {{retry?:boolean, retryIntervalMs?:number, retryTimeoutMs?:number}} [opts]
 *   retry=true  → keep retrying on a lock every retryIntervalMs (default 30s) up to
 *                 retryTimeoutMs (default 10min). Used on startup (background).
 *   retry=false → single attempt; a lock returns immediately with a friendly
 *                 message (used on the request path so HTTP never hangs).
 * @returns {Promise<{status:'exists'|'created'|'locked'|'forbidden'|'unavailable', reason?:string, message?:string, timedOut?:boolean}>}
 */
async function ensureGoalTable(log = console, opts = {}) {
  const { retry = false, retryIntervalMs = 30000, retryTimeoutMs = 10 * 60 * 1000 } = opts;

  // ── Probe: already there? ──
  try {
    await d365.getList(ENTITY_SET, { top: 1 });
    await inspectColumns(log);
    return { status: 'exists' };
  } catch (e) {
    const c = classify(e);
    if (c.kind === 'forbidden') {
      log?.error?.('[provision] Goal table check blocked — the D365 app registration lacks ' +
        `Dataverse read rights: ${c.message}`);
      return { status: 'forbidden', reason: c.message };
    }
    if (!isMissing(c.message)) {
      log?.warn?.(`[provision] goal probe inconclusive (${c.message}); skipping auto-create`);
      return { status: 'unavailable', reason: c.message };
    }
    // else: missing → create below
  }

  // ── Create, retrying only on a transient customization lock ──
  const started = Date.now();
  let attempt = 0;
  for (;;) {
    attempt++;
    const pass = await tryCreatePass(log);

    // PRIVILEGE problem — permanent, reported SEPARATELY from a lock. Never retried.
    if (pass.kind === 'forbidden') {
      const roleCheck = await verifyAppRoles(log);   // confirm the real cause
      log?.error?.('[provision] Goal table blocked — the Azure AD app / service principal is ' +
        'missing the "System Administrator" or "System Customizer" Dataverse security role. ' +
        `This is NOT a customization lock. Dataverse said: ${pass.message}`);
      return {
        status: 'forbidden', reason: pass.message, roles: roleCheck.roles,
        message: 'The Dataverse application user is missing the System Administrator or System ' +
          'Customizer security role. Assign one of those roles to the app registration, then retry.' +
          (roleCheck.roles.length ? ` (current roles: ${roleCheck.roles.join(', ')})` : ''),
      };
    }

    // Other hard error — not a lock, not a privilege issue.
    if (pass.kind === 'error') {
      log?.warn?.(`[provision] could not create hr_hrgoals: ${pass.message}`);
      return { status: 'unavailable', reason: pass.message };
    }

    // Created (or already present) — publish + verify before enabling.
    if (pass.kind === 'created') {
      await publishEntity(log);
      if (await verifyQueryable(log)) {
        await inspectColumns(log);
        log?.info?.('[provision] hr_hrgoals ready — Goal Assignment enabled');
        return { status: 'created' };
      }
      // Created but not yet queryable → fall through to the lock/retry path.
      pass.kind = 'locked';
      pass.message = 'table created but still publishing (not yet queryable)';
    }

    // LOCKED — Dataverse is mid customization. Retry (background) or bail (request path).
    if (pass.kind === 'locked') {
      if (!retry) {
        log?.warn?.(`[provision] Dataverse locked (customization in progress): ${pass.message}`);
        return { status: 'locked', reason: pass.message, message: LOCKED_MESSAGE };
      }
      const elapsed = Date.now() - started;
      if (elapsed + retryIntervalMs > retryTimeoutMs) {
        log?.error?.(`[provision] hr_hrgoals still locked after ${Math.round(elapsed / 1000)}s ` +
          `(${attempt} attempts) — giving up. Last Dataverse error: ${pass.message}`);
        return {
          status: 'locked', reason: pass.message, timedOut: true,
          message: `Dataverse remained locked for over ${Math.round(retryTimeoutMs / 60000)} minutes. ` +
            `Last Dataverse error: ${pass.message}`,
        };
      }
      log?.warn?.(`[provision] attempt ${attempt}: Dataverse locked (customization running) — ` +
        `retrying in ${Math.round(retryIntervalMs / 1000)}s (${Math.round(elapsed / 1000)}s elapsed, ` +
        `${Math.round((retryTimeoutMs - elapsed) / 1000)}s remaining).`);
      await sleep(retryIntervalMs);
      continue;
    }
  }
}

module.exports = { ensureGoalTable, inspectColumns, addMissingColumn, verifyAppRoles, LOCKED_MESSAGE };
