/**
 * D365 Connection Test Script
 * Run this to verify your D365 connection and entity setup.
 * Usage: node scripts/test-d365-connection.js
 */
require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });

async function testConnection() {
  console.log('\n🔍 Testing D365 connection...\n');

  try {
    const d365 = require('../src/services/d365.service');

    // 1. Test token acquisition
    console.log('1. Acquiring Azure AD token...');
    const token = await d365.getAccessToken();
    console.log('   ✅ Token acquired successfully\n');

    // 2. Test each entity
    const entities = [
      ['hr_hrdepartments',   'Departments'],
      ['hr_hremployees',     'Employees'],
      ['hr_hrattendances',   'Attendance'],
      ['hr_hrleaves',        'Leave'],
      ['hr_hrpayrolls',      'Payroll'],
      ['hr_hrjobs',          'Jobs'],
      ['hr_hrapplications',  'Applications'],
      ['hr_hrperformances',  'Performance'],
      ['hr_hrdocuments',     'Documents'],
    ];

    console.log('2. Checking entities...');
    for (const [entity, label] of entities) {
      try {
        const result = await d365.getList(entity, { top: 1 });
        console.log(`   ✅ ${label} (${entity}) — OK, count: ${result.count ?? 'N/A'}`);
      } catch (err) {
        console.log(`   ❌ ${label} (${entity}) — FAILED: ${err.response?.data?.error?.message || err.message}`);
      }
    }

    console.log('\n3. Environment check...');
    const required = ['AZURE_TENANT_ID','AZURE_CLIENT_ID','AZURE_CLIENT_SECRET','D365_BASE_URL','JWT_SECRET'];
    required.forEach(key => {
      const val = process.env[key];
      if (!val || val.startsWith('your-')) {
        console.log(`   ❌ ${key} — NOT SET`);
      } else {
        console.log(`   ✅ ${key} — OK`);
      }
    });

    console.log('\n✅ D365 connection test complete!\n');

  } catch (err) {
    console.error('\n❌ Connection failed:', err.message);
    if (err.message?.includes('AADSTS')) {
      console.error('   → Check your AZURE_TENANT_ID, AZURE_CLIENT_ID, AZURE_CLIENT_SECRET');
    }
    if (err.message?.includes('404')) {
      console.error('   → Check your D365_BASE_URL');
    }
    process.exit(1);
  }
}

testConnection();
