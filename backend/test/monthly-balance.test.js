/**
 * Monthly hour balance — INDEPENDENT per month, NO carry-forward.
 *
 *   Daily balance   = effective worked − daily expected (Full 9h / Half 5h)
 *   Monthly balance = Σ daily balance  (= effective − required)  — this month only
 *   Approved leave / holiday / weekly-off → expected 0 (no shortage)
 *   Overtime raises the balance via (worked − expected); NEVER re-added, NEVER carried
 *   Negative balance → shortage hours (exact); deducted as hours × existing hourly rate
 * No carry-forward, no LOP days, no 'incomplete'. Historical dates use the date's shift.
 */
process.env.NODE_ENV = 'test';
process.env.AZURE_CLIENT_ID = process.env.AZURE_CLIENT_ID || 'x';
process.env.AZURE_CLIENT_SECRET = process.env.AZURE_CLIENT_SECRET || 'x';
process.env.AZURE_TENANT_ID = process.env.AZURE_TENANT_ID || 'x';

const { test } = require('node:test');
const assert = require('node:assert');
const mb = require('../src/services/monthly-balance.service');
const { rollupMonthlyBalance, buildMonthlyBalance, estimateSalaryDeduction } = mb;

// ── Daily Full/Half examples (spec 1–4) via single-day months ─────────
test('1. 10h Full Day → expected 9, balance +1', () => {
  const r = rollupMonthlyBalance([{ worked: 10, expected: 9 }]);
  assert.equal(r.monthlyBalance, 1);
});
test('2. 7h Full Day → expected 9, balance -2', () => {
  const r = rollupMonthlyBalance([{ worked: 7, expected: 9 }]);
  assert.equal(r.monthlyBalance, -2);
  assert.equal(r.shortageHours, 2);
});
test('3. 6h Half Day → expected 5, balance +1', () => {
  assert.equal(rollupMonthlyBalance([{ worked: 6, expected: 5 }]).monthlyBalance, 1);
});
test('4. 5h Half Day → expected 5, balance 0', () => {
  const r = rollupMonthlyBalance([{ worked: 5, expected: 5 }]);
  assert.equal(r.monthlyBalance, 0);
  assert.equal(r.shortageHours, 0);
});

// ── Monthly examples (spec 5–6) ───────────────────────────────────────
test('5. 10 + 10 + 7 → worked 27, required 27, balance 0', () => {
  const r = rollupMonthlyBalance([{ worked: 10, expected: 9 }, { worked: 10, expected: 9 }, { worked: 7, expected: 9 }]);
  assert.equal(r.effectiveHours, 27);
  assert.equal(r.requiredHours, 27);
  assert.equal(r.monthlyBalance, 0);
  assert.equal(r.shortageHours, 0);
});
test('6. 6 + 7 → worked 13, required 14, balance -1', () => {
  const r = rollupMonthlyBalance([{ worked: 6, expected: 5 }, { worked: 7, expected: 9 }]);
  assert.equal(r.requiredHours, 14);
  assert.equal(r.effectiveHours, 13);
  assert.equal(r.monthlyBalance, -1);
  assert.equal(r.shortageHours, 1);
});

// ── Approved leave (spec 7–8) ─────────────────────────────────────────
test('7. approved full-day leave removes 9h requirement → no shortage', () => {
  // 21 full days worked exactly to spec + 1 leave day (expected 0).
  const r = rollupMonthlyBalance([
    { worked: 9, expected: 9 }, { worked: 9, expected: 9 },
    { type: 'leave', worked: 0, expected: 0, leaveHours: 9 },
    { worked: 9, expected: 9 },
  ]);
  assert.equal(r.approvedLeaveHours, 9);
  assert.equal(r.requiredHours, 27);        // leave day contributes 0, not 9
  assert.equal(r.monthlyBalance, 0);
  assert.equal(r.shortageHours, 0);
});
test('8. approved leave + overwork → positive, no deduction', () => {
  const r = rollupMonthlyBalance([{ worked: 12, expected: 9 }, { type: 'leave', worked: 0, expected: 0, leaveHours: 9 }]);
  assert.equal(r.monthlyBalance, 3);
  assert.equal(r.shortageHours, 0);
});

// ── Late Login (spec 9): effective hours already exclude nothing extra ─
test('9. late-but-8h day counts full effective hours (late never deducts)', () => {
  const r = rollupMonthlyBalance([{ worked: 8, expected: 9 }]);   // arrived late but worked 8h effective
  assert.equal(r.effectiveHours, 8);   // late minutes are NOT subtracted here
  assert.equal(r.monthlyBalance, -1);
});

// ── NO carry-forward (spec 10, 11, 12, 19) ────────────────────────────
test('10/11/12. result carries NO forward/backward balance fields', () => {
  const r = rollupMonthlyBalance([{ worked: 15, expected: 9, overtime: 6 }]);   // +6, incl overtime
  assert.equal(r.monthlyBalance, 6);
  assert.equal(r.overtime, 6);
  assert.ok(!('carryForward' in r));
  assert.ok(!('previousCarryForward' in r));
  assert.ok(!('lopDays' in r));           // no LOP-days mechanism
  assert.ok(!('runningBalance' in (r.days[0] || {})));   // no cumulative running balance
});
test('overtime is not double-counted (balance = worked − expected only)', () => {
  const r = rollupMonthlyBalance([{ worked: 14, expected: 9, overtime: 5 }]);
  assert.equal(r.monthlyBalance, 5);      // 14 − 9, NOT 14 − 9 + 5
});

