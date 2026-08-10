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
const { LEAVE_REASON_MAX } = require('./leave-reason.util');

const ENTITY_LOGICAL = 'hr_hrleave';

const label = (t) => ({ '@odata.type': 'Microsoft.Dynamics.CRM.Label', LocalizedLabels: [{ '@odata.type': 'Microsoft.Dynamics.CRM.LocalizedLabel', Label: t, LanguageCode: 1033 }] });
const req = () => ({ Value: 'None', CanBeChanged: true, ManagedPropertyLogicalName: 'canmodifyrequirementlevelsettings' });
const str = (schema, display, maxLength = 100) => ({
  '@odata.type': 'Microsoft.Dynamics.CRM.StringAttributeMetadata',
  SchemaName: schema, MaxLength: maxLength, FormatName: { Value: 'Text' }, RequiredLevel: req(), DisplayName: label(display), Description: label(display),
});

const COLUMNS = [
  str('hr_MedCertDocId', 'Medical Certificate Document Id', 100),
  str('hr_UseCompOff', 'Applied Against Comp Off', 10),   // 'true' → paid from comp-off balance, never LOP
];

const isExists = (m) => /already exists|duplicate|with the name|with a name|is not unique/i.test(m || '');
const isLocked = (m) => /CustomizationLockException|customization is already running|another EntityCustomization|another customization/i.test(m || '');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function post(path, body) { const headers = await d365.getHeaders({ 'Content-Type': 'application/json' }); return axios.post(`${d365.baseUrl}/${path}`, body, { headers }); }

/**
 * Widen the EXISTING Leave Reason column (hr_reason) so long, enterprise-length
 * explanations save — the field ships as a 100-char Single-Line-of-Text column, and
 * anything longer is rejected by Dataverse. We only WIDEN a Single-Line column that
 * is below the target (retrieve → set MaxLength → put → publish). A Memo (Multiple
 * Lines) already supports huge text, and a same-type widen never loses data.
 * Best-effort: if the app user lacks customization rights it is logged and skipped
 * (no regression — the column simply stays as it was).
 */
async function ensureReasonLength(log = console, targetMax = LEAVE_REASON_MAX) {
  const attrPath = `EntityDefinitions(LogicalName='${ENTITY_LOGICAL}')/Attributes(LogicalName='hr_reason')`;
  let headers, attr;
  try { headers = await d365.getHeaders({ 'Content-Type': 'application/json' }); }
  catch (e) { return { status: 'skipped', reason: e.message }; }
  try { attr = (await axios.get(`${d365.baseUrl}/${attrPath}`, { headers })).data; }
  catch (e) { log?.warn?.(`[provision] hr_reason metadata read skipped: ${e.response?.data?.error?.message || e.message}`); return { status: 'skipped' }; }

  const otype = String(attr['@odata.type'] || '');
  if (!/StringAttributeMetadata/i.test(otype)) return { status: 'ok', note: 'not single-line', maxLength: attr.MaxLength };
  if (Number(attr.MaxLength || 0) >= targetMax) return { status: 'ok', already: true, maxLength: attr.MaxLength };

  const body = { ...attr, MaxLength: targetMax };
  delete body['@odata.context'];
  try {
    await axios.put(`${d365.baseUrl}/${attrPath}`, body, { headers: { ...headers, 'MSCRM.MergeLabels': 'true' } });
    try { await axios.post(`${d365.baseUrl}/PublishXml`, { ParameterXml: `<importexportxml><entities><entity>${ENTITY_LOGICAL}</entity></entities></importexportxml>` }, { headers }); } catch (_) { /* publish best-effort */ }
    log?.info?.(`[provision] hr_reason MaxLength ${attr.MaxLength} → ${targetMax}`);
    return { status: 'updated', from: attr.MaxLength, to: targetMax };
  } catch (e) {
    log?.warn?.(`[provision] hr_reason widen skipped: ${e.response?.data?.error?.message || e.message}`);
    return { status: 'skipped', reason: e.response?.data?.error?.message || e.message };
  }
}

async function ensureLeaveColumns(log = console, opts = {}) {
  const { retry = false, retryIntervalMs = 30000, retryTimeoutMs = 10 * 60 * 1000 } = opts;
  const started = Date.now();
  let added = 0, existing = 0; const failed = [];
  // Widen the Leave Reason column first (see above) so long reasons save.
  await ensureReasonLength(log).catch((e) => log?.warn?.(`[provision] hr_reason widen error: ${e.message}`));
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

module.exports = { ensureLeaveColumns, ensureReasonLength };
