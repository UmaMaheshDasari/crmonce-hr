/**
 * Monthly hour balance — SIMPLE model (independent per month, NO carry-forward).
 *
 *   Base Required   = Working Days × 9
 *   Final Required  = Base − Approved Leave Hours − (Absent Days × 9)   [absent → separate LOP]
 *   Total Worked    = actual punch hours of Present + Half days (half NOT forced to 5h)
 *   Difference      = Total Worked − Final Required
 *   Shortage        = max(0, −Difference)  → hours × hourly rate (no LOP conversion)
 * No Effective-Hours, no Overtime, no carry-forward feed this calc.
 */
process.env.NODE_ENV = 'test';
process.env.AZURE_CLIENT_ID = process.env.AZURE_CLIENT_ID || 'x';
process.env.AZURE_CLIENT_SECRET = process.env.AZURE_CLIENT_SECRET || 'x';
process.env.AZURE_TENANT_ID = process.env.AZURE_TENANT_ID || 'x';

const { test } = require('node:test');
const assert = require('node:assert');
const mb = require('../src/services/monthly-balance.service');
const { computeMonthlySummary, buildMonthlyBalance, estimateSalaryDeduction } = mb;

// ── §21 exact case ────────────────────────────────────────────────────
test('§21: 17 WD, 1 approved leave, present 130h + half 10h → final 144, total 140, diff -4', () => {
  const r = computeMonthlySummary({ workingDays: 17, approvedLeaveHours: 9, absentDays: 0, presentWorkedHours: 130, halfWorkedHours: 10 });
  assert.equal(r.baseRequiredHours, 153);        // 17 × 9
  assert.equal(r.approvedLeaveHours, 9);
  assert.equal(r.finalRequiredHours, 144);       // 153 − 9
  assert.equal(r.totalWorkedHours, 140);         // 130 + 10
  assert.equal(r.monthlyDifference, -4);         // 140 − 144
  assert.equal(r.shortageHours, 4);
});

test('§21: positive difference — total 148.27h → +4.27, no shortage', () => {
  const r = computeMonthlySummary({ workingDays: 17, approvedLeaveHours: 9, presentWorkedHours: 138.27, halfWorkedHours: 10 });
  assert.equal(r.finalRequiredHours, 144);
  assert.equal(r.totalWorkedHours, 148.27);
  assert.equal(r.monthlyDifference, 4.27);
  assert.equal(r.shortageHours, 0);
});

// ── Half-worked day still REQUIRES a full 9h (only credits actual hours) ──
test('half-worked day requires 9h, credits actual: 1 WD half 6h → diff -3', () => {
  const r = computeMonthlySummary({ workingDays: 1, halfWorkedHours: 6 });
  assert.equal(r.baseRequiredHours, 9);
  assert.equal(r.finalRequiredHours, 9);         // not reduced to 5
  assert.equal(r.totalWorkedHours, 6);
  assert.equal(r.monthlyDifference, -3);         // 6 − 9 (harsher than the old status-based 5h)
});

// ── Approved leave reduces required, never deducts ────────────────────
test('approved full-day leave removes 9h from required (worked to spec → 0)', () => {
  // 17 WD, 1 leave, 16 present days worked exactly 9h each = 144.
  const r = computeMonthlySummary({ workingDays: 17, approvedLeaveHours: 9, presentWorkedHours: 144 });
  assert.equal(r.finalRequiredHours, 144);
  assert.equal(r.monthlyDifference, 0);
  assert.equal(r.shortageHours, 0);
});

// ── Absent excluded from the hourly requirement (separate LOP) ─────────
test('absent days are removed from Final Required (handled as day-based LOP)', () => {
  const r = computeMonthlySummary({ workingDays: 17, approvedLeaveHours: 9, absentDays: 2, presentWorkedHours: 126 });
  assert.equal(r.baseRequiredHours, 153);
  assert.equal(r.finalRequiredHours, 126);       // 153 − 9 leave − 18 absent
  assert.equal(r.monthlyDifference, 0);          // 126 worked − 126 required → absent NOT an hourly shortage
  assert.equal(r.shortageHours, 0);
});

// ── Overtime never affects the difference (no overtime input at all) ──
test('overtime does not affect the monthly difference', () => {
  // A day worked 12h counts its full 12h as worked; required is a flat 9 — no OT term.
  const r = computeMonthlySummary({ workingDays: 1, presentWorkedHours: 12 });
  assert.equal(r.monthlyDifference, 3);          // 12 − 9, purely worked − required
  assert.ok(!('overtime' in r) && !('effectiveHours' in r) && !('carryForward' in r));
});

