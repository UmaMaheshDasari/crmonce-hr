/**
 * Casual Leave annual carry-forward (max 5):
 *   carry = MIN(clamp0(prev-year CL remaining), max)   [default max 5]
 *   next-year CL entitlement = annual allocation + carried days (via the leave ledger)
 *   rollover is IDEMPOTENT — running twice never double-credits.
 *
 * No network: d365 + payroll settings + leaveOpening are stubbed.
 */
process.env.NODE_ENV = 'test';
process.env.AZURE_CLIENT_ID = process.env.AZURE_CLIENT_ID || 'test-client';
process.env.AZURE_CLIENT_SECRET = process.env.AZURE_CLIENT_SECRET || 'test-secret';
process.env.AZURE_TENANT_ID = process.env.AZURE_TENANT_ID || 'test-tenant';

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const engine = require('../src/services/leave-engine.service');
const d365 = require('../src/services/d365.service');
const payrollSettings = require('../src/services/payroll-settings.service');
const leaveOpening = require('../src/services/leave-opening.service');
const { toValue } = require('../src/services/picklist');

const LEAVE = d365.constructor.entities.leave;
const LEDGER = d365.constructor.entities.leaveLedger;
const CL = toValue('hr_leave_type', 'Casual Leave');

// ── 1. Pure formula: the exact table from the business rule ──
test('casualCarryForward = MIN(max(0, remaining), 5)', () => {
  const cases = [[10, 5], [8, 5], [5, 5], [4, 4], [3, 3], [2, 2], [1, 1], [0, 0], [-2, 0], [-0.5, 0], [5.5, 5]];
  for (const [remaining, expected] of cases) {
    assert.strictEqual(engine.casualCarryForward(remaining), expected, `remaining ${remaining} → ${expected}`);
  }
  assert.strictEqual(engine.casualCarryForward(10, 3), 3, 'a different max is honoured');
});

// ── 2. Entitlement folding: carry_forward raises next-year CL entitlement ──
test('a carry_forward ledger credit raises next-year CL entitlement (12 + carry = opening)', () => {
  const b = engine.computeBalance({
    leaves: [], policy: { casual: 12, sick: 6 },
    ledger: [{ kind: 'carry_forward', category: 'casual', days: 5 }],
  });
  assert.strictEqual(b.casual.entitled, 17, '12 annual + 5 carried');
  assert.strictEqual(b.casual.remaining, 17, 'nothing used yet');
});

test('worked example: 2026 used 9 (remaining 3) → 2027 opening = 12 + 3 = 15', () => {
  const carry = engine.casualCarryForward(3);
  const b = engine.computeBalance({ leaves: [], policy: { casual: 12, sick: 6 }, ledger: [{ kind: 'carry_forward', category: 'casual', days: carry }] });
  assert.strictEqual(carry, 3);
  assert.strictEqual(b.casual.entitled, 15);
});

// ── async rollover harness ──
const clLeave = (emp, days, year) => ({ hr_leavetype: CL, hr_days: String(days), hr_fromdate: `${year}-03-01`, hr_todate: `${year}-03-01`, hr_status: toValue('hr_leave_status', 'approved') });
let orig;
beforeEach(() => { orig = { gl: d365.getList, cr: d365.create, ps: payrollSettings.getResolved, op: leaveOpening.getOpening }; });
afterEach(() => { d365.getList = orig.gl; d365.create = orig.cr; payrollSettings.getResolved = orig.ps; leaveOpening.getOpening = orig.op; });

/**
 * @param usedByEmp  { empId: casualDaysUsedInFromYear }  → remaining = 12 - used
 * @param existingCarry { empId: true }  → a carry_forward row already exists for toYear
 */
function stub({ fromYear = 2026, usedByEmp = {}, existingCarry = {} } = {}) {
  const created = [];
  payrollSettings.getResolved = async () => ({ leavePolicy: { casual: 12, sick: 6, casualCarryForwardMax: 5 } });
  leaveOpening.getOpening = async () => ({});
  d365.getList = async (entity, opts) => {
    const flt = String(opts?.filter || '');
    if (entity === LEDGER && /hr_kind eq 'carry_forward'/.test(flt)) {
      const emp = (flt.match(/hr_employeeid eq '([^']+)'/) || [])[1];
      return { data: existingCarry[emp] ? [{ hr_leaveledgerid: 'x' }] : [] };
    }
    if (entity === LEDGER) return { data: [] };                       // fromYear ledger (no prior credits)
    if (entity === LEAVE) {
      const emp = (flt.match(/_hr_hremployee_value eq '([^']+)'/) || [])[1];
      const used = usedByEmp[emp] || 0;
      return { data: used > 0 ? [clLeave(emp, used, fromYear)] : [] };
    }
    return { data: [] };
  };
  d365.create = async (_e, body) => { created.push(body); return { hr_leaveledgerid: 'NEW' }; };
  return created;
}

