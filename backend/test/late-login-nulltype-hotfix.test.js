/**
 * HOTFIX regression: Late Login list/count request-type filter is NULL-TOLERANT for late_login.
 *
 * Production hr_latelogins holds 19 legacy rows with hr_requesttype = null. The deployed page sends
 * requestType=late_login; with the old strict `hr_requesttype eq 'late_login'` filter those rows
 * were excluded (Total 0 / "No late login records"). The fix includes null-typed rows for
 * late_login while keeping early_logout strict. d365 stubbed; no network.
 */
process.env.NODE_ENV = 'test';
process.env.AZURE_CLIENT_ID = process.env.AZURE_CLIENT_ID || 'x';
process.env.AZURE_CLIENT_SECRET = process.env.AZURE_CLIENT_SECRET || 'x';
process.env.AZURE_TENANT_ID = process.env.AZURE_TENANT_ID || 'x';

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const d365 = require('../src/services/d365.service');
const lateLogin = require('../src/services/late-login.service');

let orig;
beforeEach(() => { orig = { glo: d365.getListOptional, gl: d365.getList }; });
afterEach(() => { d365.getListOptional = orig.glo; d365.getList = orig.gl; });

test('list(late_login) includes null-typed legacy rows (the 19-record bug)', async () => {
  let captured;
  d365.getListOptional = async (_e, opts) => { captured = opts.filter || ''; return { data: [
    { hr_lateloginid: 'A', hr_requesttype: 'late_login', hr_status: 'submitted' },
    { hr_lateloginid: 'B', hr_requesttype: '', hr_status: 'completed' },   // legacy null-typed
  ] }; };
  const rows = await lateLogin.list({ requestType: 'late_login' });
  assert.match(captured, /\(hr_requesttype eq 'late_login' or hr_requesttype eq null\)/, 'null-tolerant clause applied');
  assert.strictEqual(rows.length, 2, 'typed + legacy null-typed late-login rows both surface');
});

test('list(early_logout) stays STRICT (null rows never leak in)', async () => {
  let captured;
  d365.getListOptional = async (_e, opts) => { captured = opts.filter || ''; return { data: [] }; };
  await lateLogin.list({ requestType: 'early_logout' });
  assert.match(captured, /hr_requesttype eq 'early_logout'/);
  assert.ok(!/or hr_requesttype eq null/.test(captured), 'early_logout excludes null-typed rows');
});

test('list() with no requestType applies no type clause', async () => {
  let captured;
  d365.getListOptional = async (_e, opts) => { captured = opts.filter == null ? '' : opts.filter; return { data: [] }; };
  await lateLogin.list({ month: '2026-04' });
  assert.ok(!/hr_requesttype/.test(captured), 'no request-type filter when none requested');
});

test('monthlyCount(late_login) uses the same null-tolerant clause', async () => {
  let captured;
  d365.getList = async (_e, opts) => { captured = opts.filter || ''; return { data: [{ hr_status: 'submitted' }, { hr_status: 'completed' }] }; };
  const n = await lateLogin.monthlyCount('E1', '2026-04', 'late_login');
  assert.match(captured, /\(hr_requesttype eq 'late_login' or hr_requesttype eq null\)/);
  assert.strictEqual(n, 2);
});
