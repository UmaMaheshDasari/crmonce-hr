/**
 * Email-preference provisioning BACKFILL — repairs the production bug where an existing table
 * ("Entities already exist: hr_EmailPreference.") aborted provisioning before the column/alt-key
 * backfill. Verifies: existing entity → proceed; missing columns created; existing columns/keys not
 * recreated; alt key created after columns with exactly (hr_employeeid, hr_category); permission
 * errors preserved; no duplicate-create on repeat. axios/d365 stubbed; no network.
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

// The 7 data columns the provisioner defines (schema names), mapped to logical names.
const COL_SCHEMAS = provision.COLUMNS.map((c) => c.SchemaName);           // hr_EmployeeId, …
const toLogical = (s) => s.toLowerCase();

const entityExistsErr = () => { const e = new Error('Entities already exist: hr_EmailPreference.'); e.response = { status: 400, data: { error: { message: 'Entities already exist: hr_EmailPreference.' } } }; return e; };
const alreadyExistsErr = (what) => { const e = new Error(`An attribute with the specified name already exists (${what}).`); e.response = { status: 400, data: { error: { message: 'already exists' } } }; return e; };
const permissionErr = () => { const e = new Error('Principal user is missing prvCreateEntity privilege.'); e.response = { status: 403, data: { error: { code: '0x80040220', message: 'Principal user is missing prvCreateEntity privilege.' } } }; return e; };

let orig, calls;
function installStub({ tableExists = true, existingCols = [], keyExists = false, entityError = entityExistsErr, failColCreate = false } = {}) {
  calls = { posts: [], createdCols: [], createdKeys: [] };
  const existing = new Set(existingCols);
  d365.getHeaders = async () => ({});
  d365.getList = async () => (tableExists ? { data: [] } : (() => { const e = new Error('Could not find'); e.response = { status: 404, data: { error: { message: 'Could not find hr_emailpreferences' } } }; throw e; })());
  axios.post = async (url, body) => {
    calls.posts.push(url);
    if (/EntityDefinitions$/.test(url)) { if (entityError) throw entityError(); return {}; }   // entity create
    if (/\/Attributes$/.test(url)) {
      const sn = body.SchemaName;
      if (existing.has(sn)) throw alreadyExistsErr(sn);        // already there → skip
      if (failColCreate) throw permissionErr();               // cannot create columns
      calls.createdCols.push(sn); existing.add(sn); return {};
    }
    if (/\/Keys$/.test(url)) {
      if (keyExists) throw alreadyExistsErr('hr_EmployeeCategoryKey');
      calls.createdKeys.push(body); return {};
    }
    return {};
  };
}

beforeEach(() => { orig = { gl: d365.getList, gh: d365.getHeaders, ap: axios.post }; });
afterEach(() => { Object.assign(d365, { getList: orig.gl, getHeaders: orig.gh }); axios.post = orig.ap; });

// ── The production scenario: existing entity, 4 columns present, 3 missing, no alt key ──
test('existing entity + 3 missing columns + no alt key → BACKFILL (not abort)', async () => {
  const present4 = COL_SCHEMAS.slice(0, 4);
  const missing3 = COL_SCHEMAS.slice(4);                       // the 3 absent columns
  installStub({ tableExists: true, existingCols: present4, keyExists: false });
  const r = await provision.ensureEmailPreferencesTable(console);
  assert.strictEqual(r.status, 'backfilled', 'existing-entity reply no longer aborts provisioning');
  assert.deepStrictEqual(calls.createdCols.sort(), missing3.sort(), 'exactly the 3 missing columns were created');
  assert.ok(!present4.some(c => calls.createdCols.includes(c)), 'existing columns were NOT recreated');
  assert.strictEqual(calls.createdKeys.length, 1, 'alternate key created');
});

// ── Alt key uses exactly hr_employeeid + hr_category, created AFTER the columns ──
test('alternate key created after columns with exactly (hr_employeeid, hr_category)', async () => {
  installStub({ tableExists: true, existingCols: COL_SCHEMAS.slice(0, 4), keyExists: false });
  await provision.ensureEmailPreferencesTable(console);
  const key = calls.createdKeys[0];
  assert.strictEqual(key.SchemaName, 'hr_EmployeeCategoryKey');
  assert.deepStrictEqual(key.KeyAttributes, ['hr_employeeid', 'hr_category']);
  const lastAttr = calls.posts.map((u, i) => (/\/Attributes$/.test(u) ? i : -1)).filter(i => i >= 0).pop();
  const keyIdx = calls.posts.findIndex(u => /\/Keys$/.test(u));
  assert.ok(keyIdx > lastAttr, 'key POST happens after all attribute POSTs');
});

// ── Idempotent repeat: all columns + active key already exist → nothing recreated ──
test('repeat provisioning (all columns + key exist) → no duplicate attributes/keys', async () => {
  installStub({ tableExists: true, existingCols: COL_SCHEMAS, keyExists: true });
  const r = await provision.ensureEmailPreferencesTable(console);
  assert.strictEqual(r.status, 'backfilled');
  assert.deepStrictEqual(calls.createdCols, [], 'no columns recreated');
  assert.deepStrictEqual(calls.createdKeys, [], 'alt key not recreated');
});

// ── Fresh create (table missing) still works ──
test('table missing → entity + all 7 columns + key created', async () => {
  installStub({ tableExists: false, existingCols: [], keyExists: false, entityError: null });
  const r = await provision.ensureEmailPreferencesTable(console);
  assert.strictEqual(r.status, 'created');
  assert.strictEqual(calls.createdCols.length, 7, 'all seven columns created on a fresh table');
  assert.strictEqual(calls.createdKeys.length, 1);
});

// ── Permission failure on entity create (non-exists, non-lock) → unavailable, message preserved ──
test('permission failure on entity create → unavailable with the real Dataverse detail preserved', async () => {
  installStub({ tableExists: true, existingCols: [], keyExists: false, entityError: permissionErr });
  const r = await provision.ensureEmailPreferencesTable(console);
  assert.strictEqual(r.status, 'unavailable');
  assert.match(r.reason, /prvCreateEntity/, 'original Dataverse error preserved in the result');
});

// ── No infinite loop: with retry disabled, one pass returns a terminal status ──
test('no provisioning loop — returns a terminal status in one pass (retry off)', async () => {
  installStub({ tableExists: true, existingCols: COL_SCHEMAS.slice(0, 4), keyExists: false });
  const r = await provision.ensureEmailPreferencesTable(console, { retry: false });
  assert.ok(['backfilled', 'created', 'unavailable', 'locked'].includes(r.status));
});
