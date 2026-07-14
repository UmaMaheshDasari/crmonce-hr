/**
 * Provision the Shift columns on the HR Employee table (hr_hremployee) via the
 * Dataverse metadata API. Idempotent — skips columns that already exist.
 *
 *   hr_ShiftName       "Shift Name"        Single Line of Text  (default General Shift)
 *   hr_ShiftStartTime  "Shift Start Time"  Single Line of Text  HH:mm  (09:00)
 *   hr_ShiftEndTime    "Shift End Time"    Single Line of Text  HH:mm  (18:00)
 *
 * Requires an app registration with the System Customizer / System Administrator
 * role (metadata write). Run ON THE SERVER (needs backend/.env):
 *   node scripts/create-shift-columns.js            # preview (dry-run)
 *   node scripts/create-shift-columns.js --apply    # actually create
 * After creating, run:  node scripts/migrate-shifts.js --apply
 */
require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const axios = require('axios');
const DRY = !process.argv.includes('--apply');
const ENTITY_LOGICAL = 'hr_hremployee';

const label = (text) => ({
  '@odata.type': 'Microsoft.Dynamics.CRM.Label',
  LocalizedLabels: [{ '@odata.type': 'Microsoft.Dynamics.CRM.LocalizedLabel', Label: text, LanguageCode: 1033 }],
});

const COLUMNS = [
  { schema: 'hr_ShiftName',      display: 'Shift Name',       desc: 'Employee shift name (e.g. General Shift).', maxLength: 100 },
  { schema: 'hr_ShiftStartTime', display: 'Shift Start Time', desc: 'Shift start time in HH:mm (e.g. 09:00).',   maxLength: 10 },
  { schema: 'hr_ShiftEndTime',   display: 'Shift End Time',   desc: 'Shift end time in HH:mm (e.g. 18:00).',     maxLength: 10 },
];

(async () => {
  const d365 = require('../src/services/d365.service');
  console.log(`\n=== Create Shift columns on ${ENTITY_LOGICAL} (${DRY ? 'DRY-RUN' : 'APPLY'}) ===\n`);

  for (const c of COLUMNS) {
    const body = {
      '@odata.type': 'Microsoft.Dynamics.CRM.StringAttributeMetadata',
      SchemaName: c.schema,
      MaxLength: c.maxLength,
      FormatName: { Value: 'Text' },
      RequiredLevel: { Value: 'ApplicationRequired', CanBeChanged: true, ManagedPropertyLogicalName: 'canmodifyrequirementlevelsettings' },
      DisplayName: label(c.display),
      Description: label(c.desc),
    };
    if (DRY) { console.log(`  [dry-run] ${c.schema.padEnd(18)} "${c.display}" (${c.maxLength})`); continue; }

    const headers = await d365.getHeaders({ 'Content-Type': 'application/json' });
    try {
      await axios.post(`${d365.baseUrl}/EntityDefinitions(LogicalName='${ENTITY_LOGICAL}')/Attributes`, body, { headers });
      console.log(`  created ${c.schema}`);
    } catch (e) {
      const msg = e.response?.data?.error?.message || e.message;
      if (/already exists|duplicate|with the name/i.test(msg)) console.log(`  exists  ${c.schema} (skipped)`);
      else { console.error(`  FAIL    ${c.schema}: ${msg}`); process.exit(1); }
    }
  }

  console.log(DRY
    ? '\nDRY-RUN — nothing created. Re-run with --apply.\n'
    : '\nDone. Publish customizations if needed, then: node scripts/migrate-shifts.js --apply\n');
  process.exit(0);
})().catch(e => { console.error('FAIL:', e.response?.data?.error?.message || e.message); process.exit(1); });
