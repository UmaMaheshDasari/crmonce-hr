/**
 * Company Settings — Attendance Rules (configurable source of truth) + wiring.
 *
 * - resolve() exposes a typed attendanceRules object with the required defaults.
 * - company.policy reads those values through its DB provider (peekResolved snapshot).
 * - the payroll engine adds an Hourly Shortage Deduction term.
 * - the settings-audit records one append-only row per changed field.
 */
process.env.NODE_ENV = 'test';
process.env.AZURE_CLIENT_ID = process.env.AZURE_CLIENT_ID || 'x';
process.env.AZURE_CLIENT_SECRET = process.env.AZURE_CLIENT_SECRET || 'x';
process.env.AZURE_TENANT_ID = process.env.AZURE_TENANT_ID || 'x';

const { test } = require('node:test');
const assert = require('node:assert');
const settings = require('../src/services/payroll-settings.service');
const policy = require('../src/services/company.policy');
const { computePayrollEngine } = require('../src/services/payroll-engine.calc');

// ── Defaults (Phase 19) ───────────────────────────────────────────────
test('resolve(): attendanceRules defaults', () => {
  const a = settings.resolve({}).attendanceRules;
  assert.equal(a.effectiveDate, '2026-08-01');
  assert.equal(a.fullDayMinHours, 7);
  assert.equal(a.halfDayMinHours, 5);
  assert.equal(a.fullDayExpectedHours, 9);
  assert.equal(a.halfDayExpectedHours, 5);
  assert.equal(a.enableMonthlyHourBalance, true);
  assert.equal(a.enableHourlyShortageDeduction, true);
  assert.equal(a.approvedLeaveDeduction, false);
  assert.equal(a.lateLoginDeduction, false);
  assert.equal(a.overtimeCarryForward, false);
  assert.equal(a.hourBalanceCarryForward, false);
  assert.equal(a.negativeBalanceCarryForward, false);
  assert.equal(a.halfDayLopFromShortage, false);
  assert.equal(a.fullDayLopFromShortage, false);
  assert.equal(a.absentCreatesLop, true);
  assert.equal(a.hourlyDeductionBasis, 'Employee Hourly Rate');
  assert.equal(a.ruleVersion, 'v1');
});

test('resolve(): admin overrides are typed', () => {
  const a = settings.resolve({ hr_fulldayminhours: '8', hr_halfdayminhours: '4', hr_enablehourlyshortagededuction: 'false', hr_attnruleeffectivedate: '2026-10-01' }).attendanceRules;
  assert.equal(a.fullDayMinHours, 8);
  assert.equal(a.halfDayMinHours, 4);
  assert.equal(a.enableHourlyShortageDeduction, false);
  assert.equal(a.effectiveDate, '2026-10-01');
});

// ── company.policy reads Attendance Rules through the DB provider ──────
test('company.policy reflects the configured settings (DB provider)', () => {
  const orig = settings.peekResolved;
  settings.peekResolved = () => ({ attendanceRules: { fullDayMinHours: 6, halfDayMinHours: 4, fullDayExpectedHours: 8, halfDayExpectedHours: 4, effectiveDate: '2026-09-01' }, lateLogin: { graceMinutes: 12 } });
  try {
    policy.setProvider(policy.dbProvider); policy.reload();
    assert.equal(policy.attendance.fullDayMinHours(), 6);
    assert.equal(policy.attendance.halfDayMinHours(), 4);
    assert.equal(policy.attendance.fullDayExpectedHours(), 8);
    assert.equal(policy.attendance.newRulesFrom(), '2026-09-01');
    assert.equal(policy.attendance.graceMinutes(), 12);
  } finally {
    settings.peekResolved = orig; policy.setProvider(null); policy.reload();   // back to env/defaults (7/5)
  }
});

test('company.policy falls back to defaults when settings not warmed', () => {
  const orig = settings.peekResolved;
  settings.peekResolved = () => null;
  try {
    policy.setProvider(policy.dbProvider); policy.reload();
    assert.equal(policy.attendance.fullDayMinHours(), 7);   // default
    assert.equal(policy.attendance.newRulesFrom(), '2026-08-01');
  } finally { settings.peekResolved = orig; policy.setProvider(null); policy.reload(); }
});

// ── Payroll engine — Hourly Shortage Deduction term ───────────────────
test('engine: hourShortageDeduction is added to total deductions + net', () => {
  const base = computePayrollEngine({ earnings: { basic: 26000 }, settings: { lopBasis: 'fixed_30', workingHoursPerDay: 8 }, attendance: { salaryWorkingDays: 26, calendarDays: 30, lopDays: 0 } });
  const with900 = computePayrollEngine({ earnings: { basic: 26000 }, settings: { lopBasis: 'fixed_30', workingHoursPerDay: 8 }, attendance: { salaryWorkingDays: 26, calendarDays: 30, lopDays: 0 }, hourShortageDeduction: 900 });
  assert.equal(with900.hourShortageDeduction, 900);
  assert.equal(with900.totalDeductions, with900.pf + with900.professionalTax + with900.incomeTax + with900.lop + 900 + with900.advance + with900.otherDeductions);
  assert.equal(with900.netSalary, with900.gross - with900.totalDeductions);
  assert.equal(with900.netSalary, base.netSalary - 900);   // exactly 900 less than without it
});

// ── Settings audit — append-only, one row per CHANGED field ────────────
test('settings-audit.recordDiff writes one row per changed field, skips unchanged', async () => {
  const audit = require('../src/services/settings-audit.service');
  const d365 = require('../src/services/d365.service');
  const orig = d365.create; const rows = [];
  d365.create = async (_e, body) => { rows.push(body); return { id: 'x' }; };
  try {
    await audit.recordDiff({
      before: { hr_fulldayminhours: '8', hr_halfdayminhours: '5' },
      after: { hr_fulldayminhours: '7', hr_halfdayminhours: '5' },   // only fullday changed
      fields: ['hr_fulldayminhours', 'hr_halfdayminhours'],
      changedBy: 'Admin', reason: 'Updated attendance policy', effectiveDate: '2026-08-01', ruleVersion: 'v1',
    });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].hr_field, 'hr_fulldayminhours');
    assert.equal(rows[0].hr_fieldlabel, 'Full Day Minimum Hours');
    assert.equal(rows[0].hr_oldvalue, '8');
    assert.equal(rows[0].hr_newvalue, '7');
    assert.equal(rows[0].hr_changedby, 'Admin');
    assert.equal(rows[0].hr_reason, 'Updated attendance policy');
  } finally { d365.create = orig; }
});
