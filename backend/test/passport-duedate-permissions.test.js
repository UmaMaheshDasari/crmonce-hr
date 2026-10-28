/**
 * Passport Submission Due Date — admin-only enforcement on the REAL employee PATCH
 * handler (d365 + profile side-effects stubbed). Proves:
 *   - a self (non-HR) edit CANNOT set hr_passportduedate (stripped by SELF_EDITABLE),
 *     while unrelated self-editable fields still save;
 *   - an HR edit CAN set it (normalised to YYYY-MM-DD);
 *   - an invalid due date is rejected (400) and nothing is written.
 * No network, no production data.
 */
process.env.NODE_ENV = 'test';
process.env.AZURE_CLIENT_ID = process.env.AZURE_CLIENT_ID || 'x';
process.env.AZURE_CLIENT_SECRET = process.env.AZURE_CLIENT_SECRET || 'x';
process.env.AZURE_TENANT_ID = process.env.AZURE_TENANT_ID || 'x';

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const d365 = require('../src/services/d365.service');
const profile = require('../src/services/profile.service');
const router = require('../src/modules/employees/employee.routes');

const EMP_ID = '11111111-1111-1111-1111-111111111111';

// The PATCH /:id handler (the async handler is the last entry in the route's stack).
const patchHandler = () => {
  const l = router.stack.find(x => x.route && x.route.path === '/:id' && x.route.methods.patch);
  return l.route.stack[l.route.stack.length - 1].handle;
};
const invoke = async (handler, req) => {
  let body, code = 200; const res = { status(c) { code = c; return this; }, json(b) { body = b; return this; } };
  await handler(req, res, (e) => { if (e) throw e; });
  return { code, body };
};

let orig, captured;
beforeEach(() => {
  captured = undefined;
  orig = { gbir: d365.getByIdResilient, up: d365.update, nu: profile.notifyUser, wa: profile.writeAudit, nhv: profile.notifyHRVerification };
  d365.getByIdResilient = async () => ({ hr_hremployee1: 'Test Employee', hr_passport: '', hr_passportduedate: '' });
  d365.update = async (_entity, _id, data) => { captured = data; return { hr_hremployeeid: _id }; };
  profile.notifyUser = () => {};
  profile.writeAudit = async () => {};
  profile.notifyHRVerification = async () => {};
});
afterEach(() => {
  Object.assign(d365, { getByIdResilient: orig.gbir, update: orig.up });
  Object.assign(profile, { notifyUser: orig.nu, writeAudit: orig.wa, notifyHRVerification: orig.nhv });
});

test('self (employee) edit cannot set the passport due date, but other fields still save', async () => {
  const { code } = await invoke(patchHandler(), {
    params: { id: EMP_ID },
    user: { id: EMP_ID, role: 'employee', name: 'Test Employee' },   // self edit
    body: { hr_passportduedate: '2026-12-01', hr_phone: '9999999999' },
  });
  assert.strictEqual(code, 200);
  assert.ok(captured, 'an update was written');
  assert.strictEqual(captured.hr_passportduedate, undefined, 'due date was stripped for a self edit');
  assert.strictEqual(captured.hr_phone, '9999999999', 'unrelated self-editable field still saved');
});

test('HR edit can set the passport due date (normalised to YYYY-MM-DD)', async () => {
  const { code } = await invoke(patchHandler(), {
    params: { id: EMP_ID },
    user: { id: 'hr-admin-id', role: 'hr_manager', name: 'HR Admin' },
    body: { hr_passportduedate: '2026-12-01T00:00:00Z' },
  });
  assert.strictEqual(code, 200);
  assert.strictEqual(captured.hr_passportduedate, '2026-12-01', 'HR value stored, normalised to date-only');
});

test('HR edit with an invalid due date is rejected and nothing is written', async () => {
  const { code, body } = await invoke(patchHandler(), {
    params: { id: EMP_ID },
    user: { id: 'hr-admin-id', role: 'super_admin', name: 'Admin' },
    body: { hr_passportduedate: 'not-a-date' },
  });
  assert.strictEqual(code, 400);
  assert.match(body.error, /valid date/i);
  assert.strictEqual(captured, undefined, 'no write happened on a validation failure');
});
