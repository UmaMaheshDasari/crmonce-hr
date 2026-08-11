/**
 * Comp-Off expiry starts ONLY at approval:
 *   Pending  → NO expiry (blank).
 *   Approve  → expiry = approval date (today) + 45-day policy — NEVER the worked date.
 *   Reject   → no expiry, no balance.
 *   Expiry reached → sweepExpired marks Expired.
 *   Duplicate approval is blocked (409) → original expiry is never reset.
 *
 * No network: policy + d365 calls stubbed.
 */
process.env.NODE_ENV = 'test';
process.env.AZURE_CLIENT_ID = process.env.AZURE_CLIENT_ID || 'test-client';
process.env.AZURE_CLIENT_SECRET = process.env.AZURE_CLIENT_SECRET || 'test-secret';
process.env.AZURE_TENANT_ID = process.env.AZURE_TENANT_ID || 'test-tenant';

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const d365 = require('../src/services/d365.service');
const payrollSettings = require('../src/services/payroll-settings.service');
const leaveEngine = require('../src/services/leave-engine.service');
const compOff = require('../src/services/comp-off.service');

const COMP = d365.constructor.entities.compOff;
const today = () => new Date().toISOString().slice(0, 10);
const addDays = (ds, n) => { const d = new Date(`${ds}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

let orig;
beforeEach(() => {
  orig = { create: d365.create, update: d365.update, getById: d365.getById, getList: d365.getList, resolved: payrollSettings.getResolved, ledger: leaveEngine.addLedgerEntry };
  payrollSettings.getResolved = async () => ({ compOff: { expiryDays: 45, autoEarn: true, employeeRaise: true } });
  leaveEngine.addLedgerEntry = async () => {};
});
afterEach(() => { d365.create = orig.create; d365.update = orig.update; d365.getById = orig.getById; d365.getList = orig.getList; payrollSettings.getResolved = orig.resolved; leaveEngine.addLedgerEntry = orig.ledger; });

// ── 1. Pending auto Comp Off → expiry NULL (blank), even for an old worked date ──
test('1. a PENDING comp-off is created with NO expiry', async () => {
  let body;
  d365.create = async (_e, b) => { body = b; return { hr_compoffid: 'c1' }; };
  await compOff.create({ employeeId: 'e1', employeeName: 'V', type: 'auto', workedDate: '2026-05-28', workedHours: 8, days: 1, createdBy: 'System (auto)', status: 'pending' });
  assert.strictEqual(body.hr_status, 'pending');
  assert.strictEqual(body.hr_expirydate, '', 'pending → no expiry');
});

// A manual grant created already-approved expires from TODAY (approval), not the worked date.
test('1b. an approved-at-create grant expires from today, not the worked date', async () => {
  let body; d365.create = async (_e, b) => { body = b; return { hr_compoffid: 'c1b' }; };
  d365.update = async () => ({});
  await compOff.create({ employeeId: 'e1', employeeName: 'V', type: 'manual', workedDate: '2026-01-01', days: 1, createdBy: 'HR', status: 'approved' });
  assert.strictEqual(body.hr_expirydate, addDays(today(), 45));
  assert.notStrictEqual(body.hr_expirydate, addDays('2026-01-01', 45));
});

// ── 2 & 5. Approve → expiry = today + 45, NOT worked date + 45 ──
test('2/5. approving a pending record sets expiry = approval date + 45 (never worked date)', async () => {
  const workedDate = '2026-05-28';
  const rec = { hr_compoffid: 'c2', hr_employeeid: 'e1', hr_employeename: 'V', hr_year: '2026', hr_days: '1', hr_workeddate: workedDate, hr_status: 'pending', hr_ledgerlinked: 'false', hr_expirydate: '' };
  let updated; d365.getById = async () => rec; d365.update = async (_e, _id, patch) => { updated = patch; return {}; };
  await compOff.approve('c2', { name: 'HR' });
  assert.strictEqual(updated.hr_status, 'approved');
  assert.ok(updated.hr_approveddate, 'approval date is set');
  assert.strictEqual(updated.hr_expirydate, addDays(today(), 45), 'expiry from approval date');
  assert.notStrictEqual(updated.hr_expirydate, addDays(workedDate, 45), 'NOT from the worked date');
});

// ── 3. Reject → no expiry, no balance ──
test('3. rejecting a pending record leaves NO expiry', async () => {
  const rec = { hr_compoffid: 'c3', hr_employeeid: 'e1', hr_status: 'pending', hr_ledgerlinked: 'false', hr_workeddate: '2026-05-28' };
  let updated; d365.getById = async () => rec; d365.update = async (_e, _id, patch) => { updated = patch; return {}; };
  await compOff.reject('c3', { name: 'HR' }, 'not eligible');
  assert.strictEqual(updated.hr_status, 'rejected');
  assert.strictEqual(updated.hr_expirydate, '');
});

// ── 4. Expiry reached → sweepExpired marks Expired ──
test('4. an approved comp-off past its expiry is expired by the sweep', async () => {
  const expired = { hr_compoffid: 'c4', hr_status: 'approved', hr_expirydate: addDays(today(), -1), hr_ledgerlinked: 'true', hr_employeeid: 'e1', hr_employeename: 'V', hr_days: '1', hr_year: '2026', hr_workeddate: '2026-05-28' };
  d365.getList = async (e) => (e === COMP ? { data: [expired] } : { data: [] });
  d365.getById = async () => expired;                       // expire() getRaw + email lookup
  const updates = []; d365.update = async (_e, _id, patch) => { updates.push(patch); return {}; };
  const n = await compOff.sweepExpired();
  assert.strictEqual(n, 1);
  assert.ok(updates.some(u => u.hr_status === 'expired'), 'status set to expired');
});

// A NOT-yet-due approved comp-off is not swept.
test('4b. an approved comp-off before its expiry is NOT expired', async () => {
  const future = { hr_compoffid: 'c4b', hr_status: 'approved', hr_expirydate: addDays(today(), 10), hr_ledgerlinked: 'true' };
  d365.getList = async (e) => (e === COMP ? { data: [future] } : { data: [] });
  assert.strictEqual(await compOff.sweepExpired(), 0);
});

// ── 6. Duplicate approval does not reset the original expiry ──
test('6. approving an already-approved record is blocked (409) → expiry untouched', async () => {
  const originalExpiry = addDays('2026-06-20', 45);         // approval was 20-Jun → 04-Aug
  const rec = { hr_compoffid: 'c6', hr_status: 'approved', hr_ledgerlinked: 'true', hr_expirydate: originalExpiry, hr_days: '1', hr_employeeid: 'e1' };
  let updated; d365.getById = async () => rec; d365.update = async (_e, _id, patch) => { updated = patch; return {}; };
  await assert.rejects(() => compOff.approve('c6', { name: 'HR' }), /already approved/);
  assert.strictEqual(updated, undefined, 'no update issued → expiry not reset');
  assert.strictEqual(rec.hr_expirydate, originalExpiry);
});
