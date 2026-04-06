/**
 * D365 Entity Bootstrap Script
 * Run once to create all custom HR entities in your D365 environment.
 * Usage: node scripts/setup-d365-entities.js
 */
require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const d365 = require('../src/services/d365.service');

// ── Entity definitions ────────────────────────────────────────────
// Each entry: { schemaName, displayName, fields[] }
// Fields use D365 attribute types

const ENTITIES = [
  // ── Departments ──────────────────────────────────────────────
  {
    schemaName: 'hr_department',
    displayName: 'HR Department',
    fields: [
      { name: 'hr_hrdepartment1', type: 'String',  maxLength: 200, required: true  },
      { name: 'hr_code',          type: 'String',  maxLength: 20                   },
      { name: 'hr_description',   type: 'Memo',    maxLength: 2000                 },
    ],
  },
  // ── Designations ─────────────────────────────────────────────
  {
    schemaName: 'hr_designation',
    displayName: 'HR Designation',
    fields: [
      { name: 'hr_hrdesignation1', type: 'String', maxLength: 200, required: true },
      { name: 'hr_level', type: 'String', maxLength: 50                  },
    ],
  },
  // ── Employees ─────────────────────────────────────────────────
  {
    schemaName: 'hr_employee',
    displayName: 'HR Employee',
    fields: [
      { name: 'hr_hremployee1',       type: 'String',   maxLength: 200,  required: true },
      { name: 'hr_email',            type: 'String',   maxLength: 200,  required: true },
      { name: 'hr_password',         type: 'String',   maxLength: 500                  },
      { name: 'hr_phone',            type: 'String',   maxLength: 20                   },
      { name: 'hr_department',       type: 'String',   maxLength: 100                  },
      { name: 'hr_designation',      type: 'String',   maxLength: 100                  },
      { name: 'hr_role',             type: 'Picklist', options: ['employee','hr_manager','recruiter','super_admin'], defaultValue: 'employee' },
      { name: 'hr_status',           type: 'Picklist', options: ['active','inactive','on_leave'],                   defaultValue: 'active'   },
      { name: 'hr_joiningdate',      type: 'DateTime'                                  },
      { name: 'hr_salary',           type: 'Money'                                     },
      { name: 'hr_allowances',       type: 'Money'                                     },
      { name: 'hr_deductions',       type: 'Money'                                     },
      { name: 'hr_address',          type: 'Memo',     maxLength: 500                  },
      { name: 'hr_emergencycontact', type: 'String',   maxLength: 200                  },
      { name: 'hr_etimecode',        type: 'String',   maxLength: 50                   },
    ],
  },
  // ── Attendance ────────────────────────────────────────────────
  {
    schemaName: 'hr_attendance',
    displayName: 'HR Attendance',
    fields: [
      { name: 'hr_date',         type: 'DateTime', required: true },
      { name: 'hr_intime',       type: 'String',   maxLength: 10  },
      { name: 'hr_outtime',      type: 'String',   maxLength: 10  },
      { name: 'hr_workedhours',  type: 'Decimal'                  },
      { name: 'hr_overtime',     type: 'Decimal'                  },
      { name: 'hr_deviceid',     type: 'String',   maxLength: 50  },
      { name: 'hr_source',       type: 'Picklist', options: ['etime_device','manual_correction','web_checkin'], defaultValue: 'etime_device' },
      { name: 'hr_status',       type: 'Picklist', options: ['present','absent','half_day','incomplete','holiday'], defaultValue: 'present' },
      // Lookup: hr_employee
    ],
  },
  // ── Leave ─────────────────────────────────────────────────────
  {
    schemaName: 'hr_leave',
    displayName: 'HR Leave',
    fields: [
      { name: 'hr_leavetype',  type: 'Picklist', options: ['Casual Leave','Sick Leave','Earned Leave','Maternity Leave','Paternity Leave','LOP'] },
      { name: 'hr_fromdate',   type: 'DateTime', required: true  },
      { name: 'hr_todate',     type: 'DateTime', required: true  },
      { name: 'hr_days',       type: 'Integer'                   },
      { name: 'hr_reason',     type: 'Memo',     maxLength: 1000 },
      { name: 'hr_status',     type: 'Picklist', options: ['pending','approved','rejected','cancelled'], defaultValue: 'pending' },
      { name: 'hr_remarks',    type: 'Memo',     maxLength: 500  },
      // Lookup: hr_employee
    ],
  },
  // ── Payroll ───────────────────────────────────────────────────
  {
    schemaName: 'hr_payroll',
    displayName: 'HR Payroll',
    fields: [
      { name: 'hr_month',          type: 'Integer', required: true },
      { name: 'hr_year',           type: 'Integer', required: true },
      { name: 'hr_basic',          type: 'Money'                   },
      { name: 'hr_allowances',     type: 'Money'                   },
      { name: 'hr_deductions',     type: 'Money'                   },
      { name: 'hr_netpay',         type: 'Money'                   },
      { name: 'hr_status',         type: 'Picklist', options: ['draft','processed','paid'], defaultValue: 'processed' },
      { name: 'hr_processeddate',  type: 'DateTime'                },
      // Lookup: hr_employee
    ],
  },
  // ── Jobs ──────────────────────────────────────────────────────
  {
    schemaName: 'hr_job',
    displayName: 'HR Job',
    fields: [
      { name: 'hr_hrjob1',      type: 'String',   maxLength: 200, required: true },
      { name: 'hr_department',  type: 'String',   maxLength: 100                 },
      { name: 'hr_openings',    type: 'Integer'                                  },
      { name: 'hr_closingdate', type: 'DateTime'                                 },
      { name: 'hr_description', type: 'Memo',     maxLength: 5000                },
      { name: 'hr_status',      type: 'Picklist', options: ['open','closed','on_hold'], defaultValue: 'open' },
    ],
  },
  // ── Applications ─────────────────────────────────────────────
  {
    schemaName: 'hr_application',
    displayName: 'HR Application',
    fields: [
      { name: 'hr_candidatename', type: 'String',   maxLength: 200, required: true },
      { name: 'hr_email',         type: 'String',   maxLength: 200                 },
      { name: 'hr_phone',         type: 'String',   maxLength: 20                  },
      { name: 'hr_resumeurl',     type: 'String',   maxLength: 500                 },
      { name: 'hr_applieddate',   type: 'DateTime'                                 },
      { name: 'hr_stage',         type: 'Picklist', options: ['applied','screening','interview','offer','hired','rejected'], defaultValue: 'applied' },
      { name: 'hr_notes',         type: 'Memo',     maxLength: 2000                },
      { name: 'hr_stageupdatedon',type: 'DateTime'                                 },
      // Lookup: hr_job
    ],
  },
  // ── Performance ───────────────────────────────────────────────
  {
    schemaName: 'hr_performance',
    displayName: 'HR Performance',
    fields: [
      { name: 'hr_cycle',         type: 'String',   maxLength: 50  },
      { name: 'hr_rating',        type: 'Integer'                   },
      { name: 'hr_goals',         type: 'Memo',     maxLength: 3000 },
      { name: 'hr_kpis',          type: 'Memo',     maxLength: 3000 },
      { name: 'hr_reviewernotes', type: 'Memo',     maxLength: 3000 },
      { name: 'hr_status',        type: 'Picklist', options: ['draft','in-review','completed'], defaultValue: 'draft' },
      // Lookup: hr_employee (reviewee)
      // Lookup: hr_reviewer (reviewer employee)
    ],
  },
  // ── Documents ─────────────────────────────────────────────────
  {
    schemaName: 'hr_document',
    displayName: 'HR Document',
    fields: [
      { name: 'hr_name',         type: 'String', maxLength: 300, required: true },
      { name: 'hr_type',         type: 'Picklist', options: ['Offer Letter','Contract','ID Proof','Payslip','Certificate','Other'], defaultValue: 'Other' },
      { name: 'hr_fileurl',      type: 'String', maxLength: 500                 },
      { name: 'hr_filesize',     type: 'Integer'                                },
      { name: 'hr_originalname', type: 'String', maxLength: 300                 },
      // Lookup: hr_employee
    ],
  },
];

