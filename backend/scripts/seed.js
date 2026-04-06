/**
 * Seed Script — creates initial data in D365
 * Run ONCE after entity setup:  node scripts/seed.js
 */
require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const bcrypt = require('bcryptjs');

async function seed() {
  const d365 = require('../src/services/d365.service');
  console.log('\n🌱 Seeding HR System...\n');

  // ── 1. Departments ──────────────────────────────────────────
  const departments = [
    'Engineering', 'Human Resources', 'Finance', 'Sales',
    'Marketing', 'Operations', 'Legal', 'Administration',
  ];
  console.log('Creating departments...');
  const deptIds = {};
  for (const name of departments) {
    try {
      const dept = await d365.create('hr_hrdepartments', { hr_hrdepartment1: name });
      deptIds[name] = dept.hr_hrdepartmentid;
      console.log(`  ✅ ${name}`);
    } catch (err) {
      console.log(`  ⚠️  ${name} — ${err.message}`);
    }
  }

  // ── 2. Designations ─────────────────────────────────────────
  const designations = [
    'Software Engineer', 'Senior Software Engineer', 'Tech Lead',
    'HR Manager', 'HR Executive', 'Finance Manager', 'Accountant',
    'Sales Executive', 'Business Development Manager', 'CEO', 'CTO',
  ];
  console.log('\nCreating designations...');
  for (const name of designations) {
    try {
      await d365.create('hr_hrdesignations', { hr_hrdesignation1: name });
      console.log(`  ✅ ${name}`);
    } catch (err) {
      console.log(`  ⚠️  ${name} — ${err.message}`);
    }
  }

  // ── 3. Super Admin User ─────────────────────────────────────
  console.log('\nCreating super admin...');
  try {
    const hashedPwd = await bcrypt.hash('Admin@1234', 12);
    const admin = await d365.create('hr_hremployees', {
      hr_hremployee1:    'System Administrator',
      hr_email:       'admin@yourcompany.com',
      hr_password:    hashedPwd,
      hr_role:        123140003,
      hr_status:      123140000,
      hr_department:  'Administration',
      hr_designation: 'CEO',
      hr_joiningdate: new Date().toISOString(),
      hr_salary:      100000,
    });
    console.log(`  ✅ Admin created`);
    console.log(`     Email:    admin@yourcompany.com`);
    console.log(`     Password: Admin@1234`);
    console.log(`     ⚠️  CHANGE THIS PASSWORD IMMEDIATELY AFTER FIRST LOGIN`);
  } catch (err) {
    console.log(`  ❌ Admin creation failed: ${err.message}`);
  }

  // ── 4. Sample HR Manager ────────────────────────────────────
  console.log('\nCreating sample HR Manager...');
  try {
    const hashedPwd = await bcrypt.hash('HRManager@1234', 12);
    await d365.create('hr_hremployees', {
      hr_hremployee1:    'Priya Sharma',
      hr_email:       'priya.sharma@yourcompany.com',
      hr_password:    hashedPwd,
      hr_role:        123140001,
      hr_status:      123140000,
      hr_department:  'Human Resources',
      hr_designation: 'HR Manager',
      hr_joiningdate: new Date().toISOString(),
      hr_salary:      75000,
    });
    console.log(`  ✅ HR Manager created — priya.sharma@yourcompany.com / HRManager@1234`);
  } catch (err) {
    console.log(`  ⚠️  ${err.message}`);
  }

  console.log('\n✅ Seeding complete!\n');
  console.log('Next steps:');
  console.log('  1. Login at http://localhost:3000 with admin@yourcompany.com / Admin@1234');
  console.log('  2. Change the admin password immediately');
  console.log('  3. Add your employees via the Employees module\n');
}

seed().catch(console.error);
