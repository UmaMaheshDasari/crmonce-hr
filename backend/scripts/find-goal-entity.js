/**
 * Diagnostic: find the REAL Goal table in Dataverse and print its authoritative
 * EntitySetName (the OData collection segment the backend must POST/GET against).
 * Read-only. Run ON THE SERVER (needs backend/.env):
 *   node scripts/find-goal-entity.js
 *
 * Why: the backend guessed the set name 'hr_hrgoals', but Dataverse returned
 * 404 0x80060888 "Resource not found for the segment 'hr_hrgoals'". That means
 * the guess is wrong — or the table doesn't exist. This tells us which.
 */
require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const axios = require('axios');

(async () => {
  const d365 = require('../src/services/d365.service');
  const headers = await d365.getHeaders();

  // Pull every custom table's naming so we can eyeball anything goal-related.
  const url = `${d365.baseUrl}/EntityDefinitions` +
    `?$select=LogicalName,SchemaName,EntitySetName,LogicalCollectionName,DisplayName`;
  const { data } = await axios.get(url, { headers });
  const all = data.value || [];

  const goalish = all.filter((e) => {
    const dn = e.DisplayName?.UserLocalizedLabel?.Label || '';
    return /goal/i.test(e.LogicalName) || /goal/i.test(e.SchemaName || '') ||
      /goal/i.test(e.EntitySetName || '') || /goal/i.test(dn);
  });

  console.log('\n=== Goal-related tables in Dataverse ===');
  if (!goalish.length) {
    console.log('  (NONE) — there is no Goal table in this environment.');
    console.log('  → The "Assign Goal" feature has no table to write to. It must be');
    console.log('    created in Dataverse (or the feature pointed at an existing table).');
  } else {
    for (const e of goalish) {
      const dn = e.DisplayName?.UserLocalizedLabel?.Label || '';
      console.log(`  Display="${dn}"`);
      console.log(`    LogicalName        = ${e.LogicalName}`);
      console.log(`    SchemaName         = ${e.SchemaName}`);
      console.log(`    EntitySetName      = ${e.EntitySetName}   ← use THIS as the collection`);
      console.log(`    LogicalCollection  = ${e.LogicalCollectionName}\n`);
    }
    console.log("Backend currently uses: 'hr_hrgoals' (d365.service entities.goal).");
    console.log('If EntitySetName above differs, set entities.goal to that value.');
  }
  process.exit(0);
})().catch((e) => {
  console.error('FAIL:', e.message);
  if (e.response?.data) console.error(JSON.stringify(e.response.data, null, 2));
  process.exit(1);
});
