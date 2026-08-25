/**
 * Month-end Comp-Off auto-generation (A1 + B1):
 *   Eligible = actually WORKED on a Holiday / Weekly-Off. Days from EFFECTIVE hours
 *   (≥8→1, >5&&<8→0.5, ≤5→0). Generated as PENDING 'auto' records. Idempotent via
 *   existsForDate (Employee + Attendance Date). Month-isolated. No monthly cap.
 *
 * No network: policy/settings + all d365 calls (employees, attendance, existsForDate,
 * create) are stubbed with an in-memory comp-off store.
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
const ABSENT = toValue('hr_attendance_status', 'absent');

// Deterministic July 2026 dates: a holiday (declared), a weekly-off (a real Saturday),
// and a normal weekday (Mon–Fri, not a holiday).
const HOLIDAY = '2026-07-15';
function findDow(target, exclude = []) {
  for (let d = 1; d <= 31; d++) {
    const ds = `2026-07-${pad2(d)}`;
    if (exclude.includes(ds)) continue;
    if (new Date(`${ds}T00:00:00Z`).getUTCDay() === target) return ds;
  }
  return null;
}
const WEEKLY_OFF = findDow(6);                 // a Saturday
const WEEKDAY = findDow(2, [HOLIDAY]);         // a Tuesday, not the holiday

const EMP = 'emp-1';
const activeEmp = { hr_hremployeeid: EMP, hr_hremployee1: 'Vishwesh', hr_status: toValue('hr_employee_status', 'active'), hr_joiningdate: '2020-01-01' };
const att = (date, { hr_intime = '09:00', hr_status = PRESENT, eff } = {}) =>
  ({ hr_hrattendanceid: `a-${date}`, hr_date: date, hr_intime, hr_status, hr_effectivehours: eff, _hr_hremployee_value: EMP });

let orig, store;
function setup({ employees = [activeEmp], attendance = [], holidays = [HOLIDAY], existingComp = [] } = {}) {
  attnCfg.weekOffDays = [0, 6];
  attnCfg.setDynamicHolidays(holidays);
  store = [...existingComp];
  payrollSettings.getResolved = async () => ({ compOff: { autoEarn: true, expiryDays: 45 } });
  d365.getListOptional = async (entity, params = {}) => {
    if (entity === d365.constructor.entities.employee) return { data: employees };
    if (entity === d365.constructor.entities.attendance) {
      const mf = /hr_date ge '(\d{4}-\d{2}-\d{2})' and hr_date le '(\d{4}-\d{2}-\d{2})'/.exec(params.filter || '');
      const rows = mf ? attendance.filter(a => { const d = String(a.hr_date).slice(0, 10); return d >= mf[1] && d <= mf[2]; }) : attendance;
      return { data: rows };
    }
    return { data: [] };
  };
  d365.getList = async (entity, params = {}) => {
    if (entity === d365.constructor.entities.compOff) {
      const ef = /hr_employeeid eq '([^']+)' and hr_workeddate eq '([^']+)'/.exec(params.filter || '');
      const rows = ef ? store.filter(r => r.hr_employeeid === ef[1] && String(r.hr_workeddate).slice(0, 10) === ef[2]) : store;
      return { data: rows };
    }
    return { data: [] };
  };
  d365.create = async (entity, body) => {
    if (entity === d365.constructor.entities.compOff) { const rec = { ...body, hr_compoffid: `c${store.length + 1}` }; store.push(rec); return { hr_compoffid: rec.hr_compoffid }; }
    return {};
  };
}

beforeEach(() => { orig = { glo: d365.getListOptional, gl: d365.getList, cr: d365.create, gr: payrollSettings.getResolved }; });
afterEach(() => { d365.getListOptional = orig.glo; d365.getList = orig.gl; d365.create = orig.cr; payrollSettings.getResolved = orig.gr; });

// ── compOffDaysForHours (pure) ──
test('compOffDaysForHours: 4:59→0, 5:00→0.5, 6:00→0.5, 7:59→0.5, 8:00→1, 9:00→1', () => {
  assert.strictEqual(compOff.compOffDaysForHours(5 - 1 / 60), 0);   // 4h 59m → not eligible
  assert.strictEqual(compOff.compOffDaysForHours(5.0), 0.5);        // exactly 5h → eligible (new rule)
  assert.strictEqual(compOff.compOffDaysForHours(5 + 1 / 60), 0.5);
  assert.strictEqual(compOff.compOffDaysForHours(6.0), 0.5);
  assert.strictEqual(compOff.compOffDaysForHours(7 + 59 / 60), 0.5);
  assert.strictEqual(compOff.compOffDaysForHours(8.0), 1);
  assert.strictEqual(compOff.compOffDaysForHours(9.0), 1);
  assert.strictEqual(compOff.compOffDaysForHours(0), 0);
});

// ── eligibility + amount ──
test('1. normal weekday + 8h → NO comp-off (regular work)', async () => {
  setup({ attendance: [att(WEEKDAY, { eff: 8 })] });
  const s = await compOff.scanMonthCompOff({ month: 7, year: 2026 });
  assert.strictEqual(s.fullCompOff + s.halfCompOff, 0);
  assert.strictEqual(store.length, 0);
});
test('2a. Holiday + 4:59 → 0 (below the 5h minimum)', async () => {
  setup({ attendance: [att(HOLIDAY, { eff: 5 - 1 / 60 })] });
  const s = await compOff.scanMonthCompOff({ month: 7, year: 2026 });
  assert.strictEqual(store.length, 0);
  assert.strictEqual(s.ineligibleDays, 1);
});
test('2b. Holiday + 5:00 → 0.5 (exactly 5h is eligible)', async () => {
  setup({ attendance: [att(HOLIDAY, { eff: 5 })] });
  const s = await compOff.scanMonthCompOff({ month: 7, year: 2026 });
  assert.strictEqual(s.halfCompOff, 1);
  assert.strictEqual(Number(store[0].hr_days), 0.5);
});
test('3. Holiday + 5:01 → 0.5', async () => {
  setup({ attendance: [att(HOLIDAY, { eff: 5 + 1 / 60 })] });
  const s = await compOff.scanMonthCompOff({ month: 7, year: 2026 });
  assert.strictEqual(s.halfCompOff, 1);
  assert.strictEqual(Number(store[0].hr_days), 0.5);
});
test('4. Holiday + 7:59 → 0.5', async () => {
  setup({ attendance: [att(HOLIDAY, { eff: 7 + 59 / 60 })] });
  await compOff.scanMonthCompOff({ month: 7, year: 2026 });
  assert.strictEqual(Number(store[0].hr_days), 0.5);
});
test('5. Holiday + 8:00 → 1', async () => {
  setup({ attendance: [att(HOLIDAY, { eff: 8 })] });
  const s = await compOff.scanMonthCompOff({ month: 7, year: 2026 });
  assert.strictEqual(s.fullCompOff, 1);
  assert.strictEqual(Number(store[0].hr_days), 1);
});
test('6. Weekly-Off + 9h → 1', async () => {
  setup({ attendance: [att(WEEKLY_OFF, { eff: 9 })], holidays: [] });
  const s = await compOff.scanMonthCompOff({ month: 7, year: 2026 });
  assert.strictEqual(s.fullCompOff, 1);
  assert.strictEqual(store[0].hr_reason, 'Worked on weekly-off');
});

// ── monthly accumulation (no cap) ──
test('7. multiple eligible dates accumulate (1 + 0.5 + 1 = 2.5)', async () => {
  setup({
    holidays: [HOLIDAY, '2026-07-16'],
    attendance: [att(HOLIDAY, { eff: 8 }), att(WEEKLY_OFF, { eff: 6 }), att('2026-07-16', { eff: 9 })],
  });
  await compOff.scanMonthCompOff({ month: 7, year: 2026 });
  const total = store.reduce((t, r) => t + Number(r.hr_days), 0);
  assert.strictEqual(total, 2.5);
});

// ── idempotency ──
test('8. running the month twice creates NO duplicates', async () => {
  setup({ attendance: [att(HOLIDAY, { eff: 8 })] });
  await compOff.scanMonthCompOff({ month: 7, year: 2026 });
  const afterFirst = store.length;
  const s2 = await compOff.scanMonthCompOff({ month: 7, year: 2026 });
  assert.strictEqual(store.length, afterFirst, 'no new records on the second run');
  assert.strictEqual(s2.duplicatesSkipped, 1);
});
test('9. an existing comp-off for the same employee/date is skipped', async () => {
  setup({ attendance: [att(HOLIDAY, { eff: 8 })], existingComp: [{ hr_employeeid: EMP, hr_workeddate: HOLIDAY, hr_status: 'pending' }] });
  const s = await compOff.scanMonthCompOff({ month: 7, year: 2026 });
  assert.strictEqual(s.duplicatesSkipped, 1);
  assert.strictEqual(s.fullCompOff, 0);
});

// ── invalid attendance ──
test('10. missing punch (no in-time) → no comp-off', async () => {
  setup({ attendance: [att(HOLIDAY, { hr_intime: '', eff: 8 })] });
  const s = await compOff.scanMonthCompOff({ month: 7, year: 2026 });
  assert.strictEqual(store.length, 0);
  assert.strictEqual(s.invalidSkipped, 1);
});
test('11. absent status → no comp-off', async () => {
  setup({ attendance: [att(HOLIDAY, { hr_status: ABSENT, hr_intime: '', eff: 0 })] });
  await compOff.scanMonthCompOff({ month: 7, year: 2026 });
  assert.strictEqual(store.length, 0);
});
test('12. approved leave without work (no in-punch) → no comp-off', async () => {
  // Leave-only day → no attendance record with a real punch → not eligible.
  setup({ attendance: [att(HOLIDAY, { hr_intime: '', hr_status: ABSENT })] });
  assert.strictEqual((await compOff.scanMonthCompOff({ month: 7, year: 2026 })).fullCompOff, 0);
});

// ── employee eligibility ──
test('13. inactive employee (not in the active set) → no comp-off', async () => {
  setup({ employees: [], attendance: [att(HOLIDAY, { eff: 8 })] });   // active-employee query returns none
  const s = await compOff.scanMonthCompOff({ month: 7, year: 2026 });
  assert.strictEqual(store.length, 0);
  assert.strictEqual(s.invalidSkipped, 1);
});
test('14. employee not employed on the date (joined later) → no comp-off', async () => {
  setup({ employees: [{ ...activeEmp, hr_joiningdate: '2026-08-01' }], attendance: [att(HOLIDAY, { eff: 8 })] });
  assert.strictEqual((await compOff.scanMonthCompOff({ month: 7, year: 2026 })).fullCompOff, 0);
});

// ── month isolation ──
test('15. a July scan does NOT process an August attendance row', async () => {
  setup({ holidays: [HOLIDAY, '2026-08-15'], attendance: [att(HOLIDAY, { eff: 8 }), att('2026-08-15', { eff: 8 })] });
  await compOff.scanMonthCompOff({ month: 7, year: 2026 });
  assert.strictEqual(store.length, 1);
  assert.strictEqual(String(store[0].hr_workeddate).slice(0, 7), '2026-07');
});

// ── generated record shape ──
test('16. generated record is PENDING auto, traceable to the worked date', async () => {
  setup({ attendance: [att(HOLIDAY, { eff: 8.25 })] });
  await compOff.scanMonthCompOff({ month: 7, year: 2026 });
  const r = store[0];
  assert.strictEqual(r.hr_status, 'pending');
  assert.strictEqual(r.hr_type, 'auto');
  assert.strictEqual(r.hr_createdby, 'System (auto)');
  assert.strictEqual(String(r.hr_workeddate).slice(0, 10), HOLIDAY);
  assert.strictEqual(String(r.hr_year), '2026');
  assert.strictEqual(Number(r.hr_workedhours), 8.25);
});

// ── 17. approval credits the ledger (existing bridgeEarned path) ──
test('17. approving a pending comp-off writes a comp_off_earned ledger entry', async () => {
  const origById = d365.getById, origUpd = d365.update, origLedger = leaveEngine.addLedgerEntry;
  const pending = { hr_compoffid: 'x1', hr_employeeid: EMP, hr_employeename: 'V', hr_year: '2026', hr_days: '1', hr_workeddate: HOLIDAY, hr_status: 'pending', hr_ledgerlinked: 'false' };
  const ledgerCalls = [];
  d365.getById = async () => pending;
  d365.update = async () => ({});
  leaveEngine.addLedgerEntry = async (e) => { ledgerCalls.push(e); };
  try {
    await compOff.approve('x1', { name: 'HR' });
    assert.strictEqual(ledgerCalls.length, 1);
    assert.strictEqual(ledgerCalls[0].kind, 'comp_off_earned');
    assert.strictEqual(Number(ledgerCalls[0].days), 1);
  } finally { d365.getById = origById; d365.update = origUpd; leaveEngine.addLedgerEntry = origLedger; }
});

// ── 18. an approved Comp-Off leave is PAID (payable) in payroll ──
test('18. Comp Off (stored as Earned Leave → other) counts as PAID, never LOP', () => {
  assert.strictEqual(leaveEngine.categoryOfType('Earned Leave'), 'other');
  const split = leaveEngine.computeMonthSplit({ leaves: [{ category: 'other', days: 1, month: 7 }], policy: { casual: 12, sick: 6 }, month: 7 });
  assert.strictEqual(split.paidLeaveDays, 1);
  assert.strictEqual(split.lopLeaveDays, 0);
});
