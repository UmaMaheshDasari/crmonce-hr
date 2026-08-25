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
const round2 = (n) => Math.round(n * 100) / 100;

// ── §21 exact case ────────────────────────────────────────────────────
test('§21: 17 WD, 1 approved leave, present 140h → final 144, total 140, diff -4', () => {
  const r = computeMonthlySummary({ workingDays: 17, approvedLeaveHours: 9, absentDays: 0, presentWorkedHours: 140 });
  assert.equal(r.baseRequiredHours, 153);        // 17 × 9
  assert.equal(r.approvedLeaveHours, 9);
  assert.equal(r.finalRequiredHours, 144);       // 153 − 9
  assert.equal(r.totalWorkedHours, 140);
  assert.equal(r.monthlyDifference, -4);         // 140 − 144
  assert.equal(r.shortageHours, 4);
});

test('§21: positive difference — total 148.27h → +4.27, no shortage', () => {
  const r = computeMonthlySummary({ workingDays: 17, approvedLeaveHours: 9, presentWorkedHours: 148.27 });
  assert.equal(r.finalRequiredHours, 144);
  assert.equal(r.totalWorkedHours, 148.27);
  assert.equal(r.monthlyDifference, 4.27);
  assert.equal(r.shortageHours, 0);
});

// ── §7: the Half Day LABEL never reduces required by itself (no adjustment) ──
test('§26 TEST 1: 1 WD, worked 6h49m, NO adjustment → −2h11m (label is irrelevant)', () => {
  const r = computeMonthlySummary({ workingDays: 1, presentWorkedHours: round2(6 + 49 / 60) });
  assert.equal(r.baseRequiredHours, 9);
  assert.equal(r.approvedAdjustmentHours, 0);
  assert.equal(r.finalRequiredHours, 9);          // 9h, NOT 5h — the half-day label doesn't reduce it
  assert.equal(r.monthlyDifference, round2(6 + 49 / 60 - 9));   // ≈ −2h11m
  assert.equal(r.shortageHours, round2(9 - (6 + 49 / 60)));
});

// ── §2/§4: an APPROVED HOUR ADJUSTMENT reduces ONLY that day's required hours ──
test('§26 TEST 2: 9h req, 3h approved adjustment, worked 6h49m → +49m, no shortage', () => {
  const r = computeMonthlySummary({ workingDays: 1, approvedAdjustmentHours: 3, presentWorkedHours: round2(6 + 49 / 60) });
  assert.equal(r.approvedAdjustmentHours, 3);
  assert.equal(r.finalRequiredHours, 6);          // 9 − 3 adjustment → adjusted requirement 6h
  assert.equal(r.monthlyDifference, round2(6 + 49 / 60 - 6));   // +0.82h ≈ +49m
  assert.equal(r.shortageHours, 0);               // approved adjustment → NO deduction
});

test('§26 TEST 3 / §20 no double-count: 9h req, 3h adjustment, worked 7h → +1h (not 7−3−6)', () => {
  const r = computeMonthlySummary({ workingDays: 1, approvedAdjustmentHours: 3, presentWorkedHours: 7 });
  assert.equal(r.finalRequiredHours, 6);          // adjustment reduces REQUIRED only, never worked
  assert.equal(r.totalWorkedHours, 7);            // full actual punch hours retained
  assert.equal(r.monthlyDifference, 1);           // 7 − 6
});

