/**
 * Email preference service — defaults (all enabled), upsert uniqueness (no duplicate rows),
 * reset-to-defaults, and FAIL-OPEN reads. In-memory d365 stub; no network.
 */
process.env.NODE_ENV = 'test';
process.env.AZURE_CLIENT_ID = process.env.AZURE_CLIENT_ID || 'x';
process.env.AZURE_CLIENT_SECRET = process.env.AZURE_CLIENT_SECRET || 'x';
process.env.AZURE_TENANT_ID = process.env.AZURE_TENANT_ID || 'x';

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const d365 = require('../src/services/d365.service');
const svc = require('../src/services/email-preferences.service');

const PREF = d365.constructor.entities.emailPreference;

let orig, rows, creates, updates;
beforeEach(() => {
  orig = { glo: d365.getListOptional, cr: d365.create, up: d365.update };
  rows = []; creates = 0; updates = 0;
  svc._clearCache();
  // In-memory table: filter supports hr_employeeid [and hr_category].
  d365.getListOptional = async (entity, { filter } = {}) => {
    if (entity !== PREF) return { data: [] };
    const emp = (String(filter).match(/hr_employeeid eq '([^']+)'/) || [])[1];
    const cat = (String(filter).match(/hr_category eq '([^']+)'/) || [])[1];
    let out = rows.filter(r => r.hr_employeeid === emp);
    if (cat) out = out.filter(r => r.hr_category === cat);
    return { data: out };
  };
  d365.create = async (entity, payload) => { creates++; const id = `P${rows.length + 1}`; rows.push({ hr_emailpreferenceid: id, ...payload }); return { hr_emailpreferenceid: id }; };
  d365.update = async (entity, id, patch) => { updates++; const r = rows.find(x => x.hr_emailpreferenceid === id); if (r) Object.assign(r, patch); return {}; };
});
afterEach(() => { Object.assign(d365, { getListOptional: orig.glo, create: orig.cr, update: orig.up }); svc._clearCache(); });

const actor = { id: 'HR1', name: 'HR One', role: 'hr_manager' };

// A: new employee → all enabled
test('A: new employee → all categories enabled by default', async () => {
  const p = await svc.getPreferences('EMP-NEW');
  assert.ok(Object.values(p).every(v => v === true), 'all enabled by default');
  assert.strictEqual(await svc.isCategoryEnabled('EMP-NEW', 'birthday'), true);
});

// disable persists + reflected on read
test('disable a category → persisted and reflected', async () => {
  await svc.setPreference('E1', 'birthday', false, actor, 'Emp');
  assert.strictEqual(await svc.isCategoryEnabled('E1', 'birthday'), false);
  assert.strictEqual(await svc.isCategoryEnabled('E1', 'payroll'), true, 'other categories stay enabled');
});

// P: no duplicate rows on repeated updates
test('P: repeated updates to the same category never create a duplicate row', async () => {
  await svc.setPreference('E1', 'birthday', false, actor, 'Emp');   // create
  await svc.setPreference('E1', 'birthday', true, actor, 'Emp');    // update
  await svc.setPreference('E1', 'birthday', false, actor, 'Emp');   // update
  const birthdayRows = rows.filter(r => r.hr_employeeid === 'E1' && r.hr_category === 'birthday');
  assert.strictEqual(birthdayRows.length, 1, 'exactly one row for (employee, category)');
  assert.strictEqual(creates, 1, 'created once');
  assert.ok(updates >= 2, 'subsequent changes update in place');
  assert.strictEqual(birthdayRows[0].hr_enabled, 'false');
});

// records who/when
test('records changedBy / role / timestamp on the row', async () => {
  await svc.setPreference('E1', 'leave', false, actor, 'Emp');
  const r = rows.find(x => x.hr_category === 'leave');
  assert.strictEqual(r.hr_changedby, 'HR One');
  assert.strictEqual(r.hr_changedbyrole, 'hr_manager');
  assert.ok(r.hr_changedon, 'timestamp recorded');
});

