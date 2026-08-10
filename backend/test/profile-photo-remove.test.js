/**
 * Profile photo REMOVE — DELETE /api/employees/:id/photo through the real router.
 *
 * Proves: an employee can remove ONLY their own personal photo; a different employee
 * is refused (403); the default photo is HR-only; and removal clears ONLY the single
 * photo column (no other employee field touched). Dataverse writes are stubbed.
 */
process.env.NODE_ENV = 'test';
process.env.AZURE_CLIENT_ID = process.env.AZURE_CLIENT_ID || 'test-client';
process.env.AZURE_CLIENT_SECRET = process.env.AZURE_CLIENT_SECRET || 'test-secret';
process.env.AZURE_TENANT_ID = process.env.AZURE_TENANT_ID || 'test-tenant';

const { test, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const express = require('express');
const d365 = require('../src/services/d365.service');
const employeeRouter = require('../src/modules/employees/employee.routes');

let server, base, currentUser, updateCalls, saved;

before(async () => {
  const app = express();
  app.use((req, res, next) => { req.user = currentUser; next(); });
  app.use('/employees', employeeRouter);
  app.use((err, req, res, next) => { res.status(err.status || 500).json({ error: err.message }); });   // eslint-disable-line no-unused-vars
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server?.close());

beforeEach(() => {
  updateCalls = [];
  saved = { update: d365.update, getByIdOptional: d365.getByIdOptional };
  d365.update = async (entity, id, payload) => { updateCalls.push({ entity, id, payload }); return { hr_hremployeeid: id, ...payload }; };
  d365.getByIdOptional = async () => ({ hr_hremployeeid: 'EMP1', hr_photourl: null, hr_personalphotourl: null });
});
afterEach(() => { Object.assign(d365, saved); });

const EMP = 'EMP1', OTHER = 'EMP2';
const employee = (id) => ({ id, role: 'employee', name: 'Emp', email: 'e@crmonce.com' });
const hr = { id: 'HR1', role: 'hr_manager', name: 'HR', email: 'hr@crmonce.com' };

async function del(targetId, kind, user) {
  currentUser = user;
  const res = await fetch(`${base}/employees/${targetId}/photo?kind=${kind}`, { method: 'DELETE' });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

test('employee removes their OWN personal photo → 200, clears ONLY hr_personalphotourl', async () => {
  const { status, body } = await del(EMP, 'personal', employee(EMP));
  assert.strictEqual(status, 200);
  assert.strictEqual(body.removed, true);
  assert.strictEqual(updateCalls.length, 1);
  assert.deepStrictEqual(updateCalls[0].payload, { hr_personalphotourl: null }, 'only the photo field is cleared');
});

test("employee CANNOT remove another employee's personal photo → 403, nothing written", async () => {
  const { status } = await del(OTHER, 'personal', employee(EMP));
  assert.strictEqual(status, 403);
  assert.strictEqual(updateCalls.length, 0);
});

test('employee CANNOT remove the DEFAULT photo (HR-only) → 403, nothing written', async () => {
  const { status } = await del(EMP, 'default', employee(EMP));
  assert.strictEqual(status, 403);
  assert.strictEqual(updateCalls.length, 0);
});

test('HR removes an employee DEFAULT photo → 200, clears ONLY hr_photourl', async () => {
  const { status } = await del(EMP, 'default', hr);
  assert.strictEqual(status, 200);
  assert.deepStrictEqual(updateCalls[0].payload, { hr_photourl: null });
});

test("even HR cannot remove an employee's PERSONAL photo (only the owner can) → 403", async () => {
  const { status } = await del(EMP, 'personal', hr);
  assert.strictEqual(status, 403);
  assert.strictEqual(updateCalls.length, 0);
});
