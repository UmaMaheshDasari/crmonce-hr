/**
 * Passport Number becomes mandatory on/after the admin-set due date (Asia/Kolkata) —
 * enforced on the REAL employee PATCH handler, section-aware. Proves:
 *   - before the due date → optional (Identity save with empty passport succeeds);
 *   - ON and AFTER the due date → mandatory for an Identity submission (400 + exact message);
 *   - a non-Identity save (e.g. Address) with an empty passport is NEVER blocked;
 *   - providing a passport allows saving;
 *   - no due date configured → never mandatory (existing pending behavior retained);
 *   - HR writes are exempt (self-service rule);
 *   - the backend cannot be bypassed by a hand-crafted Identity change.
 * Dates are relative to the real IST "today" so the test is deterministic. d365 + profile
 * stubbed; no network, no production data.
 */
process.env.NODE_ENV = 'test';
process.env.AZURE_CLIENT_ID = process.env.AZURE_CLIENT_ID || 'x';
process.env.AZURE_CLIENT_SECRET = process.env.AZURE_CLIENT_SECRET || 'x';
process.env.AZURE_TENANT_ID = process.env.AZURE_TENANT_ID || 'x';

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const d365 = require('../src/services/d365.service');
const profile = require('../src/services/profile.service');
const { istDateStr } = require('../src/services/time.util');
const router = require('../src/modules/employees/employee.routes');

const EMP_ID = '33333333-3333-3333-3333-333333333333';
const MSG = 'Your passport submission due date has arrived. Please enter your Passport Number.';

const TODAY = istDateStr();
const shiftDate = (base, n) => { const [y, m, d] = base.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10); };
const YESTERDAY = shiftDate(TODAY, -1);
const TOMORROW = shiftDate(TODAY, 1);

const patchHandler = () => {
  const l = router.stack.find(x => x.route && x.route.path === '/:id' && x.route.methods.patch);
  return l.route.stack[l.route.stack.length - 1].handle;
};
const invoke = async (handler, req) => {
  let body, code = 200; const res = { status(c) { code = c; return this; }, json(b) { body = b; return this; } };
  await handler(req, res, (e) => { if (e) throw e; });
  return { code, body };
};

// The record the PATCH handler reads as "current". Each test sets .due and any identity base.
let currentRec, lastSaved, orig;
const BASE = { hr_hremployee1: 'Emp', hr_passport: '', hr_pan: 'ABCDE1234F', hr_pfnumber: '', hr_city: 'Old City' };

beforeEach(() => {
  orig = { gbir: d365.getByIdResilient, up: d365.update, nu: profile.notifyUser, wa: profile.writeAudit, nhv: profile.notifyHRVerification };
  currentRec = { ...BASE, hr_passportduedate: '' };
  lastSaved = undefined;
  d365.getByIdResilient = async () => currentRec;
  d365.update = async (_e, _id, body) => { lastSaved = body; return { hr_hremployeeid: _id }; };
  profile.notifyUser = () => {};
  profile.writeAudit = async () => {};
  profile.notifyHRVerification = async () => {};
});
afterEach(() => {
  Object.assign(d365, { getByIdResilient: orig.gbir, update: orig.up });
  Object.assign(profile, { notifyUser: orig.nu, writeAudit: orig.wa, notifyHRVerification: orig.nhv });
});

const self = { id: EMP_ID, role: 'employee', name: 'Emp' };
const hr = { id: 'hr-id', role: 'hr_manager', name: 'HR' };
const patch = (user, body) => invoke(patchHandler(), { params: { id: EMP_ID }, user, body });

test('before the due date — Identity save with empty passport is allowed (optional)', async () => {
  currentRec.hr_passportduedate = TOMORROW;
  const { code } = await patch(self, { hr_pfnumber: 'PF-NEW' });   // Identity field changes; passport empty
  assert.strictEqual(code, 200);
  assert.strictEqual(lastSaved.hr_pfnumber, 'PF-NEW');
});

test('ON the due date — Identity submission with empty passport is rejected with the exact message', async () => {
  currentRec.hr_passportduedate = TODAY;
  const { code, body } = await patch(self, { hr_pfnumber: 'PF-NEW' });
  assert.strictEqual(code, 400);
  assert.strictEqual(body.error, MSG);
  assert.strictEqual(body.fields.hr_passport, MSG);
  assert.strictEqual(lastSaved, undefined, 'nothing was written');
});

test('AFTER the due date — Identity submission with empty passport is rejected', async () => {
  currentRec.hr_passportduedate = YESTERDAY;
  const { code, body } = await patch(self, { hr_pfnumber: 'PF-NEW' });
  assert.strictEqual(code, 400);
  assert.strictEqual(body.error, MSG);
  assert.strictEqual(lastSaved, undefined);
});

test('AFTER the due date — a NON-Identity save (Address) with empty passport is NOT blocked', async () => {
  currentRec.hr_passportduedate = YESTERDAY;
  const { code } = await patch(self, { hr_city: 'New City' });   // Address only; no Identity change
  assert.strictEqual(code, 200);
  assert.strictEqual(lastSaved.hr_city, 'New City');
});

test('AFTER the due date — providing a passport allows the Identity save', async () => {
  currentRec.hr_passportduedate = YESTERDAY;
  const { code } = await patch(self, { hr_passport: 'A1234567' });
  assert.strictEqual(code, 200);
  assert.strictEqual(lastSaved.hr_passport, 'A1234567');
});

test('no due date configured — Identity save with empty passport is allowed (pending retained)', async () => {
  currentRec.hr_passportduedate = '';
  const { code } = await patch(self, { hr_pfnumber: 'PF-NEW' });
  assert.strictEqual(code, 200);
});

test('HR edit is exempt — after the due date, HR can still save with an empty passport', async () => {
  currentRec.hr_passportduedate = YESTERDAY;
  const { code } = await patch(hr, { hr_pfnumber: 'PF-NEW' });
  assert.strictEqual(code, 200);
});

test('backend cannot be bypassed — a hand-crafted Identity (PAN) change with empty passport is rejected after due', async () => {
  currentRec.hr_passportduedate = YESTERDAY;
  const { code, body } = await patch(self, { hr_pan: 'ABCDE1234G' });   // valid, different PAN → Identity change
  assert.strictEqual(code, 400);
  assert.strictEqual(body.error, MSG);
  assert.strictEqual(lastSaved, undefined);
});
