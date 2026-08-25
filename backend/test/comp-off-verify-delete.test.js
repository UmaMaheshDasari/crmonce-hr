/**
 * Comp-Off approval attendance re-verification + delete.
 *   Approve (auto): live attendance MUST still qualify (Holiday/Weekly-Off + worked +
 *   effective hours) — else blocked, no credit. Delete: pending/rejected removed;
 *   approved-unused reverses the ledger then deletes; approved-USED is blocked.
 *
 * No network: d365 + policy + ledger stubbed.
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
const attnCfg = require('../src/services/attendance.config');
const compOff = require('../src/services/comp-off.service');
const { toValue } = require('../src/services/picklist');

const pad2 = (n) => String(n).padStart(2, '0');
const PRESENT = toValue('hr_attendance_status', 'present');
const HOLIDAY = '2026-07-15';
const findDow = (t, ex = []) => { for (let d = 1; d <= 31; d++) { const ds = `2026-07-${pad2(d)}`; if (ex.includes(ds)) continue; if (new Date(`${ds}T00:00:00Z`).getUTCDay() === t) return ds; } };
const WEEKLY_OFF = findDow(6);
const WEEKDAY = findDow(2, [HOLIDAY]);
const EMP = 'e1';
const OWNER = { id: EMP, role: 'employee' };            // the employee who owns the comp-off

const autoRow = (over = {}) => ({ hr_compoffid: 'a1', hr_type: 'auto', hr_employeeid: EMP, hr_employeename: 'Vishwesh', hr_year: '2026', hr_days: '1', hr_workeddate: HOLIDAY, hr_status: 'pending', hr_ledgerlinked: 'false', ...over });
const attRow = (over = {}) => ({ _hr_hremployee_value: EMP, hr_date: HOLIDAY, hr_status: PRESENT, hr_intime: '09:00', hr_effectivehours: 8.3, ...over });

let orig;
beforeEach(() => {
  orig = { gid: d365.getById, gl: d365.getList, upd: d365.update, del: d365.delete, bal: leaveEngine.getBalance, led: leaveEngine.addLedgerEntry, res: payrollSettings.getResolved, woff: attnCfg.weekOffDays };
  attnCfg.weekOffDays = [0, 6]; attnCfg.setDynamicHolidays([HOLIDAY]);
  payrollSettings.getResolved = async () => ({ compOff: { expiryDays: 45, autoEarn: true } });
});
afterEach(() => { d365.getById = orig.gid; d365.getList = orig.gl; d365.update = orig.upd; d365.delete = orig.del; leaveEngine.getBalance = orig.bal; leaveEngine.addLedgerEntry = orig.led; payrollSettings.getResolved = orig.res; attnCfg.weekOffDays = orig.woff; });

// Wire an approve run: comp-off row + attendance rows. Returns captured ledger + updates.
function approveHarness({ row, attendance }) {
  const ledger = [], updates = [];
  d365.getById = async () => row;
  d365.update = async (_e, _id, patch) => { updates.push(patch); return {}; };
  leaveEngine.addLedgerEntry = async (e) => { ledger.push(e); };
  d365.getList = async (entity, params = {}) => {
    if (entity === d365.constructor.entities.attendance) {
      const ef = /_hr_hremployee_value eq '([^']+)'/.exec(params.filter || '');
      const df = /hr_date ge '(\d{4}-\d{2}-\d{2})' and hr_date le '(\d{4}-\d{2}-\d{2})'/.exec(params.filter || '');
      let rows = attendance || [];
      if (ef) rows = rows.filter(a => a._hr_hremployee_value === ef[1]);
      if (df) rows = rows.filter(a => { const d = String(a.hr_date).slice(0, 10); return d >= df[1] && d <= df[2]; });
      return { data: rows };
    }
    return { data: [] };
  };
  return { ledger, updates };
}

// ── 1 & 2. valid Holiday / Weekly-Off → Approve succeeds + credits ──
test('1. auto + valid Holiday attendance → Approve succeeds and credits', async () => {
  const { ledger } = approveHarness({ row: autoRow(), attendance: [attRow({ hr_effectivehours: 8.3 })] });
  const res = await compOff.approve('a1', { name: 'HR' });
  assert.strictEqual(res.status, 'approved');
  assert.strictEqual(ledger.length, 1);
  assert.strictEqual(Number(ledger[0].days), 1);
});
test('2. auto + valid Weekly-Off attendance → Approve succeeds', async () => {
  attnCfg.setDynamicHolidays([]);
  const { ledger } = approveHarness({ row: autoRow({ hr_workeddate: WEEKLY_OFF }), attendance: [attRow({ hr_date: WEEKLY_OFF, hr_effectivehours: 9 })] });
  const res = await compOff.approve('a1', { name: 'HR' });
  assert.strictEqual(res.status, 'approved');
  assert.strictEqual(Number(ledger[0].days), 1);
});

// ── 3/4/5. no matching attendance → blocked, no credit ──
test('3. missing attendance → approval blocked', async () => {
  const { ledger } = approveHarness({ row: autoRow(), attendance: [] });
  await assert.rejects(() => compOff.approve('a1', { name: 'HR' }), /does not qualify/);
  assert.strictEqual(ledger.length, 0);
});
test('4. wrong employee (attendance belongs to another) → blocked', async () => {
  const { ledger } = approveHarness({ row: autoRow(), attendance: [attRow({ _hr_hremployee_value: 'someone-else' })] });
  await assert.rejects(() => compOff.approve('a1', { name: 'HR' }), /does not qualify/);
  assert.strictEqual(ledger.length, 0);
});
test('5. wrong worked date (no attendance that day) → blocked', async () => {
  const { ledger } = approveHarness({ row: autoRow(), attendance: [attRow({ hr_date: '2026-07-16' })] });
  await assert.rejects(() => compOff.approve('a1', { name: 'HR' }), /does not qualify/);
  assert.strictEqual(ledger.length, 0);
});

// ── 6. normal working day → blocked ──
test('6. normal working day → approval blocked', async () => {
  attnCfg.setDynamicHolidays([]);   // WEEKDAY is neither holiday nor weekly-off
  const { ledger } = approveHarness({ row: autoRow({ hr_workeddate: WEEKDAY }), attendance: [attRow({ hr_date: WEEKDAY, hr_effectivehours: 8 })] });
  await assert.rejects(() => compOff.approve('a1', { name: 'HR' }), /does not qualify/);
  assert.strictEqual(ledger.length, 0);
});

// ── 7–10. hours thresholds on a holiday ──
test('7a. 4:59 hours → approval blocked (below 5h)', async () => {
  const { ledger } = approveHarness({ row: autoRow(), attendance: [attRow({ hr_effectivehours: 5 - 1 / 60 })] });
  await assert.rejects(() => compOff.approve('a1', { name: 'HR' }), /does not qualify/);
  assert.strictEqual(ledger.length, 0);
});
test('7b. exactly 5:00 hours → approve credits 0.5 (new rule)', async () => {
  const { ledger } = approveHarness({ row: autoRow(), attendance: [attRow({ hr_effectivehours: 5 })] });
  await compOff.approve('a1', { name: 'HR' });
  assert.strictEqual(Number(ledger[0].days), 0.5);
});
test('8. 5:01 hours → approve credits 0.5', async () => {
  const { ledger } = approveHarness({ row: autoRow(), attendance: [attRow({ hr_effectivehours: 5 + 1 / 60 })] });
  await compOff.approve('a1', { name: 'HR' });
  assert.strictEqual(Number(ledger[0].days), 0.5);
});
test('9. 7:59 hours → approve credits 0.5', async () => {
  const { ledger } = approveHarness({ row: autoRow(), attendance: [attRow({ hr_effectivehours: 7 + 59 / 60 })] });
  await compOff.approve('a1', { name: 'HR' });
  assert.strictEqual(Number(ledger[0].days), 0.5);
});
test('10. 8:00 hours → approve credits 1', async () => {
  const { ledger } = approveHarness({ row: autoRow(), attendance: [attRow({ hr_effectivehours: 8 })] });
  await compOff.approve('a1', { name: 'HR' });
  assert.strictEqual(Number(ledger[0].days), 1);
});

// ── 11. attendance CHANGED after generation → re-validate blocks ──
test('11. attendance no longer qualifies (hours dropped) → approval blocked', async () => {
  const { ledger } = approveHarness({ row: autoRow({ hr_days: '1' }), attendance: [attRow({ hr_effectivehours: 4 })] });
  await assert.rejects(() => compOff.approve('a1', { name: 'HR' }), /does not qualify/);
  assert.strictEqual(ledger.length, 0);
});

// ── 16. duplicate approval blocked ──
test('16. approving an already-approved record → 409, no re-credit', async () => {
  const { ledger } = approveHarness({ row: autoRow({ hr_status: 'approved', hr_ledgerlinked: 'true' }), attendance: [attRow()] });
  await assert.rejects(() => compOff.approve('a1', { name: 'HR' }), /already approved/);
  assert.strictEqual(ledger.length, 0);
});

// ── delete ──
function deleteHarness({ row, balance }) {
  const ledger = [], deletes = [];
  d365.getById = async () => row;
  d365.delete = async (_e, id) => { deletes.push(id); return {}; };
  leaveEngine.getBalance = async () => ({ compOff: { balance } });
  leaveEngine.addLedgerEntry = async (e) => { ledger.push(e); };
  return { ledger, deletes };
}

test('12. pending delete → record removed, no ledger change', async () => {
  const { ledger, deletes } = deleteHarness({ row: autoRow({ hr_status: 'pending', hr_ledgerlinked: 'false' }), balance: 0 });
  const res = await compOff.remove('a1', OWNER);
  assert.strictEqual(res.deleted, true);
  assert.deepStrictEqual(deletes, ['a1']);
  assert.strictEqual(ledger.length, 0);
});
test('13. rejected delete → record removed', async () => {
  const { deletes } = deleteHarness({ row: autoRow({ hr_status: 'rejected', hr_ledgerlinked: 'false' }), balance: 0 });
  await compOff.remove('a1', OWNER);
  assert.deepStrictEqual(deletes, ['a1']);
});
test('14/20. approved UNUSED delete → ledger reversed (−days) then removed', async () => {
  const { ledger, deletes } = deleteHarness({ row: autoRow({ hr_status: 'approved', hr_ledgerlinked: 'true', hr_days: '1' }), balance: 3 });
  await compOff.remove('a1', OWNER);
  assert.strictEqual(ledger.length, 1);
  assert.strictEqual(Number(ledger[0].days), -1, 'reversal credit is negative');
  assert.deepStrictEqual(deletes, ['a1']);
});
test('15. approved USED delete → blocked, nothing removed', async () => {
  const { ledger, deletes } = deleteHarness({ row: autoRow({ hr_status: 'approved', hr_ledgerlinked: 'true', hr_days: '1' }), balance: 0 });
  await assert.rejects(() => compOff.remove('a1', OWNER), /already been used/);
  assert.strictEqual(deletes.length, 0);
  assert.strictEqual(ledger.length, 0);
});

// ── authorization: delete is employee-only, own-record-only ──
test('Auth: HR / Admin cannot delete (403) — even a pending record', async () => {
  const { deletes } = deleteHarness({ row: autoRow({ hr_status: 'pending' }), balance: 0 });
  await assert.rejects(() => compOff.remove('a1', { id: 'admin-1', role: 'super_admin' }), /not available for HR/i);
  await assert.rejects(() => compOff.remove('a1', { id: 'hr-1', role: 'hr_manager' }), /not available for HR/i);
  assert.strictEqual(deletes.length, 0);
});
test('Auth: an employee cannot delete another employee\'s comp-off (403)', async () => {
  const { deletes } = deleteHarness({ row: autoRow({ hr_status: 'pending', hr_employeeid: EMP }), balance: 0 });
  await assert.rejects(() => compOff.remove('a1', { id: 'other-emp', role: 'employee' }), /only delete your own/i);
  assert.strictEqual(deletes.length, 0);
});
test('Auth: an employee deletes their OWN pending comp-off → success', async () => {
  const { deletes } = deleteHarness({ row: autoRow({ hr_status: 'pending', hr_employeeid: EMP }), balance: 0 });
  const res = await compOff.remove('a1', { id: EMP, role: 'employee' });
  assert.strictEqual(res.deleted, true);
  assert.deepStrictEqual(deletes, ['a1']);
});

// ── manual grants are NOT attendance-verified (HR discretion) ──
test('a manual grant approves without attendance verification', async () => {
  const { ledger } = approveHarness({ row: autoRow({ hr_type: 'manual' }), attendance: [] });
  const res = await compOff.approve('a1', { name: 'HR' });
  assert.strictEqual(res.status, 'approved');
  assert.strictEqual(ledger.length, 1);
});
