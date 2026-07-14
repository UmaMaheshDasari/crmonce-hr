/**
 * Email (Microsoft Graph) + Super-Admin-lookup diagnostic.
 * Run ON THE SERVER where backend/.env lives:
 *   node scripts/test-email.js                        # DRY-RUN (default): sends NOTHING
 *   node scripts/test-email.js you@domain.com         # DRY-RUN to an explicit address
 *   node scripts/test-email.js you@domain.com --send  # actually send a real email
 *
 * SAFE BY DEFAULT: without --send it runs in dry-run and no email is delivered,
 * so repeatedly running it never spams a mailbox. Prints: Azure/Graph env
 * presence (names only), token acquisition, the D365 Super Admin lookup, and the
 * would-be send. Does NOT print secret values.
 */
require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const { ConfidentialClientApplication } = require('@azure/msal-node');

// Dry-run unless the operator explicitly opts in with --send. Setting this before
// requiring notification.service makes sendEmail() short-circuit (no Graph call).
const FORCE_SEND = process.argv.includes('--send');
if (!FORCE_SEND) process.env.EMAIL_DRY_RUN = 'true';

(async () => {
  // ── env presence (names only; no secret values) ──
  console.log('\n=== Graph email env presence ===');
  for (const k of ['AZURE_TENANT_ID', 'AZURE_CLIENT_ID', 'AZURE_CLIENT_SECRET', 'GRAPH_SENDER']) {
    const v = process.env[k];
    const shown = !v ? 'MISSING'
      : k === 'AZURE_CLIENT_SECRET' ? `set (${v.length} chars)`
      : v;
    console.log(`  ${k.padEnd(20)}: ${shown}`);
  }
  const sender = process.env.GRAPH_SENDER || 'info@crmonce.com';

  // ── Graph app-only token (client credentials) ──
  console.log('\n=== Graph token (OAuth2 client credentials) ===');
  try {
    const msal = new ConfidentialClientApplication({
      auth: {
        clientId: process.env.AZURE_CLIENT_ID,
        clientSecret: process.env.AZURE_CLIENT_SECRET,
        authority: `https://login.microsoftonline.com/${process.env.AZURE_TENANT_ID}`,
      },
    });
    const r = await msal.acquireTokenByClientCredential({ scopes: ['https://graph.microsoft.com/.default'] });
    console.log(`  OK  token acquired (expires ${r.expiresOn?.toISOString?.() || 'n/a'})`);
  } catch (e) {
    console.log(`  FAIL  ${e.message}`);
  }

  // ── Super Admin lookup from D365 (never hardcoded) ──
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

  // ── test send via the app's sendEmail() (Graph) — DRY-RUN unless --send ──
  const to = process.argv.slice(2).find(a => !a.startsWith('--')) || recipients[0];
  console.log(`\n=== Test send (${FORCE_SEND ? 'LIVE — will deliver' : 'DRY-RUN — nothing sent'}) ===`);
  if (!to) {
    console.log('  No recipient. Pass one:  node scripts/test-email.js you@domain.com');
    process.exit(1);
  }
  try {
    const { sendEmail } = require('../src/services/notification.service');
    const result = await sendEmail(
      to,
      'HRMS Graph email test',
      '<p>HRMS Microsoft Graph diagnostic — if you received this, Graph email works.</p>'
    );
    if (result.dryRun) {
      console.log(`  DRY-RUN  would send to ${to} (sender ${sender}). Re-run with --send to deliver.`);
    } else {
      console.log(result.success ? `  OK  sent to ${to} (sender ${sender})` : `  FAIL  ${result.error}`);
    }
  } catch (e) {
    console.log(`  FAIL  ${e.message}`);
  }
  process.exit(0);
})();
