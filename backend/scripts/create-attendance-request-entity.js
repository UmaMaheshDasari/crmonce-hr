/**
 * Provision the "Attendance Request" (Missing Punch) table via the Dataverse
 * metadata API. Idempotent — skips the entity/columns that already exist.
 *
 * The backend ALSO tries to create this table automatically on startup (see
 * services/provision-attendance-request.js). Run this only when the automatic
 * attempt was skipped (e.g. the app registration lacks customization rights and
 * you granted them, or you prefer to provision explicitly).
 *
 *   Entity : hr_AttendanceRequest  (set: hr_attendancerequests)
 *   Primary: hr_Name  Text
 *   Columns (Text/Memo): hr_EmployeeId/Name/Email, hr_AttendanceDate, hr_PunchType,
 *     hr_RequestedTime, hr_Reason, hr_Remarks, hr_AttachmentUrl, hr_Status,
 *     hr_OriginalPunches, hr_CorrectedPunches, hr_ApprovedBy, hr_ApprovedDate,
 *     hr_ApproverComment, hr_AttendanceRecordId
 *
 * Requires System Customizer / Administrator on the app registration. Run ON THE
 * SERVER (needs backend/.env):
 *   node scripts/create-attendance-request-entity.js            # preview (dry-run)
 *   node scripts/create-attendance-request-entity.js --apply    # create
 */
require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const DRY = !process.argv.includes('--apply');

(async () => {
  if (DRY) {
    console.log('\nDRY-RUN — would create table hr_attendancerequests (entity hr_AttendanceRequest)\n' +
      'and its Text/Memo columns. Re-run with --apply to create.\n');
    return;
  }
  const { ensureAttendanceRequestTable } = require('../src/services/provision-attendance-request');
  const result = await ensureAttendanceRequestTable(console);
  console.log(`\nResult: ${result.status}${result.reason ? ` — ${result.reason}` : ''}\n`);
  if (result.status === 'unavailable') process.exit(1);
})().catch(e => { console.error(e.message); process.exit(1); });
