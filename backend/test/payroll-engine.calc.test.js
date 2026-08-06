/**
 * Payroll Engine — pure calculation (Gross − PF − PT − TDS − LOP − Advance − Other).
 */
const { test } = require('node:test');
const assert = require('node:assert');
const { computePayrollEngine } = require('../src/services/payroll-engine.calc');

const SETTINGS = {
  pf: { employeePercent: 12, wageCeiling: 15000, applicable: true },
  professionalTax: { amount: 200, applicable: true },
  incomeTax: { percent: 0, applicable: false },
  lopBasis: 'salary_working_days', workingHoursPerDay: 8, overtimeMultiplier: 2,
};
const EARN = { basic: 40000, hra: 16000, special: 4000, medical: 1250, conveyance: 1600, otherAllowance: 2150 };

test('gross = sum of all earning components', () => {
  const r = computePayrollEngine({ earnings: EARN, settings: SETTINGS, attendance: { salaryWorkingDays: 26, lopDays: 0, calendarDays: 30 } });
  assert.strictEqual(r.gross, 65000);
});

test('PF = 12% of basic capped at the wage ceiling (15000 → 1800)', () => {
  const r = computePayrollEngine({ earnings: EARN, settings: SETTINGS, attendance: { salaryWorkingDays: 26, lopDays: 0 } });
  assert.strictEqual(r.pf, 1800);              // min(40000,15000)*12% = 1800
  assert.strictEqual(r.professionalTax, 200);
  assert.strictEqual(r.incomeTax, 0);          // IT not applicable
});

test('Net = Gross − PF − PT − TDS − LOP − Advance − Other (exact formula)', () => {
  const r = computePayrollEngine({
    earnings: EARN, settings: SETTINGS,
    overrides: { otherDeductions: 500, incomeTax: 1500 },
    attendance: { salaryWorkingDays: 26, lopDays: 0, calendarDays: 30 },
    advance: 5000,
  });
  // gross 65000; pf 1800; pt 200; tds 1500 (override); lop 0; advance 5000; other 500
  assert.strictEqual(r.totalDeductions, 1800 + 200 + 1500 + 0 + 5000 + 500);
  assert.strictEqual(r.netSalary, 65000 - (1800 + 200 + 1500 + 5000 + 500));
});

test('LOP: per-day = gross / salary working days; amount = per-day × LOP days', () => {
  const r = computePayrollEngine({
    earnings: { basic: 26000, hra: 0, special: 0, medical: 0, conveyance: 0, otherAllowance: 0 },
    settings: { ...SETTINGS, pf: { applicable: false }, professionalTax: { applicable: false } },
    attendance: { salaryWorkingDays: 26, lopDays: 2, calendarDays: 30 },
  });
  assert.strictEqual(r.perDay, 1000);   // 26000 / 26
  assert.strictEqual(r.lop, 2000);      // 1000 × 2
  assert.strictEqual(r.netSalary, 24000);
});

test('LOP basis fixed_30 uses gross/30', () => {
  const r = computePayrollEngine({
    earnings: { basic: 30000 }, settings: { ...SETTINGS, pf: { applicable: false }, professionalTax: { applicable: false }, lopBasis: 'fixed_30' },
    attendance: { salaryWorkingDays: 26, lopDays: 3, calendarDays: 31 },
  });
  assert.strictEqual(r.perDay, 1000);   // 30000/30
  assert.strictEqual(r.lop, 3000);
});

test('per-employee PF override wins; Professional Tax is ALWAYS slab-based', () => {
  const r = computePayrollEngine({
    earnings: EARN, settings: SETTINGS,
    overrides: { pfApplicable: true, pfAmount: 2500, professionalTax: 150 },   // PT override is ignored
    attendance: { salaryWorkingDays: 26, lopDays: 0 },
  });
  assert.strictEqual(r.pf, 2500);              // PF override honoured
  assert.strictEqual(r.professionalTax, 200);  // slab on gross 65000 — NOT the 150 override
});

test('Professional Tax follows the slab across brackets', () => {
  const at = (basic) => computePayrollEngine({ earnings: { basic }, settings: SETTINGS, attendance: { salaryWorkingDays: 26, lopDays: 0 } }).professionalTax;
  assert.strictEqual(at(15000), 0);      // <= 15000
  assert.strictEqual(at(15001), 150);    // 15001..20000
  assert.strictEqual(at(20000), 150);
  assert.strictEqual(at(20001), 200);    // > 20000
});

test('PF not applicable → 0', () => {
  const r = computePayrollEngine({ earnings: EARN, settings: SETTINGS, overrides: { pfApplicable: false, pfAmount: 5000 }, attendance: { salaryWorkingDays: 26, lopDays: 0 } });
  assert.strictEqual(r.pf, 0);
});

test('income tax as a percentage of gross when applicable', () => {
  const r = computePayrollEngine({
    earnings: EARN, settings: { ...SETTINGS, incomeTax: { percent: 10, applicable: true } },
    attendance: { salaryWorkingDays: 26, lopDays: 0 },
  });
  assert.strictEqual(r.incomeTax, 6500);   // 10% of 65000
});

test('overtime pay = hours × (perDay/8) × multiplier, added to gross', () => {
  const r = computePayrollEngine({
    earnings: { basic: 20800 }, settings: { ...SETTINGS, pf: { applicable: false }, professionalTax: { applicable: false } },
    attendance: { salaryWorkingDays: 26, lopDays: 0, overtimeHours: 8 },
  });
  // perDay = 20800/26 = 800; hourly = 100; OT = 8 × 100 × 2 = 1600
  assert.strictEqual(r.overtimePay, 1600);
  assert.strictEqual(r.gross, 22400);
});

test('everything together: LOP + advance + overrides is internally consistent', () => {
  const r = computePayrollEngine({
    earnings: EARN, settings: SETTINGS,
    overrides: { otherDeductions: 1000 },
    attendance: { salaryWorkingDays: 25, lopDays: 1, calendarDays: 30 },
    advance: 3000,
  });
  assert.strictEqual(r.gross, 65000);
  const perDay = Math.round(65000 / 25);           // 2600
  assert.strictEqual(r.lop, perDay);               // 1 LOP day
  assert.strictEqual(r.totalDeductions, r.pf + r.professionalTax + r.incomeTax + r.lop + r.advance + r.otherDeductions);
  assert.strictEqual(r.netSalary, r.gross - r.totalDeductions);
});
