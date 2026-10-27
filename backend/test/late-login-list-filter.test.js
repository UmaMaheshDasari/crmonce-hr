/**
 * Late Login list/count request-type filter is NULL-TOLERANT for late_login.
 *
 * Legacy hr_latelogins rows created before hr_requesttype was populated have a NULL type. They are
 * late-login records, so a late_login query must INCLUDE null-typed rows (otherwise they vanish
 * from the list and counts — the production "Total 0 / No late login records" bug). Early Logout
 * stays strict so null-typed legacy rows never leak into it. d365 stubbed; no network.
 */
process.env.NODE_ENV = 'test';
process.env.AZURE_CLIENT_ID = process.env.AZURE_CLIENT_ID || 'x';
process.env.AZURE_CLIENT_SECRET = process.env.AZURE_CLIENT_SECRET || 'x';
process.env.AZURE_TENANT_ID = process.env.AZURE_TENANT_ID || 'x';

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const d365 = require('../src/services/d365.service');
const lateLogin = require('../src/services/late-login.service');

const LATE = d365.constructor.entities.lateLogin;

let orig;
beforeEach(() => { orig = { glo: d365.getListOptional, gl: d365.getList }; });
afterEach(() => { d365.getListOptional = orig.glo; d365.getList = orig.gl; });

test('list(requestType:late_login) → filter includes null-typed legacy rows', async () => {
  let captured;
  d365.getListOptional = async (_e, opts) => { captured = opts.filter || ''; return { data: [
    { hr_lateloginid: 'A', hr_requesttype: 'late_login', hr_status: 'submitted' },
    { hr_lateloginid: 'B', hr_requesttype: '', hr_status: 'completed' },   // legacy null-typed
  ] }; };
  const rows = await lateLogin.list({ requestType: 'late_login' });
  assert.match(captured, /\(hr_requesttype eq 'late_login' or hr_requesttype eq null\)/, 'null-tolerant clause applied');
  assert.strictEqual(rows.length, 2, 'both typed and legacy null-typed late-login rows surface');
});

test('list(requestType:early_logout) → STRICT filter (nulls excluded, no leakage)', async () => {
  let captured;
  d365.getListOptional = async (_e, opts) => { captured = opts.filter || ''; return { data: [] }; };
  await lateLogin.list({ requestType: 'early_logout' });
  assert.match(captured, /hr_requesttype eq 'early_logout'/);
  assert.ok(!/or hr_requesttype eq null/.test(captured), 'early_logout never includes null-typed rows');
});

test('list() with no requestType → no type clause at all', async () => {
  let captured;
  d365.getListOptional = async (_e, opts) => { captured = opts.filter == null ? '' : opts.filter; return { data: [] }; };
  await lateLogin.list({ month: '2026-04' });
  assert.ok(!/hr_requesttype/.test(captured), 'no request-type filter when none requested');
});

test('qualifyingCount(late_login) → counts include null-typed legacy rows (same null-tolerant clause)', async () => {
  let captured;
  d365.getList = async (_e, opts) => { captured = opts.filter || ''; return { data: [
    { hr_lateloginid: 'A', hr_status: 'auto_approved' },
    { hr_lateloginid: 'B', hr_status: 'submitted' },   // legacy null-typed, matched by the clause
  ] }; };
  const n = await lateLogin.qualifyingCount('E1', '2026-04', 'late_login');
  assert.match(captured, /\(hr_requesttype eq 'late_login' or hr_requesttype eq null\)/);
  assert.strictEqual(n, 2, 'both rows counted as qualifying late-login events');
});
