/**
 * Attendance Register / Payroll — Payable Days & LOP.
 *
 * Payable Days must be PAID ATTENDANCE (Present + ½·Half-day + Paid Leave + Comp Off),
 * NOT "= Working Days". LOP = Working − Payable. Gated by the Company Setting
 * `unapprovedAbsenceAsLop` (default ON): ON → an absence with no approved leave is LOP
 * (non-payable, deducted); OFF → only applied LOP is deducted and the absence stays
 * payable (legacy). The Attendance Register and payroll read the SAME `payDays`/`lopDays`.
 *
 * No network: d365.getList (attendance) + leaveEngine (paid/LOP split, balance) are stubbed.
 */
process.env.NODE_ENV = 'test';
process.env.AZURE_CLIENT_ID = process.env.AZURE_CLIENT_ID || 'test-client';
process.env.AZURE_CLIENT_SECRET = process.env.AZURE_CLIENT_SECRET || 'test-secret';
process.env.AZURE_TENANT_ID = process.env.AZURE_TENANT_ID || 'test-tenant';

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const d365 = require('../src/services/d365.service');
const leaveEngine = require('../src/services/leave-engine.service');
const payrollSettings = require('../src/services/payroll-settings.service');
const attnCfg = require('../src/services/attendance.config');
const { rangeCounts } = require('../src/services/attendance-summary.util');
const { computeMonthFacts } = require('../src/modules/payroll/payroll.routes');

const EMP = 'emp-guid-1';
const YEAR = 2026, MONTH = 11;                       // November 2026
const from = `${YEAR}-11-01`, to = `${YEAR}-11-30`;
const pad2 = (n) => String(n).padStart(2, '0');

// Working-day dates in the month, using the SAME week-off/holiday rules the calc uses.
function workingDates() {
  const out = [];
  for (let day = 1; day <= 30; day++) {
    const ds = `${YEAR}-11-${pad2(day)}`;
    const dow = new Date(`${ds}T00:00:00Z`).getUTCDay();
    if (!attnCfg.weekOffDays.includes(dow) && !attnCfg.holidays.includes(ds)) out.push(ds);
  }
  return out;
}

// Settings with the flag ON (default) or OFF.
const settingsWith = (flag) => payrollSettings.resolve({ hr_unapprovedabsenceaslop: flag ? 'true' : 'false' });

// Stub attendance punches (present on the first `present` working days) + the leave split.
let origGetList, origSplit, origBalance, WD;
function stub({ present = 0, paidLeave = 0, lopLeave = 0 } = {}) {
  const dates = workingDates();
  WD = dates.length;
  const rows = dates.slice(0, present).map((ds) => ({ hr_date: ds, hr_intime: '09:30', _hr_hremployee_value: EMP }));
  d365.getList = async (entity) => (entity === d365.constructor.entities.attendance ? { data: rows } : { data: [] });
  leaveEngine.splitMonthLeave = async () => ({ paidLeaveDays: paidLeave, lopLeaveDays: lopLeave });
  leaveEngine.getBalance = async () => ({
    casual: { remaining: 0 }, sick: { remaining: 0 }, earned: { used: 0 }, compOff: { balance: 0 },
  });
}

beforeEach(() => {
  origGetList = d365.getList; origSplit = leaveEngine.splitMonthLeave; origBalance = leaveEngine.getBalance;
  attnCfg.weekOffDays = [0, 6]; attnCfg.setDynamicHolidays([]);
});
afterEach(() => { d365.getList = origGetList; leaveEngine.splitMonthLeave = origSplit; leaveEngine.getBalance = origBalance; });

const facts = (flag) => computeMonthFacts(EMP, MONTH, YEAR, settingsWith(flag));

// ── 1. Full attendance → Payable = Working, LOP = 0 ──
test('1. present every working day → Payable = Working Days, LOP = 0', async () => {
  stub({ present: 999 });                                     // slice caps at WD → present on all working days
  const a = await facts(true);
  assert.strictEqual(a.presentDays, WD);
  assert.strictEqual(a.payDays, WD, 'Payable = Working when fully present');
  assert.strictEqual(a.lopDays, 0);
  assert.strictEqual(a.absentDays, 0);
});

// ── 2. Present 7, no leave (setting ON) → Payable = 7, LOP = Working − 7 ──
test('2. present 7, absent rest, no leave → Payable = 7, LOP = Working − 7 (absence IS LOP)', async () => {
  stub({ present: 7 });
  const a = await facts(true);
  assert.strictEqual(a.payDays, 7, 'Payable = Present (no paid leave)');
  assert.strictEqual(a.lopDays, WD - 7);
  assert.strictEqual(a.payDays + a.lopDays, WD, 'Payable + LOP = Working');
});