// ── Lookup relationships to create ─────────────────────────────────
const LOOKUPS = [
  { from: 'hr_attendance',  to: 'hr_employee',  fieldName: 'hr_hremployee',  displayName: 'Employee'  },
  { from: 'hr_leave',       to: 'hr_employee',  fieldName: 'hr_hremployee',  displayName: 'Employee'  },
  { from: 'hr_payroll',     to: 'hr_employee',  fieldName: 'hr_hremployee',  displayName: 'Employee'  },
  { from: 'hr_application', to: 'hr_job',       fieldName: 'hr_hrjob',       displayName: 'Job'       },
  { from: 'hr_performance', to: 'hr_employee',  fieldName: 'hr_hremployee',  displayName: 'Employee'  },
  { from: 'hr_document',    to: 'hr_employee',  fieldName: 'hr_hremployee',  displayName: 'Employee'  },
];

// ── Print the setup instructions ──────────────────────────────────
console.log('\n========================================');
console.log('  D365 HR System — Entity Setup Guide');
console.log('========================================\n');
console.log('Go to: https://make.powerapps.com');
console.log('→ Select your environment');
console.log('→ Tables → New Table (for each entity below)\n');

ENTITIES.forEach((entity, i) => {
  console.log(`\n[${i+1}] Table: ${entity.schemaName}`);
  console.log(`    Display Name: ${entity.displayName}`);
  console.log(`    Primary Column: entity primary name field (e.g. hr_hrdepartment1, hr_hremployee1, hr_hrjob1)`);
  console.log(`    Fields to add:`);
  entity.fields.forEach(f => {
    const extras = [];
    if (f.required) extras.push('Required');
    if (f.maxLength) extras.push(`Max: ${f.maxLength}`);
    if (f.options) extras.push(`Options: ${f.options.join(', ')}`);
    if (f.defaultValue) extras.push(`Default: ${f.defaultValue}`);
    console.log(`      • ${f.name} (${f.type})${extras.length ? ' — ' + extras.join(', ') : ''}`);
  });
});

console.log('\n\n[Lookups / Relationships to create]\n');
LOOKUPS.forEach(l => {
  console.log(`  ${l.from}.${l.fieldName} → ${l.to} (Many-to-one)`);
});

console.log('\n[Security Roles needed in D365]');
console.log('  Create a new role: "HR System App User"');
console.log('  Grant Read/Write/Create/Delete on all hr_* tables');
console.log('  Assign this role to the Azure AD app registration\n');

console.log('[Azure AD App Registration steps]');
console.log('  1. portal.azure.com → Azure Active Directory → App registrations');
console.log('  2. New registration → name: "HR System Backend"');
console.log('  3. Certificates & secrets → New client secret → copy to .env');
console.log('  4. API permissions → Add permission → Dynamics CRM → user_impersonation');
console.log('  5. Grant admin consent');
console.log('  6. Copy Application (client) ID and Directory (tenant) ID to .env\n');