// ── Exact-hour shortage (spec 13–16) ──────────────────────────────────
for (const [worked, expected, shortage] of [[8, 9, 1], [4, 9, 5], [2, 9, 7], [10.5 - 9 + 0, 0, 0]]) {
  if (shortage === 0) continue;
  test(`shortage: ${expected - worked}h → shortageHours ${shortage}`, () => {
    assert.equal(rollupMonthlyBalance([{ worked, expected }]).shortageHours, shortage);
  });
}
test('16. -10h30m balance → shortageHours 10.5', () => {
  const r = rollupMonthlyBalance([{ worked: 0, expected: 10.5 }]);
  assert.equal(r.monthlyBalance, -10.5);
  assert.equal(r.shortageHours, 10.5);
});

// ── Salary deduction = exact hours × existing hourly rate ─────────────
test('estimateSalaryDeduction: exact hours × existing hourly rate', async () => {
  const salaryStructure = require('../src/services/salary-structure.service');
  const payrollSettings = require('../src/services/payroll-settings.service');
  const { perDaySalary } = require('../src/services/payroll-engine.calc');
  const { rangeCounts } = require('../src/services/attendance-summary.util');
  const orig = { gs: salaryStructure.getActiveStructure, ps: payrollSettings.getResolved };
  salaryStructure.getActiveStructure = async () => ({ gross: 26000 });
  payrollSettings.getResolved = async () => ({ lopBasis: 'salary_working_days', workingHoursPerDay: 8 });
  try {
    // Zero / positive → no deduction
    assert.deepEqual(await estimateSalaryDeduction({ employeeId: 'e', year: 2026, month: 8, shortageHours: 0 }), { shortageHours: 0, hourlyRate: 0, salaryDeduction: 0 });
    // 4.5h shortage → 4.5 × hourly rate
    const wd = rangeCounts('2026-08-01', '2026-08-31').working;
    const perDay = perDaySalary(26000, { lopBasis: 'salary_working_days', salaryWorkingDays: wd, calendarDays: 31 });
    const hourly = Math.round((perDay / 8) * 100) / 100;
    const r = await estimateSalaryDeduction({ employeeId: 'e', year: 2026, month: 8, shortageHours: 4.5 });
    assert.equal(r.hourlyRate, hourly);
    assert.equal(r.salaryDeduction, Math.round(4.5 * hourly));
  } finally { salaryStructure.getActiveStructure = orig.gs; payrollSettings.getResolved = orig.ps; }
});

// ── Builder integration (I/O stubbed) — Aug 2026, no carry fields, no incomplete ──
test('buildMonthlyBalance: Aug 2026 — historical shift, leave/holiday/absent, no carry, no incomplete', async () => {
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
  time.istDateStr = () => '2026-09-15';   // month complete; no today-pending
  payrollSettings.getResolved = async () => ({ lateLogin: { graceMinutes: 15 } });
  shiftHistory.shiftResolverFor = async () => ({ forDate: () => ({ name: 'General', start: '09:00', end: '18:00', durationHours: 9, isNight: false, grace: 5 }) });
  d365.getList = async (entity, opts) => {
    if (entity === d365.constructor.entities.leave) return { data: [{ hr_fromdate: '2026-08-27', hr_todate: '2026-08-27', hr_status: 123140001 }] };
    if (opts && opts.top === 1) return { data: [{ hr_date: '2026-08-27' }] };
    return { data: recs };
  };
  try {
    const r = await buildMonthlyBalance({ employeeId: EMP, year: 2026, month: 8 });
    const byDate = new Map(r.days.map((d) => [d.date, d]));
    assert.equal(byDate.get('2026-08-27').type, 'leave');        // approved leave → expected 0
    assert.equal(byDate.get('2026-08-27').expected, 0);
    assert.equal(byDate.get('2026-08-28').type, 'holiday');      // holiday → expected 0
    assert.equal(byDate.get('2026-08-29').worked, 10);
    assert.equal(byDate.get('2026-08-29').expected, 9);
    assert.equal(byDate.get('2026-08-30').worked, 6);
    assert.equal(byDate.get('2026-08-30').expected, 5);
    assert.equal(byDate.has('2026-08-31'), false);   // ABSENT day is EXCLUDED from the hour balance (day-LOP handles it)
    // Attended/leave/holiday only: required 0+0+9+5 = 14; effective 16; balance +2; shortage 0
    assert.equal(r.requiredHours, 14);
    assert.equal(r.effectiveHours, 16);
    assert.equal(r.approvedLeaveHours, 9);
    assert.equal(r.monthlyBalance, 2);
    assert.equal(r.shortageHours, 0);
    assert.equal(r.absentDays, 1);       // 31st absent → counted separately (day-based LOP)
    assert.equal(r.presentDays, 1);
    assert.equal(r.halfDays, 1);
    assert.equal(r.approvedLeaveDays, 1);
    assert.ok(!('carryForward' in r) && !('lopDays' in r) && !('previousCarryForward' in r));
    assert.ok(r.days.every((d) => d.type !== 'incomplete'));
  } finally {
    d365.getList = orig.gl; attnCfg.weekOffDays = orig.woff; shiftHistory.shiftResolverFor = orig.sr; payrollSettings.getResolved = orig.ps; time.istDateStr = orig.ds;
    attnCfg.setDynamicHolidays([]);
  }
});