// Q: reset → all enabled
test('Q: resetToDefaults → every category enabled', async () => {
  await svc.setPreferences('E1', { birthday: false, leave: false, payroll: false }, actor, 'Emp');
  const after = await svc.resetToDefaults('E1', actor, 'Emp');
  assert.ok(Object.values(after).every(v => v === true), 'all enabled after reset');
});

// Concurrent create of the SAME (employee, category): the duplicate-key conflict is caught and
// the loser re-reads + updates → still exactly one row (atomic uniqueness).
test('concurrent create conflict → caught, re-find + update, no duplicate row', async () => {
  let createdOnce = false;
  // First create "wins" and inserts the row; a second concurrent create raises a duplicate-key
  // conflict; the service must re-find that row and update it instead of inserting a second.
  d365.create = async (entity, payload) => {
    if (!createdOnce) { createdOnce = true; creates++; rows.push({ hr_emailpreferenceid: 'P1', ...payload }); return { hr_emailpreferenceid: 'P1' }; }
    const e = new Error('A record that has the same key values already exists.');
    e.response = { status: 412, data: { error: { code: '0x80060892', message: 'duplicate key' } } };
    throw e;
  };
  // Two racing writers both see "no existing row" at first, then both attempt create.
  svc._clearCache();
  const findRowOrig = d365.getListOptional;
  let firstFindDone = false;
  d365.getListOptional = async (entity, opts) => {
    const f = String(opts?.filter || '');
    if (/hr_category eq/.test(f) && !firstFindDone) { firstFindDone = true; return { data: [] }; }   // both initial lookups see none
    return findRowOrig(entity, opts);   // the conflict re-find sees the inserted row
  };
  await Promise.all([
    svc.setPreference('RACE', 'birthday', false, actor, 'Emp'),
    svc.setPreference('RACE', 'birthday', true, actor, 'Emp'),
  ]);
  const birthdayRows = rows.filter(r => r.hr_employeeid === 'RACE' && r.hr_category === 'birthday');
  assert.strictEqual(birthdayRows.length, 1, 'exactly one row despite the race');
  assert.strictEqual(creates, 1, 'only one insert succeeded; the conflict became an update');
});

// O: lookup failure → fail-open (enabled)
test('O: preference lookup failure → fail-open (treated as enabled)', async () => {
  svc._clearCache();
  d365.getListOptional = async () => { throw new Error('dataverse 503'); };
  assert.strictEqual(await svc.isCategoryEnabled('E1', 'birthday'), true, 'fail-open on read error');
  const prefs = await svc.getPreferences('E1');
  assert.ok(Object.values(prefs).every(v => v === true), 'getPreferences fail-open all enabled');
});

// Schema error (table/columns not provisioned, 0x80060888) → read fails OPEN (all enabled)
test('schema error on read (missing hr_employeeid column) → fail-open, never a crash', async () => {
  svc._clearCache();
  d365.getListOptional = async () => {
    const e = new Error("Could not find a property named 'hr_employeeid' on type 'Microsoft.Dynamics.CRM.hr_emailpreference'.");
    e.response = { status: 400, data: { error: { code: '0x80060888', message: e.message } } };
    throw e;
  };
  assert.strictEqual(await svc.isCategoryEnabled('E1', 'birthday'), true, 'fail-open on schema error');
  const prefs = await svc.getPreferences('E1');
  assert.ok(Object.values(prefs).every(v => v === true), 'all enabled when storage not provisioned');
});

// Schema error on WRITE → clear retryable 503 (not a raw 400, never silent)
test('schema error on write → retryable 503, not a raw 400', async () => {
  svc._clearCache();
  d365.getListOptional = async () => {   // findRow hits the missing column
    const e = new Error("Could not find a property named 'hr_employeeid'.");
    e.response = { status: 400, data: { error: { code: '0x80060888', message: e.message } } };
    throw e;
  };
  await assert.rejects(
    () => svc.setPreference('E1', 'birthday', false, actor, 'Emp'),
    (e) => e.status === 503,
  );
});

// unknown category → always enabled (never suppressed)
test('unknown/empty category or employee → enabled (never suppressed)', async () => {
  assert.strictEqual(await svc.isCategoryEnabled('E1', 'nonexistent'), true);
  assert.strictEqual(await svc.isCategoryEnabled('', 'birthday'), true);
});
