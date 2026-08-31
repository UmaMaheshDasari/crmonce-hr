/**
 * FINAL attendance + OT + LOP business rules.
 *
 * Monthly hour-balance model (unchanged for complete days):
 *   Required = WorkingDays×9 − approvedLeave − approvedAdjustments − Absent×9 − Incomplete×9
 *   Worked   = Present + Half worked hours + INCOMPLETE SURPLUS (worked beyond required)
 *   Pool shortage = max(0, Required − Worked)     ← complete-day shortfall, OT/surplus can cover
 *   LOP hours = Pool shortage + FIRM incomplete shortage (missing-punch, never OT-covered)
 *
 * Key: OT (= real worked hours beyond required) covers COMPLETE-day shortage; a MISSING-PUNCH
 * (incomplete) day's shortfall is FIRM until an Attendance Correction is approved. Long/OT days
 * with a missing punch still contribute their surplus, so overworkers are never broken.
 */
process.env.NODE_ENV = 'test';
process.env.AZURE_CLIENT_ID = process.env.AZURE_CLIENT_ID || 'x';
process.env.AZURE_CLIENT_SECRET = process.env.AZURE_CLIENT_SECRET || 'x';
process.env.AZURE_TENANT_ID = process.env.AZURE_TENANT_ID || 'x';

const { test } = require('node:test');
const assert = require('node:assert');
const { computeMonthlySummary } = require('../src/services/monthly-balance.service');
const { computeSession, classifyStatus } = require('../src/services/attendance.util');
const { computePayrollEngine } = require('../src/services/payroll-engine.calc');

const GEN = 'GEN';
const PAST = '2026-08-27';
// LOP hours for a month (the value payroll consumes as bal.shortageHours).
const lop = (p) => computeMonthlySummary(p).shortageHours;

// ── 1–4, 17, 23: complete-punch shortage vs OT (monthly pool) ──
test('1 — complete + no shortage → LOP 0', () => {
  assert.strictEqual(lop({ workingDays: 1, presentWorkedHours: 9 }), 0);
});
test('2 — complete + 1h shortage + no OT → LOP 1', () => {
  assert.strictEqual(lop({ workingDays: 1, presentWorkedHours: 8 }), 1);
});
test('3 — complete + 1h shortage + 2h OT → OT covers → LOP 0, 1h OT remains', () => {
  const s = computeMonthlySummary({ workingDays: 2, presentWorkedHours: 8 + 11 });   // day1 8h(−1), day2 11h(+2)
  assert.strictEqual(s.shortageHours, 0);
  assert.strictEqual(s.monthlyDifference, 1);   // remaining OT/surplus = 1h
});
test('4 — complete + shortage GREATER than OT → LOP = shortage − OT', () => {
  // day1 6h (−3), day2 10h (+1) → net −2 → LOP 2
  assert.strictEqual(lop({ workingDays: 2, presentWorkedHours: 6 + 10 }), 2);
});
test('17 — remaining OT preserved after shortage adjustment', () => {
  const s = computeMonthlySummary({ workingDays: 2, presentWorkedHours: 8 + 11 });
  assert.strictEqual(s.shortageHours, 0);
  assert.strictEqual(s.monthlyDifference, 1);   // 2h OT − 1h shortage = 1h remaining
});
test('23 — approved leave reduces the requirement (never LOP)', () => {
  // 2 working days, 1 approved-leave (9h), worked 9h on the other → shortage 0
  assert.strictEqual(lop({ workingDays: 2, approvedLeaveHours: 9, presentWorkedHours: 9 }), 0);
});

// ── 5,6,7: late login / early logout are NORMAL shortage (effective hours already reflect them) ──
test('5/6/7 — late/early only lower effective hours (no double subtraction); OT can cover', () => {
  // A late/early day is just fewer worked hours. 8h (late) + 11h (OT) → covered.
  assert.strictEqual(lop({ workingDays: 2, presentWorkedHours: 8 + 11 }), 0);
  // late arrival is measured but never subtracted from effective a 2nd time:
  const c = computeSession(['09:30', '13:00', '14:00', '18:00'], GEN, { date: PAST });   // 30m late
  assert.strictEqual(c.effectiveHours, 7.5);      // span−break only; NOT reduced again by lateness
  assert.ok(c.lateArrivalMin > 0);
  assert.strictEqual(c.status, 'present');
});

// ── 8,14,15,16: classification + multiple pairs + no fabricated OT ──
test('8 — multiple pairs with lunch break → break excluded, effective 8h, PRESENT', () => {
  const c = computeSession(['09:00', '13:00', '14:00', '18:00'], GEN, { date: PAST });
  assert.strictEqual(c.effectiveHours, 8);       // 4h + 4h; 1h lunch excluded (not double-counted)
  assert.strictEqual(c.status, 'present');
});
test('14 — valid (even) Half Day stays Half Day', () => {
  const c = computeSession(['09:00', '13:00'], GEN, { date: PAST });   // 4h completed session
  assert.strictEqual(c.status, 'half_day');
});
test('15 — missing final punch is INCOMPLETE, not Half Day', () => {
  const c = computeSession(['09:00', '13:00', '14:00'], GEN, { date: PAST });   // 4h confirmed, final OUT missing
  assert.strictEqual(c.effectiveHours, 4);
  assert.strictEqual(c.status, 'incomplete');
  assert.notStrictEqual(c.status, 'half_day');
});
test('16 — OT is never fabricated (0 when effective < threshold)', () => {
  const c = computeSession(['09:00', '13:00'], GEN, { date: PAST });   // 4h
  assert.strictEqual(c.overtimeHours, 0);
});

