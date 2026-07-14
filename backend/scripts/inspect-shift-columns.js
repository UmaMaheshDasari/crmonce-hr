/**
 * Diagnostic: print the ACTUAL Dataverse logical names + types of the shift
 * columns on the HR Employee table (hr_hremployee). Read-only.
 * Run ON THE SERVER (needs backend/.env):  node scripts/inspect-shift-columns.js
 */
require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const axios = require('axios');

(async () => {
  const d365 = require('../src/services/d365.service');
  const headers = await d365.getHeaders();
  const url = `${d365.baseUrl}/EntityDefinitions(LogicalName='hr_hremployee')/Attributes` +
    `?$select=LogicalName,SchemaName,AttributeType,MaxLength`;

  const { data } = await axios.get(url, { headers });
  const shift = (data.value || []).filter(a =>
    /shift/i.test(a.LogicalName) || /shift/i.test(a.SchemaName || ''));

  console.log('\n=== Shift columns on hr_hremployee ===');
  if (!shift.length) {
    console.log('  (none found — columns not created, or a different entity/prefix)');
  } else {
    for (const a of shift) {
      console.log(`  LogicalName=${String(a.LogicalName).padEnd(22)} Schema=${String(a.SchemaName).padEnd(20)} Type=${a.AttributeType}${a.MaxLength ? ` MaxLength=${a.MaxLength}` : ''}`);
    }
  }
  console.log('\nThe backend expects: hr_shiftname, hr_shiftstarttime, hr_shiftendtime (Type=String).');
  console.log('If the LogicalNames differ, set SHIFT_NAME_FIELD / SHIFT_START_FIELD / SHIFT_END_FIELD,');
  console.log('or if the Type is not String, recreate them as Single Line of Text.\n');
  process.exit(0);
})().catch(e => {
  console.error('FAIL:', e.message);
  if (e.response?.data) console.error(JSON.stringify(e.response.data, null, 2));
  process.exit(1);
});