test('adjustment stacks with leave & absent in Final Required (§19)', () => {
  // 17 WD, 1 leave (9h), 3h total approved adjustments, 1 absent (9h).
  const r = computeMonthlySummary({ workingDays: 17, approvedLeaveHours: 9, approvedAdjustmentHours: 3, absentDays: 1, presentWorkedHours: 133 });
  assert.equal(r.baseRequiredHours, 153);         // 17 × 9
  assert.equal(r.finalRequiredHours, 132);        // 153 − 9 leave − 3 adjustment − 9 absent
  assert.equal(r.monthlyDifference, 1);           // 133 − 132
  assert.equal(r.shortageHours, 0);
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
  const orig = { gl: d365.getList, glo: d365.getListOptional, woff: attnCfg.weekOffDays, sr: shiftHistory.shiftResolverFor, ps: payrollSettings.getResolved, ds: time.istDateStr };
  attnCfg.weekOffDays = [];
  attnCfg.setDynamicHolidays(['2026-08-28']);
  time.istDateStr = () => '2026-09-15';   // month complete
  payrollSettings.getResolved = async () => ({ lateLogin: { graceMinutes: 15 } });
  shiftHistory.shiftResolverFor = async () => ({ forDate: () => ({ name: 'General', start: '09:00', end: '18:00', durationHours: 9, isNight: false, grace: 5 }) });
  d365.getListOptional = async () => ({ data: [] });   // no approved hour adjustments
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
    assert.equal(r.approvedAdjustmentHours, 0);
    assert.equal(r.baseRequiredHours, 36);      // 4 × 9
    assert.equal(r.finalRequiredHours, 18);     // 36 − 9 leave − 9 absent (no half-credit, no adjustment)
    assert.equal(r.totalWorkedHours, 16);       // 10 + 6
    assert.equal(r.monthlyDifference, -2);      // 16 − 18 (half day shorts when unadjusted)
    assert.equal(r.shortageHours, 2);
    assert.ok(!('effectiveHours' in r) && !('overtime' in r) && !('carryForward' in r));
  } finally {
    d365.getList = orig.gl; d365.getListOptional = orig.glo; attnCfg.weekOffDays = orig.woff; shiftHistory.shiftResolverFor = orig.sr; payrollSettings.getResolved = orig.ps; time.istDateStr = orig.ds;
    attnCfg.setDynamicHolidays([]);
  }
});

// ── §30: approved hour adjustment offsets a half-day so there is NO shortage ──
test('buildMonthlyBalance: 6h49m half day + approved 3h adjustment → +49m, no deduction', async () => {
  const d365 = require('../src/services/d365.service');
  const attnCfg = require('../src/services/attendance.config');
  const shiftHistory = require('../src/services/shift-history.service');
  const payrollSettings = require('../src/services/payroll-settings.service');
  const time = require('../src/services/time.util');
  const EMP = 'emp-3';
  const orig = { gl: d365.getList, glo: d365.getListOptional, woff: attnCfg.weekOffDays, sr: shiftHistory.shiftResolverFor, ps: payrollSettings.getResolved, ds: time.istDateStr, hh: time.istHHMM };
  attnCfg.weekOffDays = []; attnCfg.setDynamicHolidays([]);
  time.istDateStr = () => '2026-08-26';   // day after; Aug 25 is complete
  time.istHHMM = () => '08:00';           // before today's shift start+grace → Aug 26 stays pending
  payrollSettings.getResolved = async () => ({ lateLogin: { graceMinutes: 15 } });
  shiftHistory.shiftResolverFor = async () => ({ forDate: () => ({ name: 'General', start: '09:00', end: '18:00', durationHours: 9, isNight: false, grace: 5 }) });
  // Approved 3h hour-adjustment for Aug 25 (via the Attendance Request approval system).
  d365.getListOptional = async () => ({ data: [{ hr_attendancedate: '2026-08-25', hr_punchtype: 'hour_adjustment', hr_status: 'approved', hr_adjustmenthours: '3' }] });
  d365.getList = async (entity, opts) => {
    if (entity === d365.constructor.entities.leave) return { data: [] };
    if (opts && opts.top === 1) return { data: [{ hr_date: '2026-08-25' }] };   // first attendance = Aug 25 → window starts there
    // Aug 25: 09:00–13:00, 13:49–16:38 → 4h + 2h49m = 6h49m worked (a half day by label).
    return { data: [{ hr_hrattendanceid: 'c1', hr_date: '2026-08-25', hr_allpunches: JSON.stringify(['09:00', '13:00', '13:49', '16:38']), hr_punchcount: 4 }] };
  };
  try {
    const r = await buildMonthlyBalance({ employeeId: EMP, year: 2026, month: 8 });
    assert.equal(r.workingDays, 1);
    assert.equal(r.halfDays, 1);                    // labelled Half Day (6h49m < 7h)
    assert.equal(r.approvedAdjustmentHours, 3);
    assert.equal(r.adjustedDays, 1);
    assert.equal(r.baseRequiredHours, 9);
    assert.equal(r.finalRequiredHours, 6);          // 9 − 3 approved adjustment
    assert.equal(r.totalWorkedHours, 6.81);         // 6h49m actual punch hours (span 7.63 − 0.82 break)
    assert.equal(r.monthlyDifference, 0.81);        // 6.81 − 6 → +49m surplus (displayed)
    assert.equal(r.shortageHours, 0);               // approved adjustment → NO deduction
  } finally {
    d365.getList = orig.gl; d365.getListOptional = orig.glo; attnCfg.weekOffDays = orig.woff; shiftHistory.shiftResolverFor = orig.sr; payrollSettings.getResolved = orig.ps; time.istDateStr = orig.ds; time.istHHMM = orig.hh;
  }
});