// ── 3. Rollover carries MIN(remaining, 5) for multiple employees ──
test('rollover: multiple employees each get MIN(remaining, 5); 0-remaining gets nothing', async () => {
  const created = stub({ fromYear: 2026, usedByEmp: { A: 2, B: 8, C: 12 } });   // remaining 10, 4, 0
  const employees = [{ hr_hremployeeid: 'A', hr_hremployee1: 'Amy' }, { hr_hremployeeid: 'B', hr_hremployee1: 'Ben' }, { hr_hremployeeid: 'C', hr_hremployee1: 'Cy' }];
  const r = await engine.rollCasualLeaveForward({ fromYear: 2026, toYear: 2027, employees });
  assert.strictEqual(r.carried, 2, 'A and B carried, C (0) skipped');
  assert.strictEqual(r.totalDays, 9, '5 + 4');
  const byEmp = Object.fromEntries(created.map(x => [x.hr_employeeid, x]));
  assert.strictEqual(Number(byEmp.A.hr_days), 5, 'A remaining 10 → 5');
  assert.strictEqual(Number(byEmp.B.hr_days), 4, 'B remaining 4 → 4');
  assert.ok(!byEmp.C, 'C remaining 0 → no entry');
  // Every written row is a carry_forward casual credit into 2027 — nothing else touched.
  for (const x of created) {
    assert.strictEqual(x.hr_kind, 'carry_forward');
    assert.strictEqual(x.hr_category, 'casual');
    assert.strictEqual(x.hr_year, '2027');
  }
});

// ── 4. Idempotency: an already-carried employee is skipped (no double credit) ──
test('rollover is idempotent — employees already carried are skipped, nothing written', async () => {
  const created = stub({ fromYear: 2026, usedByEmp: { A: 2, B: 8 }, existingCarry: { A: true, B: true } });
  const employees = [{ hr_hremployeeid: 'A', hr_hremployee1: 'Amy' }, { hr_hremployeeid: 'B', hr_hremployee1: 'Ben' }];
  const r = await engine.rollCasualLeaveForward({ fromYear: 2026, toYear: 2027, employees });
  assert.strictEqual(r.carried, 0);
  assert.strictEqual(r.skipped, 2);
  assert.strictEqual(created.length, 0, 'no duplicate carry-forward rows');
});

test('rollover: mixed — new employee carried, already-carried employee skipped', async () => {
  const created = stub({ fromYear: 2026, usedByEmp: { A: 2, B: 8 }, existingCarry: { A: true } });
  const employees = [{ hr_hremployeeid: 'A', hr_hremployee1: 'Amy' }, { hr_hremployeeid: 'B', hr_hremployee1: 'Ben' }];
  const r = await engine.rollCasualLeaveForward({ fromYear: 2026, toYear: 2027, employees });
  assert.strictEqual(r.carried, 1);
  assert.strictEqual(r.skipped, 1);
  assert.strictEqual(created.length, 1);
  assert.strictEqual(created[0].hr_employeeid, 'B');
});

// ── 5. Consecutive years: the SAME rule applies each year ──
test('consecutive years: 2027→2028 carry uses 2027 remaining (same MIN(remaining,5) rule)', async () => {
  const created = stub({ fromYear: 2027, usedByEmp: { A: 9 } });   // 2027 remaining 3
  const r = await engine.rollCasualLeaveForward({ fromYear: 2027, toYear: 2028, employees: [{ hr_hremployeeid: 'A', hr_hremployee1: 'Amy' }] });
  assert.strictEqual(r.carried, 1);
  assert.strictEqual(Number(created[0].hr_days), 3);
  assert.strictEqual(created[0].hr_year, '2028');
});

test('toYear defaults to fromYear + 1', async () => {
  stub({ fromYear: 2026, usedByEmp: {} });
  const r = await engine.rollCasualLeaveForward({ fromYear: 2026, employees: [] });
  assert.strictEqual(r.toYear, 2027);
});