// ── Salary deduction = shortage × hourly rate ─────────────────────────
test('estimateSalaryDeduction: shortage 4.5h × ₹200/h = ₹900', async () => {
  const salaryStructure = require('../src/services/salary-structure.service');
  const payrollSettings = require('../src/services/payroll-settings.service');
  const { rangeCounts } = require('../src/services/attendance-summary.util');
  const { perDaySalary } = require('../src/services/payroll-engine.calc');
  const orig = { gs: salaryStructure.getActiveStructure, ps: payrollSettings.getResolved };
  salaryStructure.getActiveStructure = async () => ({ gross: 26000 });
  payrollSettings.getResolved = async () => ({ lopBasis: 'salary_working_days', workingHoursPerDay: 8 });
  try {
    assert.deepEqual(await estimateSalaryDeduction({ employeeId: 'e', year: 2026, month: 8, shortageHours: 0 }), { shortageHours: 0, hourlyRate: 0, salaryDeduction: 0 });
    const wd = rangeCounts('2026-08-01', '2026-08-31').working;
    const hourly = Math.round((perDaySalary(26000, { lopBasis: 'salary_working_days', salaryWorkingDays: wd, calendarDays: 31 }) / 8) * 100) / 100;
    const r = await estimateSalaryDeduction({ employeeId: 'e', year: 2026, month: 8, shortageHours: 4.5 });
    assert.equal(r.hourlyRate, hourly);
    assert.equal(r.salaryDeduction, Math.round(4.5 * hourly));
  } finally { salaryStructure.getActiveStructure = orig.gs; payrollSettings.getResolved = orig.ps; }
});

// ── Builder integration (I/O stubbed) — Aug 2026, real punch hours ────
test('buildMonthlyBalance: Aug 2026 — working days, present/half punch hours, leave, absent', async () => {
  const d365 = require('../src/services/d365.service');
  const attnCfg = require('../src/services/attendance.config');
  const shiftHistory = require('../src/services/shift-history.service');
  const payrollSettings = require('../src/services/payroll-settings.service');
  const time = require('../src/services/time.util');
  const EMP = 'emp-1';
  const recs = [
    { hr_hrattendanceid: 'a1', hr_date: '2026-08-29', hr_allpunches: JSON.stringify(['09:00', '19:00']), hr_punchcount: 2 },   // 10h present
    { hr_hrattendanceid: 'a2', hr_date: '2026-08-30', hr_allpunches: JSON.stringify(['09:00', '15:00']), hr_punchcount: 2 },   // 6h half
  ];
  const orig = { gl: d365.getList, woff: attnCfg.weekOffDays, sr: shiftHistory.shiftResolverFor, ps: payrollSettings.getResolved, ds: time.istDateStr };
  attnCfg.weekOffDays = [];
  attnCfg.setDynamicHolidays(['2026-08-28']);
  time.istDateStr = () => '2026-09-15';   // month complete
  payrollSettings.getResolved = async () => ({ lateLogin: { graceMinutes: 15 } });
  shiftHistory.shiftResolverFor = async () => ({ forDate: () => ({ name: 'General', start: '09:00', end: '18:00', durationHours: 9, isNight: false, grace: 5 }) });
  d365.getList = async (entity, opts) => {
    if (entity === d365.constructor.entities.leave) return { data: [{ hr_fromdate: '2026-08-27', hr_todate: '2026-08-27', hr_status: 123140001 }] };
    if (opts && opts.top === 1) return { data: [{ hr_date: '2026-08-27' }] };
    return { data: recs };
  };
  try {
    const r = await buildMonthlyBalance({ employeeId: EMP, year: 2026, month: 8 });
    // Window Aug 27–31; 28 is a holiday (excluded). Working days: 27(leave)+29(present)+30(half)+31(absent) = 4.
    assert.equal(r.workingDays, 4);
    assert.equal(r.approvedLeaveDays, 1);
    assert.equal(r.approvedLeaveHours, 9);
    assert.equal(r.presentDays, 1);
    assert.equal(r.presentWorkedHours, 10);
    assert.equal(r.halfDays, 1);
    assert.equal(r.halfWorkedHours, 6);
    assert.equal(r.absentDays, 1);
    assert.equal(r.baseRequiredHours, 36);      // 4 × 9
    assert.equal(r.finalRequiredHours, 18);     // 36 − 9 leave − 9 absent
    assert.equal(r.totalWorkedHours, 16);       // 10 + 6
    assert.equal(r.monthlyDifference, -2);      // 16 − 18
    assert.equal(r.shortageHours, 2);
    assert.ok(!('effectiveHours' in r) && !('overtime' in r) && !('carryForward' in r));
  } finally {
    d365.getList = orig.gl; attnCfg.weekOffDays = orig.woff; shiftHistory.shiftResolverFor = orig.sr; payrollSettings.getResolved = orig.ps; time.istDateStr = orig.ds;
    attnCfg.setDynamicHolidays([]);
  }
});
