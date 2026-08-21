/**
 * Self-provisioning for the Shift History table (hr_shifthistories) — an
 * effective-dated shift assignment per employee. Mirrors provision-salary-structure.js:
 * TEXT / MEMO columns only (the employee is stored as a GUID string in hr_employeeid
 * + denormalised hr_employeename). Idempotent, best-effort, lock-aware.
 *
 * WHY: attendance (Late Login, Early Out, off/working-day, expected hours) must use the
 * shift that was EFFECTIVE on the attendance date — never the employee's current shift.
 * Each shift change appends a NEW row (never overwrites); the row whose hr_effectivefrom
 * is the latest ≤ the attendance date is authoritative for that date. If an employee has
 * NO history rows, callers fall back to the employee's current shift fields (unchanged
 * behaviour) so existing data keeps working.
 *
 *   Entity  : hr_ShiftHistory (logical hr_shifthistory, set hr_shifthistories)
 *   Primary : hr_Name  — auto-labelled "<EmployeeName> · <ShiftName> · <EffectiveFrom>"
 */
const axios = require('axios');
const d365 = require('./d365.service');

const ENTITY_LOGICAL = 'hr_shifthistory';
const ENTITY_SCHEMA = 'hr_ShiftHistory';
const ENTITY_SET = 'hr_shifthistories';

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
  str('hr_EmployeeId', 'Employee Id', 100),
  str('hr_EmployeeName', 'Employee Name', 200),
  str('hr_ShiftName', 'Shift Name', 100),
  str('hr_ShiftStartTime', 'Shift Start Time', 10),   // "HH:mm"
  str('hr_ShiftEndTime', 'Shift End Time', 10),       // "HH:mm"
  str('hr_GraceMins', 'Grace Minutes', 6),            // late-login grace for THIS shift (default 5)
  str('hr_EffectiveFrom', 'Effective From', 10),      // "YYYY-MM-DD" — this row applies from this date
  str('hr_EffectiveTo', 'Effective To', 10),          // "YYYY-MM-DD" or '' (open / current)
  str('hr_Status', 'Status', 20),                     // active | superseded
  str('hr_ChangedBy', 'Changed By', 200),
  str('hr_ChangedOn', 'Changed On', 30),
  memo('hr_Reason', 'Reason'),
];

const ENTITY_BODY = {
  '@odata.type': 'Microsoft.Dynamics.CRM.EntityMetadata',
  SchemaName: ENTITY_SCHEMA, EntitySetName: ENTITY_SET, OwnershipType: 'UserOwned', HasActivities: false, HasNotes: false,
  DisplayName: label('Shift History'), DisplayCollectionName: label('Shift History'),
  Description: label('Effective-dated shift assignment per employee (never overwritten — each change is a new version). Attendance resolves the shift by attendance date.'),
  Attributes: [{
    '@odata.type': 'Microsoft.Dynamics.CRM.StringAttributeMetadata',
    SchemaName: 'hr_Name', MaxLength: 250, FormatName: { Value: 'Text' }, IsPrimaryName: true,
    RequiredLevel: req(), DisplayName: label('Name'), Description: label('Shift history label'),
  }],
};

const isExists = (m) => /already exists|duplicate|with the name|with a name|is not unique/i.test(m || '');
const isMissing = (m) => /Could not find|does not exist|Resource not found|was not found|404/i.test(m || '');
const isLocked = (m) => /CustomizationLockException|customization is already running|another EntityCustomization|another customization/i.test(m || '');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function post(path, body) { const headers = await d365.getHeaders({ 'Content-Type': 'application/json' }); return axios.post(`${d365.baseUrl}/${path}`, body, { headers }); }

/** Create a single missing column by its logical name. Repairs a partial schema. */
async function addMissingColumn(logicalName, log) {
  const col = COLUMNS.find(c => c.SchemaName.toLowerCase() === String(logicalName).toLowerCase());
  if (!col) return false;
  try { await post(`EntityDefinitions(LogicalName='${ENTITY_LOGICAL}')/Attributes`, col); log?.info?.(`[provision] added shift-history column ${col.SchemaName}`); return true; }
  catch (e) { const m = e.response?.data?.error?.message || e.message; if (isExists(m)) return true; log?.warn?.(`[provision] shift-history column ${col.SchemaName}: ${m}`); return false; }
}

async function createSchema(log) {
  try { await post('EntityDefinitions', ENTITY_BODY); log?.info?.('[provision] created entity hr_ShiftHistory'); }
  catch (e) { const m = e.response?.data?.error?.message || e.message; if (isExists(m)) log?.info?.('[provision] entity hr_ShiftHistory already exists'); else if (isLocked(m)) throw Object.assign(new Error(m), { locked: true }); else throw new Error(m); }
  for (const c of COLUMNS) {
    try { await post(`EntityDefinitions(LogicalName='${ENTITY_LOGICAL}')/Attributes`, c); }
    catch (e) { const m = e.response?.data?.error?.message || e.message; if (isLocked(m)) throw Object.assign(new Error(m), { locked: true }); if (!isExists(m)) log?.warn?.(`[provision] shift-history column ${c.SchemaName}: ${m}`); }
  }
}

/**
 * @returns {Promise<{status:'exists'|'created'|'unavailable'|'locked', reason?:string}>}
 */
async function ensureShiftHistoryTable(log = console, opts = {}) {
  const { retry = false, retryIntervalMs = 30000, retryTimeoutMs = 10 * 60 * 1000 } = opts;
  try {
    await d365.getList(ENTITY_SET, { top: 1 });
    return { status: 'exists' };
  } catch (e) {
    const m = e.response?.data?.error?.message || e.message;
    if (!isMissing(m)) { log?.warn?.(`[provision] shift-history probe inconclusive (${m}); skipping`); return { status: 'unavailable', reason: m }; }
  }
  const started = Date.now();
  for (;;) {
    try {
      await createSchema(log);
      log?.info?.('[provision] hr_shifthistories ready');
      return { status: 'created' };
    } catch (e) {
      if (e.locked && retry && Date.now() - started + retryIntervalMs <= retryTimeoutMs) {
        log?.warn?.(`[provision] shift-history: Dataverse locked — retrying in ${retryIntervalMs / 1000}s`);
        await sleep(retryIntervalMs); continue;
      }
      log?.warn?.(`[provision] could not auto-create hr_shifthistories: ${e.message}`);
      return { status: e.locked ? 'locked' : 'unavailable', reason: e.message };
    }
  }
}

module.exports = { ensureShiftHistoryTable, addMissingColumn, ENTITY_SET };
