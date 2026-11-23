/**
 * §2C — HR Manager / Super Admin ROUTINE PERSONAL reminders are OFF by default, with a personal
 * exception (explicit enable). Normal employees are unaffected (all ON). Role is resolved from the
 * employee record (trusted server-side), never client input. Operational emails are uncategorized /
 * not keyed to the admin's employeeId, so they are never evaluated here (covered in email-suppression).
 * In-memory d365 stub; no network, no real email.
 */
process.env.NODE_ENV = 'test';
process.env.AZURE_CLIENT_ID = process.env.AZURE_CLIENT_ID || 'x';
process.env.AZURE_CLIENT_SECRET = process.env.AZURE_CLIENT_SECRET || 'x';
process.env.AZURE_TENANT_ID = process.env.AZURE_TENANT_ID || 'x';

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const d365 = require('../src/services/d365.service');
const { toValue } = require('../src/services/picklist');
const svc = require('../src/services/email-preferences.service');

const EMP = d365.constructor.entities.employee;
const PREF = d365.constructor.entities.emailPreference;
const ROLE = { HR: toValue('hr_role', 'hr_manager'), SA: toValue('hr_role', 'super_admin'), EMP: toValue('hr_role', 'employee') };

let orig, rows, roleByEmp, creates;
beforeEach(() => {
  orig = { gio: d365.getByIdOptional, glo: d365.getListOptional, cr: d365.create, up: d365.update };
  rows = []; creates = 0;
  roleByEmp = { HRID: ROLE.HR, SAID: ROLE.SA, EMPID: ROLE.EMP };
  svc._clearCache();
  d365.getByIdOptional = async (entity, id) => (entity === EMP ? { hr_role: roleByEmp[id] } : null);
  d365.getListOptional = async (entity, { filter } = {}) => {
    if (entity !== PREF) return { data: [] };
    const emp = (String(filter).match(/hr_employeeid eq '([^']+)'/) || [])[1];
    const cat = (String(filter).match(/hr_category eq '([^']+)'/) || [])[1];
    let out = rows.filter(r => r.hr_employeeid === emp);
    if (cat) out = out.filter(r => r.hr_category === cat);
    return { data: out };
  };
  d365.create = async (entity, payload) => { creates++; const id = `P${rows.length + 1}`; rows.push({ hr_emailpreferenceid: id, ...payload }); return { hr_emailpreferenceid: id }; };
  d365.update = async (entity, id, patch) => { const r = rows.find(x => x.hr_emailpreferenceid === id); if (r) Object.assign(r, patch); return {}; };
});
afterEach(() => { Object.assign(d365, { getByIdOptional: orig.gio, getListOptional: orig.glo, create: orig.cr, update: orig.up }); svc._clearCache(); });

const actor = { id: 'HR1', name: 'HR', role: 'hr_manager' };

// H / I: admin routine reminders default OFF
test('H/I: HR & Super Admin routine reminders (attendance) → OFF by default', async () => {
  assert.strictEqual(await svc.isCategoryEnabled('HRID', 'attendance'), false, 'HR attendance off by default');
  assert.strictEqual(await svc.isCategoryEnabled('SAID', 'attendance'), false, 'Super Admin attendance off by default');
});

// J / K: admin profile/passport reminders default OFF (category 'reminders')
test('J/K: HR & Super Admin profile/passport reminders → OFF by default', async () => {
  assert.strictEqual(await svc.isCategoryEnabled('HRID', 'reminders'), false);
  assert.strictEqual(await svc.isCategoryEnabled('SAID', 'reminders'), false);
});

// Admin NON-routine categories stay ON (payslip, leave decisions, birthday, performance, other)
test('admin non-routine categories (payroll/leave/birthday/performance/other) → ON by default', async () => {
  for (const cat of ['payroll', 'leave', 'birthday', 'anniversary', 'performance', 'other']) {
    assert.strictEqual(await svc.isCategoryEnabled('HRID', cat), true, `HR ${cat} on by default`);
  }
});

// Normal employees unaffected — everything ON (§2A)
test('normal employee → ALL categories ON by default (routine included)', async () => {
  assert.strictEqual(await svc.isCategoryEnabled('EMPID', 'attendance'), true);
  assert.strictEqual(await svc.isCategoryEnabled('EMPID', 'reminders'), true);
  const p = await svc.getPreferences('EMPID');
  assert.ok(Object.values(p).every(v => v === true));
});

