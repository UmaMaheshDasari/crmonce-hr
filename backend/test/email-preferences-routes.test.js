/**
 * Email preferences API authorization (backend-enforced):
 *   • super_admin / hr_manager → any employee (L, M)
 *   • manager (employee with the target as a direct report) → that reportee (J); others → 403 (K)
 *   • any user → self; another employee → 403 (N)
 * Drives the REAL express router with a mock req/res. d365 + the prefs service are stubbed.
 */
process.env.NODE_ENV = 'test';
process.env.AZURE_CLIENT_ID = process.env.AZURE_CLIENT_ID || 'x';
process.env.AZURE_CLIENT_SECRET = process.env.AZURE_CLIENT_SECRET || 'x';
process.env.AZURE_TENANT_ID = process.env.AZURE_TENANT_ID || 'x';

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const d365 = require('../src/services/d365.service');
const prefs = require('../src/services/email-preferences.service');
const router = require('../src/modules/settings/email-preferences.routes');

const EMP = d365.constructor.entities.employee;

// Target employees: E1 reports to manager M1; E9 reports to someone else.
const EMPLOYEES = {
  E1: { hr_hremployeeid: 'E1', hr_hremployee1: 'Reportee One', hr_email: 'e1@crmonce.com', _hr_manager_value: 'M1' },
  E9: { hr_hremployeeid: 'E9', hr_hremployee1: 'Other', hr_email: 'e9@crmonce.com', _hr_manager_value: 'MX' },
  M1: { hr_hremployeeid: 'M1', hr_hremployee1: 'Manager One', hr_email: 'm1@crmonce.com', _hr_manager_value: 'HRBOSS' },
};

function callRoute(method, url, user, body) {
  return new Promise((resolve) => {
    const req = { method, url, originalUrl: url, headers: {}, user, params: {}, body: body || {}, query: {} };
    const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(obj) { resolve({ status: this.statusCode, body: obj }); return this; } };
    router(req, res, (err) => resolve({ status: err?.status || 500, body: { error: err?.message } }));
  });
}

let orig;
beforeEach(() => {
  orig = { gio: d365.getByIdOptional, gp: prefs.getPreferences, sp: prefs.setPreferences, rd: prefs.resetToDefaults };
  d365.getByIdOptional = async (entity, id) => (entity === EMP ? (EMPLOYEES[id] || null) : null);
  prefs.getPreferences = async () => ({ birthday: true, leave: true });
  prefs.setPreferences = async () => ({ birthday: false, leave: true });
  prefs.resetToDefaults = async () => ({ birthday: true, leave: true });
});
afterEach(() => { d365.getByIdOptional = orig.gio; prefs.getPreferences = orig.gp; prefs.setPreferences = orig.sp; prefs.resetToDefaults = orig.rd; });

const HR = { id: 'HR1', name: 'HR', role: 'hr_manager' };
const SA = { id: 'SA1', name: 'Admin', role: 'super_admin' };
const MANAGER = { id: 'M1', name: 'Mgr', role: 'employee' };
const EMPLOYEE = { id: 'E1', name: 'Emp', role: 'employee' };
const OTHEREMP = { id: 'E2', name: 'Other', role: 'employee' };

// L / M: HR + Super Admin manage anyone
test('L: hr_manager updates any employee → allowed', async () => {
  const r = await callRoute('PUT', '/E9', HR, { preferences: { birthday: false } });
  assert.strictEqual(r.status, 200);
});
test('M: super_admin updates any employee → allowed', async () => {
  const r = await callRoute('PUT', '/E9', SA, { preferences: { birthday: false } });
  assert.strictEqual(r.status, 200);
});

// J: manager manages a direct reportee
test('J: manager updates their direct reportee → allowed', async () => {
  const r = await callRoute('PUT', '/E1', MANAGER, { preferences: { birthday: false } });   // E1._hr_manager_value === M1
  assert.strictEqual(r.status, 200);
});

// K: manager cannot manage a non-reportee
test('K: manager updates a non-reportee → 403', async () => {
  const r = await callRoute('PUT', '/E9', MANAGER, { preferences: { birthday: false } });   // E9 reports to MX, not M1
  assert.strictEqual(r.status, 403);
});

// N: employee cannot manage another employee; may manage self
test('N: employee updates another employee → 403', async () => {
  const r = await callRoute('PUT', '/E1', OTHEREMP, { preferences: { birthday: false } });
  assert.strictEqual(r.status, 403);
});
test('employee updates their OWN preferences → allowed', async () => {
  const r = await callRoute('PUT', '/E1', EMPLOYEE, { preferences: { birthday: false } });   // E1 == self
  assert.strictEqual(r.status, 200);
});

// GET is guarded the same way
test('GET: employee viewing another employee → 403; viewing self → allowed', async () => {
  assert.strictEqual((await callRoute('GET', '/E1', OTHEREMP)).status, 403);
  assert.strictEqual((await callRoute('GET', '/E1', EMPLOYEE)).status, 200);
  assert.strictEqual((await callRoute('GET', '/E9', HR)).status, 200);
});

// Manager relationship validated on ALL three verbs (GET / PUT / RESET).
test('manager GET/RESET their direct reportee → allowed; non-reportee → 403', async () => {
  assert.strictEqual((await callRoute('GET', '/E1', MANAGER)).status, 200, 'GET reportee allowed');
  assert.strictEqual((await callRoute('POST', '/E1/reset', MANAGER)).status, 200, 'RESET reportee allowed');
  assert.strictEqual((await callRoute('GET', '/E9', MANAGER)).status, 403, 'GET non-reportee denied');
  assert.strictEqual((await callRoute('POST', '/E9/reset', MANAGER)).status, 403, 'RESET non-reportee denied');
});

// Role comes from the verified JWT (req.user.role), never from the path/body → no ID substitution
// or role escalation: an employee cannot elevate by targeting another id.
test('employee cannot escalate by targeting another employee id (GET/PUT/RESET all 403)', async () => {
  assert.strictEqual((await callRoute('GET', '/E9', OTHEREMP)).status, 403);
  assert.strictEqual((await callRoute('PUT', '/E9', OTHEREMP, { preferences: { birthday: false } })).status, 403);
  assert.strictEqual((await callRoute('POST', '/E9/reset', OTHEREMP)).status, 403);
});

// categories endpoint open to any authenticated user
test('GET /categories → list for any authenticated user', async () => {
  const r = await callRoute('GET', '/categories', EMPLOYEE);
  assert.strictEqual(r.status, 200);
  assert.ok(Array.isArray(r.body.data) && r.body.data.length > 0);
});
