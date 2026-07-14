/**
 * Diagnostic: why does the Leave "TO" (Approver) dropdown show who it shows?
 * Read-only — lists every employee with role/status/email and flags who qualifies
 * as an approver (active + role hr_manager/super_admin + a real email).
 * Run ON THE SERVER (needs backend/.env):  node scripts/list-approvers.js
 */
require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });

(async () => {
  const d365 = require('../src/services/d365.service');
  const { toValue, toLabel } = require('../src/services/picklist');
  const activeVal = toValue('hr_employee_status', 'active');

  const { data } = await d365.getList(d365.constructor.entities.employee, {
    select: 'hr_hremployeeid,hr_hremployee1,hr_email,hr_role,hr_status',
    orderby: 'hr_hremployee1 asc', top: 1000,
  });

  console.log(`\n=== Employees (${data?.length || 0}) — ✅ = appears in the TO dropdown ===`);
  let approvers = 0;
  for (const e of (data || [])) {
    const role = toLabel('hr_role', e.hr_role);
    const status = toLabel('hr_employee_status', e.hr_status);
    const qualifies = ['hr_manager', 'super_admin'].includes(role) && e.hr_status === activeVal && !!e.hr_email;
    if (qualifies) approvers++;
    console.log(
      `  ${qualifies ? '✅' : '  '}  ${String(e.hr_hremployee1 || '?').padEnd(24)}` +
      ` role=${String(role || 'none').padEnd(12)} status=${String(status || '?').padEnd(10)} <${e.hr_email || 'NO EMAIL'}>`
    );
  }
  console.log(`\n${approvers} employee(s) qualify as approvers.`);
  console.log('To add HR / Super Admin to TO: set their Employee role to hr_manager / super_admin,');
  console.log('status = active, and a valid @crmonce.com email.\n');
  process.exit(0);
})().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
