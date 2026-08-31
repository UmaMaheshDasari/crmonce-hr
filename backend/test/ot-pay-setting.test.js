/**
 * "Calculate OT Pay" company setting (hr_calculateotpay).
 *
 *   Yes (default) → OT is PAID: overtimePay computed by the existing OT rule and added to gross.
 *   No            → OT pay = ₹0. OT HOURS are still tracked (attendance) and still cover an
 *                   attendance shortage (monthly hour balance) — only the MONEY is suppressed.
 *
 * This setting must NEVER disable OT hour tracking or the shortage adjustment. Existing callers
 * that don't set the flag keep the current behaviour (OT paid).
 */
process.env.NODE_ENV = 'test';
process.env.AZURE_CLIENT_ID = process.env.AZURE_CLIENT_ID || 'x';
process.env.AZURE_CLIENT_SECRET = process.env.AZURE_CLIENT_SECRET || 'x';
process.env.AZURE_TENANT_ID = process.env.AZURE_TENANT_ID || 'x';

const { test } = require('node:test');
const assert = require('node:assert');
const { computePayrollEngine } = require('../src/services/payroll-engine.calc');
const settingsSvc = require('../src/services/payroll-settings.service');

const BASE = { pf: { applicable: false }, professionalTax: { applicable: false }, incomeTax: { applicable: false }, lopBasis: 'salary_working_days', workingHoursPerDay: 8, overtimeMultiplier: 2 };
// basic 20800 / 26 working days → perDay 800 → hourly 100; 8h OT × 100 × 2 = 1600
const run = (calculateOtPay) => computePayrollEngine({
  earnings: { basic: 20800 },
  settings: calculateOtPay === undefined ? { ...BASE } : { ...BASE, calculateOtPay },
  attendance: { salaryWorkingDays: 26, lopDays: 0, overtimeHours: 8 },
});

// ── Engine: the setting gates ONLY the OT pay amount ──
test('Test 1 — Calculate OT Pay = No → OT pay ₹0, OT hours still passed/tracked', () => {
  const r = run(false);
  assert.strictEqual(r.overtimePay, 0, 'OT pay is 0');
  assert.strictEqual(r.gross, 20800, 'gross excludes OT pay');
  // The OT HOURS input (8) is untouched — tracking is not this engine\'s job and is unaffected.
});

test('Test 2 — Calculate OT Pay = Yes → OT pay computed by the existing OT rule', () => {
  const r = run(true);
  assert.strictEqual(r.overtimePay, 1600);   // 8 × 100 × 2
  assert.strictEqual(r.gross, 22400);        // 20800 + 1600
});

test('Test 3 — OT still adjusts eligible shortage when OT pay = No (money-only suppression)', () => {
  // The attendance shortage adjustment lives in the monthly hour balance (worked hours), NOT in
  // this engine and NOT in overtimePay. So every non-OT figure is identical with OT pay off,
  // proving only the monetary OT changed — the hours (and thus any shortage coverage) are intact.
  const off = run(false), on = run(true);
  assert.strictEqual(off.pf, on.pf);
  assert.strictEqual(off.professionalTax, on.professionalTax);
  assert.strictEqual(off.lop, on.lop);
  assert.strictEqual(off.totalDeductions, on.totalDeductions);
  assert.strictEqual(on.gross - off.gross, 1600, 'only the OT pay differs');
});

test('Test 4 — no OT present → result identical regardless of the setting (unchanged behaviour)', () => {
  const mk = (flag) => computePayrollEngine({ earnings: { basic: 20800 }, settings: flag === undefined ? { ...BASE } : { ...BASE, calculateOtPay: flag }, attendance: { salaryWorkingDays: 26, lopDays: 0, overtimeHours: 0 } });
  assert.strictEqual(mk(false).gross, 20800);
  assert.strictEqual(mk(true).gross, 20800);
  assert.strictEqual(mk(false).overtimePay, 0);
  assert.strictEqual(mk(true).overtimePay, 0);
});

test('Backward compatible — a caller that does not set the flag still PAYS OT', () => {
  assert.strictEqual(run(undefined).overtimePay, 1600);
});

// ── Settings: default, persistence, and resolution ──
test('Test 5a — setting persists: hr_calculateotpay is a known settings FIELD (saved/read via the blob)', () => {
  assert.ok(settingsSvc.FIELDS.includes('hr_calculateotpay'), 'included in FIELDS → persisted + reloaded');
  assert.strictEqual(settingsSvc.PAYROLL_SETTINGS_DEFAULTS.hr_calculateotpay, 'true', 'default = Yes (preserves existing OT pay)');
});

test('Test 5b — resolve: default → calculateOtPay true; "false" → false; "true" → true', () => {
  const D = settingsSvc.PAYROLL_SETTINGS_DEFAULTS;
  assert.strictEqual(settingsSvc.resolve({ ...D }).calculateOtPay, true, 'default Yes');
  assert.strictEqual(settingsSvc.resolve({ ...D, hr_calculateotpay: 'false' }).calculateOtPay, false, 'No');
  assert.strictEqual(settingsSvc.resolve({ ...D, hr_calculateotpay: 'true' }).calculateOtPay, true, 'Yes');
});
