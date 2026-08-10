/**
 * Request-lifecycle DELETE — regression guard for "adapter.delete is not a function".
 *
 * remove() must delete via the EXISTING Dataverse method d365.delete(entity, id)
 * (adapters carry `entity`, never a `delete()` method), and must enforce ownership
 * + the pending/rejected-only rule. Uses a fake adapter + stubbed d365 (no network).
 */
process.env.NODE_ENV = 'test';
process.env.AZURE_CLIENT_ID = process.env.AZURE_CLIENT_ID || 'test-client';
process.env.AZURE_CLIENT_SECRET = process.env.AZURE_CLIENT_SECRET || 'test-secret';
process.env.AZURE_TENANT_ID = process.env.AZURE_TENANT_ID || 'test-tenant';

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const d365 = require('../src/services/d365.service');
const lifecycle = require('../src/services/request-lifecycle.service');

const TYPE = 'test_delete_lifecycle';
let currentRaw = null;

// A minimal adapter mirroring the real ones (entity + get/status/owner + recipients),
// deliberately WITHOUT a delete() method — proving remove() must not rely on one.
lifecycle.registerAdapter({
  type: TYPE, label: 'Test Request', entity: 'hr_testrequests',
  get: async () => currentRaw,
  status: (r) => r.__status,
  ownerId: (r) => r.__owner,
  ownerName: () => 'Test Owner',
  summary: () => 'test summary',
  managerRecipients: async () => ({ emails: [], ids: [] }),
  hrRecipients: async () => ({ emails: [], ids: [] }),
});

let deleteCalls, saved;
beforeEach(() => {
  deleteCalls = [];
  saved = { delete: d365.delete, create: d365.create, getList: d365.getList };
  d365.delete = async (entity, id) => { deleteCalls.push({ entity, id }); return { ok: true }; };
  d365.create = async () => ({});               // audit write → no-op
  d365.getList = async () => ({ data: [] });    // activeCancellation lookup → none
});
afterEach(() => { Object.assign(d365, saved); });

test('DELETE calls the EXISTING d365.delete(entity, id) — the fix for adapter.delete', async () => {
  currentRaw = { __status: 'pending', __owner: 'EMP1' };
  const res = await lifecycle.remove({ type: TYPE, id: 'REQ1', user: { id: 'EMP1', role: 'employee' } });
  assert.deepStrictEqual(res, { deleted: true });
  assert.strictEqual(deleteCalls.length, 1, 'd365.delete called exactly once');
  assert.deepStrictEqual(deleteCalls[0], { entity: 'hr_testrequests', id: 'REQ1' });
});

test('a REJECTED request can also be deleted (pending|rejected rule)', async () => {
  currentRaw = { __status: 'rejected', __owner: 'EMP1' };
  await lifecycle.remove({ type: TYPE, id: 'REQ2', user: { id: 'EMP1', role: 'employee' } });
  assert.deepStrictEqual(deleteCalls[0], { entity: 'hr_testrequests', id: 'REQ2' });
});

test("an employee CANNOT delete another employee's request → 403, nothing deleted", async () => {
  currentRaw = { __status: 'pending', __owner: 'EMP1' };
  await assert.rejects(
    () => lifecycle.remove({ type: TYPE, id: 'REQ3', user: { id: 'EMP2', role: 'employee' } }),
    (e) => e.status === 403 && /Access denied/.test(e.message),
  );
  assert.strictEqual(deleteCalls.length, 0);
});

test('an APPROVED request cannot be deleted → 400 (cancel instead), nothing deleted', async () => {
  currentRaw = { __status: 'approved', __owner: 'EMP1' };
  await assert.rejects(
    () => lifecycle.remove({ type: TYPE, id: 'REQ4', user: { id: 'EMP1', role: 'employee' } }),
    (e) => e.status === 400 && /cannot be deleted/i.test(e.message),
  );
  assert.strictEqual(deleteCalls.length, 0);
});

test('a MANAGER_APPROVED request cannot be deleted → 400, nothing deleted', async () => {
  currentRaw = { __status: 'manager_approved', __owner: 'EMP1' };
  await assert.rejects(
    () => lifecycle.remove({ type: TYPE, id: 'REQ5', user: { id: 'EMP1', role: 'employee' } }),
    (e) => e.status === 400,
  );
  assert.strictEqual(deleteCalls.length, 0);
});

test('HR may delete another employee\'s pending request (owner check bypassed for HR)', async () => {
  currentRaw = { __status: 'pending', __owner: 'EMP1' };
  await lifecycle.remove({ type: TYPE, id: 'REQ6', user: { id: 'HRUSER', role: 'hr_manager' } });
  assert.deepStrictEqual(deleteCalls[0], { entity: 'hr_testrequests', id: 'REQ6' });
});
