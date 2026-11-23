/**
 * Read-only provisioning diagnostic — inspectEmailPreferences status mapping + the
 * GET /_provision-status route (HR/Super Admin only, no mutation). d365 + axios metadata stubbed;
 * no network.
 */
process.env.NODE_ENV = 'test';
process.env.AZURE_CLIENT_ID = process.env.AZURE_CLIENT_ID || 'x';
process.env.AZURE_CLIENT_SECRET = process.env.AZURE_CLIENT_SECRET || 'x';
process.env.AZURE_TENANT_ID = process.env.AZURE_TENANT_ID || 'x';

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const axios = require('axios');
const d365 = require('../src/services/d365.service');
const provision = require('../src/services/provision-email-preferences');
const router = require('../src/modules/settings/email-preferences.routes');

const ALL_COLS = provision.REQUIRED_COLUMNS;
const missingMsg = "Could not find hr_emailpreferences — Resource not found for the segment";

let orig;
beforeEach(() => {
  orig = { gl: d365.getList, gh: d365.getHeaders, ax: axios.get, cr: d365.create, up: d365.update, del: d365.delete };
  d365.getHeaders = async () => ({});
  d365.getList = async () => ({ data: [] });            // table exists by default
  // Metadata GETs: Attributes (all cols) + Keys (active alt key) by default.
  axios.get = async (url) => {
    if (/\/Attributes/.test(url)) return { data: { value: ALL_COLS.map((c) => ({ LogicalName: c })) } };
    if (/\/Keys/.test(url)) return { data: { value: [{ SchemaName: 'hr_EmployeeCategoryKey', EntityKeyIndexStatus: 'Active', KeyAttributes: ['hr_employeeid', 'hr_category'] }] } };
    return { data: {} };
  };
  // Mutations must NEVER be called by the diagnostic — make them throw if they are.
  d365.create = async () => { throw new Error('create must not be called by diagnostic'); };
  d365.update = async () => { throw new Error('update must not be called by diagnostic'); };
  d365.delete = async () => { throw new Error('delete must not be called by diagnostic'); };
});
afterEach(() => { Object.assign(d365, { getList: orig.gl, getHeaders: orig.gh, create: orig.cr, update: orig.up, delete: orig.del }); axios.get = orig.ax; });

// ── inspectEmailPreferences status mapping ────────────────────────────────────
test('READY when table + all columns + active alt key exist', async () => {
  const r = await provision.inspectEmailPreferences();
  assert.strictEqual(r.status, 'READY');
  assert.strictEqual(r.table, true);
  assert.deepStrictEqual(r.columns.missing, []);
  assert.strictEqual(r.alternateKey.active, true);
});

test('TABLE_MISSING when the entity set is absent', async () => {
  d365.getList = async () => { const e = new Error(missingMsg); e.response = { status: 404, data: { error: { message: missingMsg } } }; throw e; };
  const r = await provision.inspectEmailPreferences();
  assert.strictEqual(r.status, 'TABLE_MISSING');
  assert.strictEqual(r.table, false);
});

test('COLUMNS_MISSING when a required column is absent (shell is NOT ready)', async () => {
  axios.get = async (url) => {
    if (/\/Attributes/.test(url)) return { data: { value: ALL_COLS.filter((c) => c !== 'hr_employeeid').map((c) => ({ LogicalName: c })) } };
    return { data: { value: [] } };
  };
  const r = await provision.inspectEmailPreferences();
  assert.strictEqual(r.status, 'COLUMNS_MISSING');
  assert.ok(r.columns.missing.includes('hr_employeeid'));
});

test('ALTERNATE_KEY_MISSING when no key exists', async () => {
  axios.get = async (url) => {
    if (/\/Attributes/.test(url)) return { data: { value: ALL_COLS.map((c) => ({ LogicalName: c })) } };
    if (/\/Keys/.test(url)) return { data: { value: [] } };
    return { data: {} };
  };
  const r = await provision.inspectEmailPreferences();
  assert.strictEqual(r.status, 'ALTERNATE_KEY_MISSING');
});

test('ALTERNATE_KEY_NOT_ACTIVE when the key is still Pending', async () => {
  axios.get = async (url) => {
    if (/\/Attributes/.test(url)) return { data: { value: ALL_COLS.map((c) => ({ LogicalName: c })) } };
    if (/\/Keys/.test(url)) return { data: { value: [{ SchemaName: 'hr_EmployeeCategoryKey', EntityKeyIndexStatus: 'Pending', KeyAttributes: ['hr_employeeid', 'hr_category'] }] } };
    return { data: {} };
  };
  const r = await provision.inspectEmailPreferences();
  assert.strictEqual(r.status, 'ALTERNATE_KEY_NOT_ACTIVE');
  assert.strictEqual(r.alternateKey.exists, true);
  assert.strictEqual(r.alternateKey.active, false);
});

test('PERMISSION_OR_METADATA_ACCESS_ERROR on a metadata 403 (sanitized, no secrets)', async () => {
  axios.get = async () => { const e = new Error('Principal lacks prvReadEntity'); e.response = { status: 403, data: { error: { code: '0x80040220', message: 'Principal lacks prvReadEntity' } } }; throw e; };
  const r = await provision.inspectEmailPreferences();
  assert.strictEqual(r.status, 'PERMISSION_OR_METADATA_ACCESS_ERROR');
  assert.strictEqual(r.error.httpStatus, 403);
  assert.ok(!JSON.stringify(r).includes('AZURE') && !JSON.stringify(r).toLowerCase().includes('token'), 'no secrets leaked');
});

test('inspect performs NO mutation (create/update/delete never called)', async () => {
  await provision.inspectEmailPreferences();   // mutation stubs throw if invoked → would fail the test
  assert.ok(true);
});

// ── Route: GET /_provision-status authorization ───────────────────────────────
function callRoute(method, url, user) {
  return new Promise((resolve) => {
    const req = { method, url, originalUrl: url, headers: {}, user, params: {}, body: {}, query: {} };
    const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(obj) { resolve({ status: this.statusCode, body: obj }); return this; } };
    router(req, res, (err) => resolve({ status: err?.status || 500, body: { error: err?.message } }));
  });
}

test('route: HR / Super Admin allowed; employee → 403; path not captured as :employeeId', async () => {
  assert.strictEqual((await callRoute('GET', '/_provision-status', { id: 'HR1', role: 'hr_manager' })).status, 200);
  assert.strictEqual((await callRoute('GET', '/_provision-status', { id: 'SA1', role: 'super_admin' })).status, 200);
  const emp = await callRoute('GET', '/_provision-status', { id: 'E1', role: 'employee' });
  assert.strictEqual(emp.status, 403, 'employee denied');
});

test('route: returns the diagnostic status payload for an authorized caller', async () => {
  const r = await callRoute('GET', '/_provision-status', { id: 'HR1', role: 'hr_manager' });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.data.status, 'READY');
  assert.ok('autoProvision' in r.body.data);
});
