/**
 * One-off migration: give existing employees a default shift.
 *   Shift Name  = General Shift
 *   Shift Start = 09:00
 * Only employees MISSING one of these are touched.
 *
 * Safe by default (dry-run — writes nothing). Run ON THE SERVER (needs .env):
 *   node scripts/migrate-shifts.js            # preview
 *   node scripts/migrate-shifts.js --apply    # actually update
 */
require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const DRY = !process.argv.includes('--apply');

(async () => {
  const d365 = require('../src/services/d365.service');
  const EMP = d365.constructor.entities.employee;

  const { data } = await d365.getList(EMP, {
    select: 'hr_hremployeeid,hr_hremployee1,hr_shiftname,hr_shiftstarttime,hr_shiftendtime', top: 5000,
  });
  const need = (data || []).filter(e => !e.hr_shiftname || !e.hr_shiftstarttime || !e.hr_shiftendtime);
  console.log(`\n${data?.length || 0} employees; ${need.length} missing shift.\n`);

  let ok = 0, failed = 0;
  for (const e of need) {
    const patch = {};
    if (!e.hr_shiftname) patch.hr_shiftname = 'General Shift';
    if (!e.hr_shiftstarttime) patch.hr_shiftstarttime = '09:00';
    if (!e.hr_shiftendtime) patch.hr_shiftendtime = '18:00';
    if (DRY) { console.log(`  [dry-run] ${e.hr_hremployee1}: ${JSON.stringify(patch)}`); continue; }
    try {
      await d365.update(EMP, e.hr_hremployeeid, patch);
      console.log(`  updated ${e.hr_hremployee1}`);
      ok++;
    } catch (err) {
      failed++;
      // Print the EXACT Dataverse response body — not just "400".
      console.error(`  FAILED  ${e.hr_hremployee1} — patch ${JSON.stringify(patch)}`);
      console.error(`          ${JSON.stringify(err.response?.data || err.message, null, 2)}`);
    }
  }

  console.log(DRY
    ? '\nDRY-RUN — nothing written. Re-run with --apply to update.\n'
    : `\nDone. ${ok} updated, ${failed} failed.\n`);
  process.exit(failed ? 1 : 0);
})().catch(e => {
  // Full Dataverse error body (e.g. the getList $select failure), not just the status.
  console.error('FAIL:', e.message);
  if (e.response?.data) console.error(JSON.stringify(e.response.data, null, 2));
  process.exit(1);
});
