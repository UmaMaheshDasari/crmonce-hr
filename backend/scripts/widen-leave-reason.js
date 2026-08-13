/**
 * Widen the Leave "Reason" column (Dataverse hr_hrleave.hr_reason) to 4000 chars.
 *
 * Run this ONCE on the server if leave creation fails with:
 *   0x80044331 "The length of the 'hr_reason' attribute ... exceeded the maximum
 *   allowed length of '100'."
 *
 * Usage:  node scripts/widen-leave-reason.js
 *
 * It prints exactly what it did (or why it could not), including the common case
 * where the Dataverse APPLICATION USER lacks customization privilege — which no code
 * can grant itself. In that case an admin must either give the app user the
 * "System Customizer" security role, or open the maker portal and set the hr_reason
 * column's Maximum length to 4000 (Single line of text supports up to 4000).
 */
require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });

(async () => {
  console.log('\n🔧 Widening Leave Reason column (hr_reason) to 4000 characters...\n');
  try {
    const { ensureReasonLength } = require('../src/services/provision-leave-columns');
    const { LEAVE_REASON_MAX } = require('../src/services/leave-reason.util');
    const result = await ensureReasonLength(console, LEAVE_REASON_MAX);

    console.log('Result:', JSON.stringify(result, null, 2), '\n');
    switch (result.status) {
      case 'updated':
        console.log(`✅ Done. hr_reason MaxLength ${result.from} → ${result.to}. Long reasons will now save.`);
        break;
      case 'ok':
        console.log(result.already
          ? `✅ Already OK. hr_reason MaxLength is ${result.maxLength} (>= ${LEAVE_REASON_MAX}).`
          : `✅ Nothing to do — ${result.note}.`);
        break;
      case 'failed':
        console.log(`❌ Could not widen the column.`);
        if (result.privilege) {
          console.log('   Cause: the Dataverse application user lacks customization privilege.');
          console.log('   Fix:   grant it the "System Customizer" (or "System Administrator") security role,');
          console.log('          OR in the maker portal set hr_reason → Maximum length = 4000, then re-run this.');
        } else {
          console.log(`   Dataverse said: ${result.reason}`);
        }
        process.exitCode = 1;
        break;
      default:
        console.log(`⚠️  Skipped: ${result.reason || 'metadata unavailable'}.`);
        process.exitCode = 1;
    }
  } catch (e) {
    console.error('❌ Script error:', e.message);
    process.exitCode = 1;
  }
  console.log('');
})();
