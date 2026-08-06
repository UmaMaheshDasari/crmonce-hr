/**
 * Adds the Medical-Certificate link column to the EXISTING Leave table
 * (hr_hrleave). A Sick-Leave request of 2+ days carries a mandatory medical
 * certificate, stored as a normal document (hr_hrdocuments) whose id we keep
 * here so HR can view/verify it and the approval guard can enforce it.
 *
 * Idempotent, best-effort, lock-aware — mirrors provision-payroll-columns.js.
 */
const axios = require('axios');
const d365 = require('./d365.service');

const ENTITY_LOGICAL = 'hr_hrleave';

const label = (t) => ({ '@odata.type': 'Microsoft.Dynamics.CRM.Label', LocalizedLabels: [{ '@odata.type': 'Microsoft.Dynamics.CRM.LocalizedLabel', Label: t, LanguageCode: 1033 }] });
const req = () => ({ Value: 'None', CanBeChanged: true, ManagedPropertyLogicalName: 'canmodifyrequirementlevelsettings' });
const str = (schema, display, maxLength = 100) => ({
  '@odata.type': 'Microsoft.Dynamics.CRM.StringAttributeMetadata',
  SchemaName: schema, MaxLength: maxLength, FormatName: { Value: 'Text' }, RequiredLevel: req(), DisplayName: label(display), Description: label(display),
});

const COLUMNS = [
  str('hr_MedCertDocId', 'Medical Certificate Document Id', 100),
];

const isExists = (m) => /already exists|duplicate|with the name|with a name|is not unique/i.test(m || '');
const isLocked = (m) => /CustomizationLockException|customization is already running|another EntityCustomization|another customization/i.test(m || '');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function post(path, body) { const headers = await d365.getHeaders({ 'Content-Type': 'application/json' }); return axios.post(`${d365.baseUrl}/${path}`, body, { headers }); }

async function ensureLeaveColumns(log = console, opts = {}) {
  const { retry = false, retryIntervalMs = 30000, retryTimeoutMs = 10 * 60 * 1000 } = opts;
  const started = Date.now();
  let added = 0, existing = 0; const failed = [];
  for (const col of COLUMNS) {
    for (;;) {
      try { await post(`EntityDefinitions(LogicalName='${ENTITY_LOGICAL}')/Attributes`, col); added++; log?.info?.(`[provision] added leave column ${col.SchemaName}`); break; }
      catch (e) {
        const m = e.response?.data?.error?.message || e.message;
        if (isExists(m)) { existing++; break; }
        if (isLocked(m) && retry && Date.now() - started + retryIntervalMs <= retryTimeoutMs) {
          log?.warn?.(`[provision] leave columns: Dataverse locked — retrying in ${retryIntervalMs / 1000}s`);
          await sleep(retryIntervalMs); continue;
        }
        failed.push(col.SchemaName); log?.warn?.(`[provision] leave column ${col.SchemaName}: ${m}`); break;
      }
    }
  }
  log?.info?.(`[provision] leave columns → added ${added}, existing ${existing}, failed ${failed.length}`);
  return { status: failed.length ? 'partial' : 'ok', added, existing, failed };
}

module.exports = { ensureLeaveColumns };