// ── 3. Present 7 + Paid Leave 3 → Payable = 10, LOP = Working − 10 ──
test('3. present 7 + paid leave 3 → Payable = 10, LOP = Working − 10', async () => {
  stub({ present: 7, paidLeave: 3 });
  const a = await facts(true);
  assert.strictEqual(a.approvedLeaveDays, 3);
  assert.strictEqual(a.payDays, 10, 'Payable = Present + Paid Leave');
  assert.strictEqual(a.lopDays, WD - 10);
});

// ── 4. Comp Off / paid leave counts as payable (it flows through paidLeaveDays) ──
test('4. present 5 + paid leave 4 (incl. comp off) → Payable = 9', async () => {
  stub({ present: 5, paidLeave: 4 });
  const a = await facts(true);
  assert.strictEqual(a.payDays, 9);
  assert.strictEqual(a.lopDays, WD - 9);
});

// ── 5. Holidays / weekly-offs are excluded from Working Days (never LOP) ──
test('5. weekly-offs + a holiday reduce Working Days, not Payable/LOP', async () => {
  const before = rangeCounts(from, to).working;
  attnCfg.setDynamicHolidays([`${YEAR}-11-03`]);              // add one holiday on a weekday
  const after = rangeCounts(from, to).working;
  assert.ok(after < before, 'a holiday reduces Working Days');
  stub({ present: 999 });                                     // present all remaining working days
  const a = await facts(true);
  assert.strictEqual(a.payDays, a.workingDays, 'still fully paid; holiday never became LOP');
  assert.strictEqual(a.lopDays, 0);
});

// ── 6. Missing punch (a day with no in-time) is not "present" → becomes LOP when ON ──
test('6. a day with no in-time is not counted present (→ LOP when unapproved)', async () => {
  const dates = workingDates(); WD = dates.length;
  const rows = dates.slice(0, 6).map((ds) => ({ hr_date: ds, hr_intime: '09:30', _hr_hremployee_value: EMP }));
  rows.push({ hr_date: dates[6], hr_intime: '', _hr_hremployee_value: EMP });   // missing punch (no in-time)
  d365.getList = async (entity) => (entity === d365.constructor.entities.attendance ? { data: rows } : { data: [] });
  leaveEngine.splitMonthLeave = async () => ({ paidLeaveDays: 0, lopLeaveDays: 0 });
  leaveEngine.getBalance = async () => ({ casual: { remaining: 0 }, sick: { remaining: 0 }, earned: { used: 0 }, compOff: { balance: 0 } });
  const a = await facts(true);
  assert.strictEqual(a.presentDays, 6, 'the missing-punch day is not present');
  assert.strictEqual(a.payDays, 6);
});

// ── 7. Setting OFF (legacy) → only applied LOP is deducted; absence stays payable ──
test('7. setting OFF → Payable = Working − appliedLOP; unapproved absence NOT deducted', async () => {
  stub({ present: 7, paidLeave: 0, lopLeave: 2 });            // 2 days of applied LOP only
  const a = await facts(false);
  assert.strictEqual(a.lopDays, 2, 'only applied LOP deducted');
  assert.strictEqual(a.payDays, WD - 2, 'absence stays payable (legacy behaviour)');
});

// ── 8. Employee with NO attendance → Payable 0, LOP = Working, flagged ──
test('8. no attendance at all → Payable = 0, LOP = Working, attendance_missing warning', async () => {
  stub({ present: 0 });
  const a = await facts(true);
  assert.strictEqual(a.presentDays, 0);
  assert.strictEqual(a.payDays, 0);
  assert.strictEqual(a.lopDays, WD);
  assert.ok(a.warnings.some((w) => w.code === 'attendance_missing'));
});

// ── 9. Register and payroll agree: the SAME payDays/lopDays feed both ──
test('9. payDays + lopDays always reconcile to Working Days (register = payroll source)', async () => {
  for (const flag of [true, false]) {
    stub({ present: 8, paidLeave: 2, lopLeave: 1 });
    const a = await facts(flag);
    assert.strictEqual(a.payDays + a.lopDays, a.workingDays, `reconciles (flag=${flag})`);
    if (flag) assert.strictEqual(a.payDays, a.presentDays + a.halfDays * 0.5 + a.approvedLeaveDays);
  }
});