// ── 9–13: missing punch LOP + correction + no OT consumption ──
test('9/10/12 — missing final punch (4h confirmed), no/rejected correction → LOP 5 (required 9 − 4)', () => {
  // one incomplete day: firm shortfall 9−4 = 5, no surplus
  assert.strictEqual(lop({ workingDays: 1, incompleteDays: 1, incompleteFirmShortageHours: 5, incompleteSurplusHours: 0 }), 5);
});
test('11 — correction approved → even punches → normal PRESENT day, OT may cover', () => {
  const c = computeSession(['09:00', '13:00', '14:00', '18:00'], GEN, { date: PAST });   // corrected OUT added
  assert.strictEqual(c.effectiveHours, 8);
  assert.strictEqual(c.status, 'present');       // now a normal complete day
  // 8h (−1) + an 11h OT day → shortage covered
  assert.strictEqual(lop({ workingDays: 2, presentWorkedHours: 8 + 11 }), 0);
});
test('13 — missing-punch shortfall is NOT consumed by OT from other days', () => {
  // incomplete firm 5h + a day with 2h OT surplus → OT must NOT cover the firm 5h
  const s = computeMonthlySummary({ workingDays: 2, presentWorkedHours: 11, incompleteDays: 1, incompleteFirmShortageHours: 5, incompleteSurplusHours: 0 });
  assert.strictEqual(s.poolShortageHours, 0);          // the complete pool is fine (11 ≥ 9)
  assert.strictEqual(s.incompleteFirmShortageHours, 5);
  assert.strictEqual(s.shortageHours, 5);              // firm 5h stands — OT did not cover it
});

// ── The overworker guard: long/OT day WITH a missing punch must NOT create phantom LOP ──
test('overworker — 13.49h incomplete day + a 7h complete day → surplus still covers, LOP 0', () => {
  // incomplete confirmed 13.49 ≥ 9 → firm 0, surplus 4.49 (poolable); day2 7h (−2)
  const s = computeMonthlySummary({ workingDays: 2, presentWorkedHours: 7, incompleteDays: 1, incompleteFirmShortageHours: 0, incompleteSurplusHours: 4.49 });
  assert.strictEqual(s.shortageHours, 0);   // 7 + 4.49 = 11.49 ≥ 9 (day2 required) → covered
});

// ── 18,19: Calculate OT Pay setting gates only the money ──
const OT_BASE = { pf: { applicable: false }, professionalTax: { applicable: false }, incomeTax: { applicable: false }, workingHoursPerDay: 8, overtimeMultiplier: 2, lopBasis: 'salary_working_days' };
test('18 — Calculate OT Pay = No → OT pay ₹0 (hours still tracked/usable)', () => {
  const r = computePayrollEngine({ earnings: { basic: 20800 }, settings: { ...OT_BASE, calculateOtPay: false }, attendance: { salaryWorkingDays: 26, overtimeHours: 8, lopDays: 0 } });
  assert.strictEqual(r.overtimePay, 0);
});
test('19 — Calculate OT Pay = Yes → existing OT payment', () => {
  const r = computePayrollEngine({ earnings: { basic: 20800 }, settings: { ...OT_BASE, calculateOtPay: true }, attendance: { salaryWorkingDays: 26, overtimeHours: 8, lopDays: 0 } });
  assert.strictEqual(r.overtimePay, 1600);
});

// ── 20,21: payroll consumes the SAME shortage the summary reports ──
test('20/21 — LOP hours the summary reports = pool shortage + firm incomplete (single source payroll uses)', () => {
  const s = computeMonthlySummary({ workingDays: 3, presentWorkedHours: 8, incompleteDays: 1, incompleteFirmShortageHours: 5, incompleteSurplusHours: 0 });
  // complete pool: req = (3−1)×9 = 18; worked 8 → poolShortage 10; firm 5 → total 15
  assert.strictEqual(s.poolShortageHours, 10);
  assert.strictEqual(s.shortageHours, 15);
});

// ── 22,24: month isolation + weekend handling are inherent (no incomplete inputs → unchanged) ──
test('22/24 — with no incomplete days the summary is byte-for-byte the previous formula', () => {
  const s = computeMonthlySummary({ workingDays: 22, approvedLeaveHours: 9, absentDays: 1, presentWorkedHours: 9 * 18, halfWorkedHours: 5 });
  // req = 22×9 − 9 − 1×9 = 180; worked = 162 + 5 = 167 → shortage 13
  assert.strictEqual(s.finalRequiredHours, 180);
  assert.strictEqual(s.totalWorkedHours, 167);
  assert.strictEqual(s.shortageHours, 13);
  assert.strictEqual(s.incompleteFirmShortageHours, 0);   // no incomplete inputs → firm 0 → identical to old model
});
