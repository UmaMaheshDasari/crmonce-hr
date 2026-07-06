/**
 * Email + Super-Admin-lookup diagnostic.
 * Run ON THE SERVER where backend/.env lives:
 *   node scripts/test-email.js                 # sends to the first Super Admin found
 *   node scripts/test-email.js you@domain.com  # sends to an explicit address
 *
 * Prints: SMTP env presence (names only), SMTP verify (connection+auth) with the
 * exact error, the D365 Super Admin lookup result, and a real test send.
 * Does NOT print secret values.
 */
require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const nodemailer = require('nodemailer');

(async () => {
  // ── Step 4/10: which SMTP_* are set (by NAME; no secret values) ──
  console.log('\n=== SMTP env presence ===');
  for (const k of ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM', 'FRONTEND_URL']) {
    const v = process.env[k];
    const shown = !v ? 'MISSING'
      : k === 'SMTP_PASS' ? `set (${v.length} chars)`
      : k === 'SMTP_USER' ? v.replace(/(.).*(@.*)/, '$1***$2')
      : v;
    console.log(`  ${k.padEnd(13)}: ${shown}`);
  }

  const port = parseInt(process.env.SMTP_PORT || '587');
  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port,
    secure: port === 465,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });

  // ── Step 5: SMTP connection + auth ──
  console.log('\n=== SMTP verify (connection + authentication) ===');
  try {
    await transporter.verify();
    console.log('  OK  SMTP connection + auth succeeded');
  } catch (e) {
    console.log(`  FAIL  ${e.message}`);
    if (e.code) console.log(`        code=${e.code}${e.responseCode ? ' responseCode=' + e.responseCode : ''}`);
  }

  // ── Step 6: Super Admin lookup from D365 (never hardcoded) ──
  console.log('\n=== D365 Super Admin lookup ===');
  let recipients = [];
  try {
    const d365 = require('../src/services/d365.service');
    const { toValue } = require('../src/services/picklist');
    const { data } = await d365.getList(d365.constructor.entities.employee, {
      filter: `hr_role eq ${toValue('hr_role', 'super_admin')} and hr_status eq ${toValue('hr_employee_status', 'active')}`,
      select: 'hr_hremployeeid,hr_hremployee1,hr_email',
    });
    console.log(`  active super_admins: ${data?.length || 0}`);
    (data || []).forEach(a => console.log(`   - ${a.hr_hremployee1} <${a.hr_email || 'NO EMAIL'}>`));
    recipients = (data || []).map(a => a.hr_email).filter(Boolean);
  } catch (e) {
    console.log(`  FAIL  D365 lookup: ${e.message}`);
  }

  // ── Step 5/7: real test send ──
  const to = process.argv[2] || recipients[0];
  console.log('\n=== Test send ===');
  if (!to) {
    console.log('  No recipient. Pass one:  node scripts/test-email.js you@domain.com');
    process.exit(1);
  }
  try {
    const info = await transporter.sendMail({
      from: process.env.SMTP_FROM,
      to,
      subject: 'HRMS SMTP test',
      html: '<p>HRMS SMTP diagnostic — if you received this, outbound email works.</p>',
    });
    console.log(`  OK  sent to ${to}`);
    console.log(`      messageId=${info.messageId}`);
    console.log(`      accepted=${JSON.stringify(info.accepted)} rejected=${JSON.stringify(info.rejected)}`);
    if (info.response) console.log(`      response=${info.response}`);
  } catch (e) {
    console.log(`  FAIL  ${e.message}`);
    if (e.code) console.log(`        code=${e.code}${e.responseCode ? ' responseCode=' + e.responseCode : ''}`);
  }
  process.exit(0);
})();
