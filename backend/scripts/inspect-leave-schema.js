/**
 * Inspect the Dataverse metadata for the hr_hrleave table and compare it with
 * the payload fields the backend writes. Read-only. Run on the server:
 *   node scripts/inspect-leave-schema.js
 */
require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const axios = require('axios');
const d365 = require('../src/services/d365.service');

const REQUIRED = ['hr_approverid', 'hr_approveremail', 'hr_approvername', 'hr_ccrecipients'];

(async () => {
  const token = await d365.getAccessToken();
  const base = `${process.env.D365_BASE_URL}/api/data/v${process.env.D365_API_VERSION}`;
  // EntityDefinitions uses the SINGULAR logical name (hr_hrleave), not the set (hr_hrleaves).
  const url = `${base}/EntityDefinitions(LogicalName='hr_hrleave')/Attributes` +
              `?$select=LogicalName,SchemaName,AttributeType`;

  const res = await axios.get(url, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } });
  const cols = res.data.value.map(a => ({ logical: a.LogicalName, schema: a.SchemaName, type: a.AttributeType }));

  console.log(`\nTable hr_hrleave has ${cols.length} columns.\n`);

  console.log('=== Required-by-backend fields ===');
  for (const f of REQUIRED) {
    const hit = cols.find(c => c.logical === f);
    console.log(`  ${f.padEnd(20)}: ${hit ? `PRESENT (${hit.type})` : 'MISSING'}`);
  }

  console.log('\n=== Possibly-equivalent columns (approver / cc / email / name) ===');
  const near = cols.filter(c => /approv|_cc|recip|email|name/i.test(c.logical) && !REQUIRED.includes(c.logical));
  if (near.length === 0) console.log('  (none)');
  near.forEach(c => console.log(`  ${c.logical}  → schema:${c.schema}  type:${c.type}`));

  console.log('\n=== All custom (hr_) columns ===');
  cols.filter(c => c.logical.startsWith('hr_'))
      .sort((a, b) => a.logical.localeCompare(b.logical))
      .forEach(c => console.log(`  ${c.logical}  (${c.type})`));
})().catch(e => console.error('\nMetadata query failed:', e.response?.data?.error?.message || e.message));