// getPreferences reflects role-aware defaults for an admin
test('getPreferences(admin) → routine OFF, the rest ON', async () => {
  const p = await svc.getPreferences('HRID');
  assert.strictEqual(p.attendance, false);
  assert.strictEqual(p.reminders, false);
  assert.strictEqual(p.payroll, true);
  assert.strictEqual(p.leave, true);
});

// P / Q: personal exception — an admin can explicitly enable a routine category
test('P/Q: admin personal exception — explicit enable delivers that routine category', async () => {
  await svc.setPreference('HRID', 'attendance', true, actor, 'HR Person');   // opt-in
  assert.strictEqual(await svc.isCategoryEnabled('HRID', 'attendance'), true, 'enabled exception delivers');
  assert.strictEqual(await svc.isCategoryEnabled('HRID', 'reminders'), false, 'other routine stays off');
});

// An admin can also explicitly turn a routine category OFF (no-op vs default, but recorded)
test('admin explicit OFF on a routine category is honoured', async () => {
  await svc.setPreference('SAID', 'attendance', false, actor, 'Admin');
  assert.strictEqual(await svc.isCategoryEnabled('SAID', 'attendance'), false);
});

// Reset is role-aware: employee → all ON; admin → routine OFF
test('reset: employee → all ON; admin → routine OFF (role defaults)', async () => {
  await svc.resetToDefaults('EMPID', actor, 'Emp');
  const emp = await svc.getPreferences('EMPID');
  assert.ok(Object.values(emp).every(v => v === true), 'employee reset = all on');

  svc._clearCache();
  await svc.resetToDefaults('HRID', actor, 'HR');
  const hr = await svc.getPreferences('HRID');
  assert.strictEqual(hr.attendance, false, 'admin reset leaves routine off');
  assert.strictEqual(hr.reminders, false);
  assert.strictEqual(hr.payroll, true, 'admin reset keeps non-routine on');
});

// Role lookup failure → fail-open to 'employee' (routine defaults ON → delivered, never silently off)
test('role lookup failure → defaults to employee (routine ON, fail-open)', async () => {
  d365.getByIdOptional = async () => { throw new Error('dataverse down'); };
  svc._clearCache();
  assert.strictEqual(await svc.isCategoryEnabled('HRID', 'attendance'), true, 'fail-open: routine delivered when role unknown');
});

// ── resolveRole: recognized roles, missing, unknown, error ────────────────────
test('resolveRole maps all recognized hr_role values', async () => {
  assert.strictEqual(await svc.resolveRole('HRID'), 'hr_manager');
  assert.strictEqual(await svc.resolveRole('SAID'), 'super_admin');
  assert.strictEqual(await svc.resolveRole('EMPID'), 'employee');
});

test('resolveRole: recruiter is recognized and is NOT an admin (routine stays ON)', async () => {
  roleByEmp.RECID = toValue('hr_role', 'recruiter'); svc._clearCache();
  assert.strictEqual(await svc.resolveRole('RECID'), 'recruiter');
  assert.strictEqual(await svc.isCategoryEnabled('RECID', 'attendance'), true, 'recruiter routine ON (not admin)');
});

test('resolveRole: MISSING hr_role → employee (logged, fail-open)', async () => {
  roleByEmp.NOROLE = null; svc._clearCache();
  assert.strictEqual(await svc.resolveRole('NOROLE'), 'employee');
  assert.strictEqual(await svc.isCategoryEnabled('NOROLE', 'attendance'), true, 'unresolved → routine delivered, not suppressed');
});

test('resolveRole: UNKNOWN hr_role value → employee (logged, fail-open)', async () => {
  roleByEmp.WEIRD = 999999; svc._clearCache();
  assert.strictEqual(await svc.resolveRole('WEIRD'), 'employee');
});

test('resolveRole: lookup error → employee (logged, fail-open)', async () => {
  svc._clearCache();
  d365.getByIdOptional = async () => { throw new Error('boom'); };
  assert.strictEqual(await svc.resolveRole('ANY'), 'employee');
});
