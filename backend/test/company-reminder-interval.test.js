/**
 * Company Settings — Automated Reminder Interval (hr_reminderintervaldays).
 * Covers LOAD (known setting + default), SAVE (persists the new value), and
 * PRESERVE (an interval change keeps unrelated settings; and vice-versa) through the
 * REAL company PATCH handler with d365/company stubbed. No network, no production data.
 */
process.env.NODE_ENV = 'test';
process.env.AZURE_CLIENT_ID = process.env.AZURE_CLIENT_ID || 'x';
process.env.AZURE_CLIENT_SECRET = process.env.AZURE_CLIENT_SECRET || 'x';
process.env.AZURE_TENANT_ID = process.env.AZURE_TENANT_ID || 'x';

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const company = require('../src/services/company.service');
const companyConfig = require('../src/services/company-config.service');
const d365 = require('../src/services/d365.service');
const router = require('../src/modules/company/company.routes');

const patchHandler = () => {
  const l = router.stack.find(x => x.route && x.route.path === '/' && x.route.methods.patch);
  return l.route.stack[l.route.stack.length - 1].handle;   // the async handler (after the auth middleware)
};
const invoke = async (handler, req) => {
  let body, code = 200; const res = { status(c) { code = c; return this; }, json(b) { body = b; return this; } };
  await handler(req, res, (e) => { if (e) throw e; });
  return { code, body };
};

let orig;
beforeEach(() => {
  orig = { gc: company.getCompany, grb: company.getRawSettingsBlob, inv: company.invalidate, cfg: companyConfig.invalidateAll, up: d365.update, cr: d365.create };
  company.getCompany = async () => ({ hr_companysettingid: 'C1', hr_name: 'ACME', hr_requireddocs: 'Aadhaar Card', hr_reminderintervaldays: '3', hr_timezone: 'Asia/Kolkata' });
  company.getRawSettingsBlob = async () => ({ id: 'C1', blob: { hr_name: 'ACME', hr_requireddocs: 'Aadhaar Card', hr_reminderintervaldays: '3', hr_timezone: 'Asia/Kolkata', rolePermissions: { x: 1 } } });
  company.invalidate = () => {};
  companyConfig.invalidateAll = () => {};
});
afterEach(() => {
  Object.assign(company, { getCompany: orig.gc, getRawSettingsBlob: orig.grb, invalidate: orig.inv });
  companyConfig.invalidateAll = orig.cfg;
  Object.assign(d365, { update: orig.up, create: orig.cr });
});

// ── LOAD ──────────────────────────────────────────────────────────────────────
test('load: the interval is a known company setting with default "3"', () => {
  assert.ok(company.FIELDS.includes('hr_reminderintervaldays'));
  assert.strictEqual(company.COMPANY_DEFAULTS.hr_reminderintervaldays, '3');
});

// ── SAVE + PRESERVE ─────────────────────────────────────────────────────────────
test('save: updating the interval persists the new value AND preserves unrelated settings', async () => {
  let saved;
  d365.update = async (_entity, _id, body) => { saved = body; return {}; };
  const { code } = await invoke(patchHandler(), { body: { hr_reminderintervaldays: 7 }, user: { role: 'super_admin', name: 'Admin' } });
  assert.strictEqual(code, 200);
  const blob = JSON.parse(saved.hr_settingsjson);
  assert.strictEqual(blob.hr_reminderintervaldays, '7');     // new value persisted (String-coerced by the route)
  assert.strictEqual(saved.hr_reminderintervaldays, '7');    // scalar column set too
  assert.strictEqual(blob.hr_requireddocs, 'Aadhaar Card');  // unrelated company field preserved
  assert.strictEqual(blob.hr_timezone, 'Asia/Kolkata');      // unrelated company field preserved
  assert.deepStrictEqual(blob.rolePermissions, { x: 1 });    // non-company blob key preserved (e.g. RBAC overrides)
});

test('save: changing an unrelated setting leaves the interval at its current value', async () => {
  let saved;
  d365.update = async (_entity, _id, body) => { saved = body; return {}; };
  await invoke(patchHandler(), { body: { hr_requireddocs: 'PAN Card' }, user: { role: 'super_admin' } });
  const blob = JSON.parse(saved.hr_settingsjson);
  assert.strictEqual(blob.hr_reminderintervaldays, '3');     // untouched (carried from current)
  assert.strictEqual(blob.hr_requireddocs, 'PAN Card');      // the actual change applied
});
