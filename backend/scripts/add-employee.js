/**
 * Add an employee to D365 from the CLI.
 *   node scripts/add-employee.js "<name>" <email> [etimeCode] [role] [password]
 * Examples:
 *   node scripts/add-employee.js "Tejasri" teja99835@gmail.com 43
 *   node scripts/add-employee.js "Tejasri" teja99835@gmail.com 43 employee "Welcome@123"
 *
 * role defaults to "employee". A password is only needed for email/password
 * login (not required for Azure AD SSO).
 */
require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const bcrypt = require('bcryptjs');
const d365 = require('../src/services/d365.service');
const { toValue } = require('../src/services/picklist');

(async () => {
  const [name, email, etimeCode, role = 'employee', password] = process.argv.slice(2);
  if (!name || !email) {
    console.log('Usage: node scripts/add-employee.js "<name>" <email> [etimeCode] [role] [password]');
    process.exit(1);
  }

  // Prevent duplicate by email
  const { data: existing } = await d365.getList('hr_hremployees', {
    filter: `hr_email eq '${email.replace(/'/g, "''")}'`,
    select: 'hr_hremployeeid',
  });
  if (existing && existing.length) {
    console.log(`⚠️  An employee with ${email} already exists (${existing[0].hr_hremployeeid}). Aborting.`);
    process.exit(1);
  }

  const data = {
    hr_hremployee1: name,
    hr_email: email,
    hr_role: toValue('hr_role', role),
    hr_status: toValue('hr_employee_status', 'active'),
    hr_joiningdate: new Date().toISOString(),
  };
  if (etimeCode) data.hr_etimecode = String(etimeCode);
  if (password) data.hr_password = await bcrypt.hash(password, 12);

  try {
    const emp = await d365.create('hr_hremployees', data);
    console.log(`✅ Created: ${emp.hr_hremployeeid} — ${name} <${email}>` +
                (etimeCode ? ` · eTime ${etimeCode}` : '') + ` · role ${role}`);
  } catch (e) {
    console.log('❌ Failed:', e.response?.data?.error?.message || e.message);
    process.exit(1);
  }
})();
