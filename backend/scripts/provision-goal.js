/**
 * Provision the "HR Goal" table (hr_hrgoals) via the Dataverse metadata API.
 * Idempotent — skips the entity/columns that already exist.
 *
 * The backend ALSO creates this table automatically on startup (see
 * services/provision-goal.js), so normally you never need to run this. Use it
 * only to provision explicitly (e.g. right after granting the app registration
 * customization rights) or to preview what would be created.
 *
 *   Entity : hr_HRGoal  (set: hr_hrgoals, PK: hr_hrgoalid)
 *   Primary: hr_HRGoal1  Text  (Goal Title)
 *   Columns: Description, Quarter, FinancialYear, Priority, Status, Weightage,
 *            Progress, DueDate, KeyResults, SelfRating, ManagerRating,
 *            SelfComments, ManagerComments, EmployeeId, EmployeeName,
 *            AssignedBy, AssignedDate  (Text / Memo / Whole Number)
 *
 * Requires System Customizer / Administrator on the app registration. Run ON THE
 * SERVER (needs backend/.env):
 *   node scripts/provision-goal.js            # preview (dry-run)
 *   node scripts/provision-goal.js --apply    # create
 */
require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const DRY = !process.argv.includes('--apply');

(async () => {
  if (DRY) {
    console.log('\nDRY-RUN — would create table hr_hrgoals (entity hr_HRGoal) and its\n' +
      'Text/Memo/Whole-Number columns. Re-run with --apply to create.\n');
    return;
  }
  const { ensureGoalTable } = require('../src/services/provision-goal');
  // retry on a customization lock every 30s for up to 10 min (same as startup).
  const result = await ensureGoalTable(console, { retry: true });
  console.log(`\nResult: ${result.status}${result.reason ? ` — ${result.reason}` : ''}`);
  if (result.message) console.log(result.message);
  console.log('');
  if (result.status === 'forbidden') {
    console.error('→ Assign the "System Administrator" or "System Customizer" Dataverse role to the ' +
      'app registration (Power Platform admin → Environment → Settings → Users + permissions → ' +
      'Application users), then re-run.');
    process.exit(2);
  }
  if (result.status === 'locked' || result.status === 'unavailable') process.exit(1);
})().catch(e => { console.error(e.message); process.exit(1); });