// ── Open session TODAY → Pending (not finalized): no working-day, no phantom shortage ──
test('buildMonthlyBalance: an OPEN session today is excluded (pending), no mid-day shortage', async () => {
  const d365 = require('../src/services/d365.service');
  const attnCfg = require('../src/services/attendance.config');
  const shiftHistory = require('../src/services/shift-history.service');
  const payrollSettings = require('../src/services/payroll-settings.service');
  const time = require('../src/services/time.util');
  const EMP = 'emp-2';
  const orig = { gl: d365.getList, woff: attnCfg.weekOffDays, sr: shiftHistory.shiftResolverFor, ps: payrollSettings.getResolved, ds: time.istDateStr, hh: time.istHHMM };
  attnCfg.weekOffDays = [];
  attnCfg.setDynamicHolidays([]);
  time.istDateStr = () => '2026-08-03';   // "today" is Aug 3; open session in progress
  time.istHHMM = () => '12:00';
  payrollSettings.getResolved = async () => ({ lateLogin: { graceMinutes: 15 } });
  shiftHistory.shiftResolverFor = async () => ({ forDate: () => ({ name: 'General', start: '09:00', end: '18:00', durationHours: 9, isNight: false, grace: 5 }) });
  d365.getList = async (entity, opts) => {
    if (entity === d365.constructor.entities.leave) return { data: [] };
    if (opts && opts.top === 1) return { data: [{ hr_date: '2026-08-01' }] };
    return { data: [
      { hr_hrattendanceid: 'b1', hr_date: '2026-08-01', hr_allpunches: JSON.stringify(['09:00', '18:00']), hr_punchcount: 2 },   // present 9h
      { hr_hrattendanceid: 'b2', hr_date: '2026-08-03', hr_allpunches: JSON.stringify(['09:00']), hr_punchcount: 1 },            // OPEN (today, in progress)
    ] };
  };
  try {
    const r = await buildMonthlyBalance({ employeeId: EMP, year: 2026, month: 8 });
    // Aug 1 present (working day). Aug 3 open-today → pending, NOT counted. (Aug 2 is Sunday-excluded? weekOff=[] so it's a working day with no punch → absent.)
    assert.equal(r.presentDays, 1);
    assert.equal(r.presentWorkedHours, 9);
    // The open day today must NOT appear as present/half/absent and must NOT add a working day.
    assert.equal(r.workingDays, 2);              // Aug 1 (present) + Aug 2 (absent); Aug 3 pending/excluded
    assert.equal(r.absentDays, 1);               // Aug 2 only — the open today is NOT absent
    assert.equal(r.totalWorkedHours, 9);         // today's partial/open work does not inflate worked
    assert.equal(r.finalRequiredHours, 9);       // 2×9 − 9 absent = 9 (today not required yet)
    assert.equal(r.monthlyDifference, 0);        // no phantom shortage from the in-progress day
    assert.equal(r.shortageHours, 0);
  } finally {
    d365.getList = orig.gl; attnCfg.weekOffDays = orig.woff; shiftHistory.shiftResolverFor = orig.sr; payrollSettings.getResolved = orig.ps; time.istDateStr = orig.ds; time.istHHMM = orig.hh;
  }
});
