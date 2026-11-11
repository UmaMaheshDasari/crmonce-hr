/**
 * Module ON/OFF enforcement (Company Settings → hr_payrollenabled /
 * hr_salarystructureenabled). The switch hides the module in the UI AND its APIs
 * must refuse to serve (403), so a bookmarked URL or direct API call can never
 * bypass it. Missing/blank flags default ON (backward compatible); a settings
 * read failure must NEVER take a module offline (fail-open).
 *
 * Pure middleware tests — no network (company.getCompany stubbed).
 */
process.env.NODE_ENV = 'test';
process.env.AZURE_CLIENT_ID = process.env.AZURE_CLIENT_ID || 'test-client';
process.env.AZURE_CLIENT_SECRET = process.env.AZURE_CLIENT_SECRET || 'test-secret';
process.env.AZURE_TENANT_ID = process.env.AZURE_TENANT_ID || 'test-tenant';

const { test } = require('node:test');
const assert = require('node:assert');
const company = require('../src/services/company.service');
const { isOn, requirePayrollEnabled, requireSalaryStructureEnabled } = require('../src/middleware/module-flags.middleware');

// Run the middleware against a stubbed company row → { nexted, status, body }.
async function invoke(mw, row) {
  company.getCompany = async () => row;
  let nexted = false, status = 0, body = null;
  const res = { status(c) { status = c; return { json(j) { body = j; return this; } }; } };
  await mw({ user: { role: 'employee', id: 'self-guid' } }, res, () => { nexted = true; });
  return { nexted, status, body };
}

// ── isOn: the flag value semantics ──
test('isOn: missing/blank/true-variants default ON (backward compatible)', () => {
  assert.strictEqual(isOn(undefined), true);
  assert.strictEqual(isOn(null), true);
  assert.strictEqual(isOn(''), true);
  assert.strictEqual(isOn(true), true);
  assert.strictEqual(isOn('true'), true);
  assert.strictEqual(isOn('TRUE'), true);
  assert.strictEqual(isOn('1'), true);
  assert.strictEqual(isOn('yes'), true);
  assert.strictEqual(isOn('on'), true);
});

test('isOn: "false"/"0"/"no"/"off" turn the module OFF', () => {
  assert.strictEqual(isOn('false'), false);
  assert.strictEqual(isOn('FALSE'), false);
  assert.strictEqual(isOn('0'), false);
  assert.strictEqual(isOn('no'), false);
  assert.strictEqual(isOn('off'), false);
});

// ── Payroll switch → API boundary ──
test('hr_payrollenabled "false" → payroll APIs refused with 403', async () => {
  const r = await invoke(requirePayrollEnabled, { hr_payrollenabled: 'false' });
  assert.strictEqual(r.nexted, false);
  assert.strictEqual(r.status, 403);
  assert.match(r.body.error, /Payroll module is disabled by the administrator/i);
});

test('hr_payrollenabled "true"/missing/blank → payroll APIs pass through', async () => {
  assert.strictEqual((await invoke(requirePayrollEnabled, { hr_payrollenabled: 'true' })).nexted, true);
  assert.strictEqual((await invoke(requirePayrollEnabled, {})).nexted, true);
  assert.strictEqual((await invoke(requirePayrollEnabled, { hr_payrollenabled: '' })).nexted, true);
});

// ── Salary Structure switch → API boundary ──
test('hr_salarystructureenabled "false" → salary structure APIs refused with 403', async () => {
  const r = await invoke(requireSalaryStructureEnabled, { hr_salarystructureenabled: 'false' });
  assert.strictEqual(r.nexted, false);
  assert.strictEqual(r.status, 403);
  assert.match(r.body.error, /Salary Structure module is disabled by the administrator/i);
});

test('hr_salarystructureenabled "true"/missing → salary structure APIs pass through', async () => {
  assert.strictEqual((await invoke(requireSalaryStructureEnabled, { hr_salarystructureenabled: 'true' })).nexted, true);
  assert.strictEqual((await invoke(requireSalaryStructureEnabled, {})).nexted, true);
});

// ── Fail-open: a settings read failure must NEVER take a module offline ──
test('company read failure → fail-open (module stays reachable)', async () => {
  company.getCompany = async () => { throw new Error('Dataverse unreachable'); };
  let nexted = false, status = 0;
  const res = { status(c) { status = c; return { json() { return this; } }; } };
  await requirePayrollEnabled({ user: { role: 'hr_manager' } }, res, () => { nexted = true; });
  assert.strictEqual(nexted, true, 'middleware must call next() when the settings row cannot be read');
  assert.strictEqual(status, 0);
});
