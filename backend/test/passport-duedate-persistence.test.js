/**
 * Passport Submission Due Date — persistence safety on the REAL employee PATCH handler.
 * Proves:
 *   - a successful save persists the due date (normal path);
 *   - when the hr_passportduedate column cannot be provisioned, the API FAILS LOUDLY
 *     (503, no false success) while still persisting the other fields in the payload
 *     (no data loss, no overwrite of unrelated fields).
 * d365 + profile side-effects are stubbed. No network, no production data.
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

const EMP_ID = '22222222-2222-2222-2222-222222222222';

const patchHandler = () => {
  const l = router.stack.find(x => x.route && x.route.path === '/:id' && x.route.methods.patch);
  return l.route.stack[l.route.stack.length - 1].handle;
};
const invoke = async (handler, req) => {
  let body, code = 200; const res = { status(c) { code = c; return this; }, json(b) { body = b; return this; } };
  await handler(req, res, (e) => { if (e) throw e; });   // rejects if the route calls next(err)
  return { code, body };
};

let orig, savedLogger;
beforeEach(() => {
  orig = {
    gbir: d365.getByIdResilient, up: d365.update, gh: d365.getHeaders,
    imp: d365._isMissingProperty, mpn: d365._missingPropertyName,
    nu: profile.notifyUser, wa: profile.writeAudit, nhv: profile.notifyHRVerification,
  };
  savedLogger = global.logger;
  global.logger = { info() {}, warn() {}, error() {} };   // silence provisioning noise
  d365.getByIdResilient = async () => ({ hr_hremployee1: 'Test Employee', hr_passport: '', hr_passportduedate: '' });
  d365.update = async (_e, _id) => ({ hr_hremployeeid: _id });
  profile.notifyUser = () => {};
  profile.writeAudit = async () => {};
  profile.notifyHRVerification = async () => {};
});
afterEach(() => {
  Object.assign(d365, {
    getByIdResilient: orig.gbir, update: orig.up, getHeaders: orig.gh,
    _isMissingProperty: orig.imp, _missingPropertyName: orig.mpn,
  });
  Object.assign(profile, { notifyUser: orig.nu, writeAudit: orig.wa, notifyHRVerification: orig.nhv });
  global.logger = savedLogger;
});

test('success — due date persists when the column is available', async () => {
  let saved;
  d365.update = async (_e, _id, body) => { saved = body; return { hr_hremployeeid: _id }; };
  const { code } = await invoke(patchHandler(), {
    params: { id: EMP_ID },
    user: { id: 'hr-admin-id', role: 'hr_manager', name: 'HR Admin' },
    body: { hr_passportduedate: '2026-12-01' },
  });
  assert.strictEqual(code, 200);
  assert.strictEqual(saved.hr_passportduedate, '2026-12-01');
});

test('failure — column unprovisionable → 503, no false success, other fields still saved', async () => {
  const updates = [];
  // ensureEmployeeColumns tries to provision via getHeaders → make it fail fast (no network).
  d365.getHeaders = async () => { throw new Error('no d365 in test'); };
  d365._isMissingProperty = (e) => !!(e && e.__missingProp);
  d365._missingPropertyName = () => 'hr_passportduedate';
  // The due-date column never exists: any write carrying it is rejected; drop it and the write succeeds.
  d365.update = async (_e, _id, body) => {
    updates.push({ ...body });
    if (Object.prototype.hasOwnProperty.call(body, 'hr_passportduedate')) {
      const err = new Error('The property hr_passportduedate does not exist'); err.__missingProp = true; throw err;
    }
    return { hr_hremployeeid: _id };
  };

  let thrown;
  await invoke(patchHandler(), {
    params: { id: EMP_ID },
    user: { id: 'hr-admin-id', role: 'hr_manager', name: 'HR Admin' },
    body: { hr_passportduedate: '2026-12-01', hr_phone: '9999999999' },
  }).catch((e) => { thrown = e; });

  assert.ok(thrown, 'the handler surfaced an error instead of a false success');
  assert.strictEqual(thrown.status, 503);
  assert.strictEqual(thrown.field, 'hr_passportduedate');
  assert.match(thrown.message, /Passport Submission Due Date/);
  assert.match(thrown.message, /could not be saved/i);

  // Other data WAS preserved: the final successful write carried hr_phone and NOT the due date.
  const lastSaved = updates[updates.length - 1];
  assert.strictEqual(lastSaved.hr_phone, '9999999999', 'unrelated field persisted');
  assert.strictEqual(lastSaved.hr_passportduedate, undefined, 'the unsavable column was not in the successful write');
});
