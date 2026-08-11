/**
 * Payroll Automation — delete a run's HISTORY record.
 *   - HR / Super-Admin only (route guard); employee → 403.
 *   - Blocked when the run's payroll is finalized (Released/paid or Locked) → 409.
 *   - Deletes ONLY the hr_payrolljobs row — never payroll/employee/attendance/leave/
 *     comp-off/salary-structure data. No orphan records.
 *
 * No network: d365 get/list/delete stubbed.
 */
process.env.NODE_ENV = 'test';
process.env.AZURE_CLIENT_ID = process.env.AZURE_CLIENT_ID || 'test-client';
process.env.AZURE_CLIENT_SECRET = process.env.AZURE_CLIENT_SECRET || 'test-secret';
process.env.AZURE_TENANT_ID = process.env.AZURE_TENANT_ID || 'test-tenant';

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const d365 = require('../src/services/d365.service');
const { toValue } = require('../src/services/picklist');
const { requireRole } = require('../src/middleware/auth.middleware');
const automation = require('../src/services/payroll-automation.service');

const JOB = d365.constructor.entities.payrollJob;
const PAYROLL = d365.constructor.entities.payroll;
const PAID = toValue('hr_payroll_status', 'paid');

// ── route authorization (the exact guard the DELETE route uses) ──
function guardResult(role) {
  const mw = requireRole('super_admin', 'hr_manager');
  let code = 200, nexted = false;
  mw({ user: { role } }, { status: (c) => { code = c; return { json: () => {} }; } }, () => { nexted = true; });
  return { code, nexted };
}
test('Super Admin passes the delete guard', () => { const r = guardResult('super_admin'); assert.ok(r.nexted); });
test('HR Manager passes the delete guard', () => { const r = guardResult('hr_manager'); assert.ok(r.nexted); });
test('Employee is blocked by the delete guard → 403', () => { const r = guardResult('employee'); assert.strictEqual(r.code, 403); assert.strictEqual(r.nexted, false); });

// ── service deleteJob ──
let orig, deletes;
function stub({ month = 7, year = 2026, payrollRows = [] } = {}) {
  deletes = [];
  d365.getById = async () => ({ hr_payrolljobid: 'j1', hr_name: `Payroll Jul ${year}`, hr_month: String(month), hr_year: String(year), hr_status: 'completed', hr_stages: '[]', hr_logs: '[]', hr_summary: '{}' });
  d365.getListOptional = async (entity) => (entity === PAYROLL ? { data: payrollRows } : { data: [] });
  d365.delete = async (entity, id) => { deletes.push({ entity, id }); return {}; };
}
beforeEach(() => { orig = { gid: d365.getById, glo: d365.getListOptional, del: d365.delete }; });
afterEach(() => { d365.getById = orig.gid; d365.getListOptional = orig.glo; d365.delete = orig.del; });

test('eligible run (no finalized payroll) → deletes ONLY the job row', async () => {
  stub({ payrollRows: [{ hr_hrpayrollid: 'p1', hr_status: toValue('hr_payroll_status', 'draft'), hr_locked: 'false' }] });
  const r = await automation.deleteJob({ jobId: 'j1' });
  assert.strictEqual(r.deleted, true);
  assert.strictEqual(deletes.length, 1, 'exactly one delete');
  assert.strictEqual(deletes[0].entity, JOB, 'only the hr_payrolljobs row is deleted');
  assert.strictEqual(deletes[0].id, 'j1');
});

test('LOCKED payroll → 409, nothing deleted', async () => {
  stub({ payrollRows: [{ hr_hrpayrollid: 'p1', hr_status: toValue('hr_payroll_status', 'processed'), hr_locked: 'true' }] });
  await assert.rejects(() => automation.deleteJob({ jobId: 'j1' }), (e) => e.status === 409 && /finalized/i.test(e.message));
  assert.strictEqual(deletes.length, 0);
});

test('RELEASED / salary-credited (paid) payroll → 409, nothing deleted', async () => {
  stub({ payrollRows: [{ hr_hrpayrollid: 'p1', hr_status: PAID, hr_locked: 'false' }] });
  await assert.rejects(() => automation.deleteJob({ jobId: 'j1' }), (e) => e.status === 409);
  assert.strictEqual(deletes.length, 0);
});

test('data-safety — delete never touches any entity other than hr_payrolljobs', async () => {
  stub({ payrollRows: [] });
  await automation.deleteJob({ jobId: 'j1' });
  const touched = new Set(deletes.map(d => d.entity));
  assert.deepStrictEqual([...touched], [JOB]);
  for (const e of [PAYROLL, d365.constructor.entities.employee, d365.constructor.entities.attendance, d365.constructor.entities.leave, d365.constructor.entities.compOff, d365.constructor.entities.salaryStructure]) {
    assert.ok(!touched.has(e), `${e} must NOT be deleted`);
  }
});

// isMonthFinalized truth table
test('isMonthFinalized: draft only → false; any locked/paid → true', async () => {
  d365.getListOptional = async () => ({ data: [{ hr_status: toValue('hr_payroll_status', 'draft'), hr_locked: 'false' }] });
  assert.strictEqual(await automation.isMonthFinalized(7, 2026), false);
  d365.getListOptional = async () => ({ data: [{ hr_status: PAID }] });
  assert.strictEqual(await automation.isMonthFinalized(7, 2026), true);
  d365.getListOptional = async () => ({ data: [{ hr_locked: 'true' }] });
  assert.strictEqual(await automation.isMonthFinalized(7, 2026), true);
});
