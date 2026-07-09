/**
 * Set/reset an employee's login password (bcrypt) in D365.
 *   node scripts/set-password.js <email|etimecode> <newPassword>
 * Examples:
 *   node scripts/set-password.js 44 "NewPass@123"
 *   node scripts/set-password.js teja99835@gmail.com "NewPass@123"
 */
require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const bcrypt = require('bcryptjs');
const d365 = require('../src/services/d365.service');

(async () => {
  const [identifier, newPassword] = process.argv.slice(2);
  if (!identifier || !newPassword) {
    console.log('Usage: node scripts/set-password.js <email|etimecode> <newPassword>');
    process.exit(1);
  }

  const esc = (s) => String(s).replace(/'/g, "''");
  const filter = identifier.includes('@')
    ? `hr_email eq '${esc(identifier)}'`
    : `hr_etimecode eq '${esc(identifier)}'`;

  const { data } = await d365.getList('hr_hremployees', {
    filter,
    select: 'hr_hremployeeid,hr_hremployee1,hr_email,hr_etimecode',
  });

  if (!data || data.length === 0) {
    console.log(`No employee found for "${identifier}". Try the email instead.`);
    process.exit(1);
  }
  if (data.length > 1) {
    console.log(`Multiple employees match "${identifier}" — use the email to be specific:`);
    data.forEach(e => console.log(`  - ${e.hr_hremployee1} <${e.hr_email}> (eTime ${e.hr_etimecode})`));
    process.exit(1);
  }

  const emp = data[0];
  const hash = await bcrypt.hash(newPassword, 12);
  await d365.update('hr_hremployees', emp.hr_hremployeeid, { hr_password: hash });
  console.log(`✅ Password updated for ${emp.hr_hremployee1} <${emp.hr_email}> (eTime ${emp.hr_etimecode})`);
})().catch(e => { console.log('Failed:', e.response?.data?.error?.message || e.message); process.exit(1); });
