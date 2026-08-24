/**
 * Phase 2 — Monthly cumulative hour balance.
 *
 *   Daily Balance   = effective worked − daily expected (Full 9h / Half 5h)
 *   Running Balance = previous carry forward + Σ daily balance
 *   Approved leave / holiday / weekly-off → expected 0 (no shortage)
 *   Overtime raises the balance via (worked − expected) and is NOT re-added
 * No 'incomplete'. Historical dates use the shift effective on that date.
 */
process.env.NODE_ENV = 'test';
process.env.AZURE_CLIENT_ID = process.env.AZURE_CLIENT_ID || 'x';
process.env.AZURE_CLIENT_SECRET = process.env.AZURE_CLIENT_SECRET || 'x';
process.env.AZURE_TENANT_ID = process.env.AZURE_TENANT_ID || 'x';

const { test } = require('node:test');
const assert = require('node:assert');
const mb = require('../src/services/monthly-balance.service');
const { rollupMonthlyBalance, buildMonthlyBalance } = mb;

// ── Pure roll-up — the spec's worked examples ─────────────────────────
test('10 + 10 + 7 = 27, required 27 → balance 0', () => {
  const r = rollupMonthlyBalance([
    { worked: 10, expected: 9 }, { worked: 10, expected: 9 }, { worked: 7, expected: 9 },
  ]);
  assert.equal(r.effectiveHours, 27);
  assert.equal(r.requiredHours, 27);
  assert.equal(r.currentBalance, 0);
  assert.equal(r.finalShortage, 0);
});

test('6 + 7: required 5 + 9 = 14, worked 13 → balance -1', () => {
  const r = rollupMonthlyBalance([
    { worked: 6, expected: 5 },   // Half Day
    { worked: 7, expected: 9 },   // Full Day
  ]);
  assert.equal(r.requiredHours, 14);
  assert.equal(r.effectiveHours, 13);
  assert.equal(r.currentBalance, -1);
  assert.equal(r.finalShortage, 1);
});

test('running balance carries across days (+1, +1, -2 → 0)', () => {
  const r = rollupMonthlyBalance([
    { worked: 10, expected: 9 }, { worked: 10, expected: 9 }, { worked: 7, expected: 9 },
  ]);
  assert.deepEqual(r.days.map((d) => d.runningBalance), [1, 2, 0]);
});

test('previous carry forward is included', () => {
  const r = rollupMonthlyBalance([{ worked: 7, expected: 9 }], { previousCarryForward: 5 });
  assert.equal(r.previousCarryForward, 5);
  assert.equal(r.currentBalance, 3);   // 5 + (7 − 9)
});

test('approved leave removes expected hours → no shortage', () => {
  const r = rollupMonthlyBalance([
    { worked: 9, expected: 9 },
    { worked: 9, expected: 9 },
    { type: 'leave', worked: 0, expected: 0, leaveHours: 9 },   // requirement removed
    { worked: 11, expected: 9 },
  ]);
  assert.equal(r.approvedLeaveHours, 9);
  assert.equal(r.requiredHours, 27);          // the leave day contributes 0, not 9
  assert.equal(r.effectiveHours, 29);
  assert.equal(r.currentBalance, 2);          // +2, no shortage from the leave day
  assert.equal(r.finalShortage, 0);
});

test('overtime recovers a shortage and is NOT double-counted', () => {
  const r = rollupMonthlyBalance([{ worked: 14, expected: 9, overtime: 5 }], { previousCarryForward: -3 });
  assert.equal(r.currentBalance, 2);   // -3 + (14 − 9) = +2 (NOT +2 + 5)
  assert.equal(r.overtime, 5);         // reported for display only
  assert.equal(r.finalShortage, 0);
});

test('holiday / weekly-off create no shortage (expected 0)', () => {
  const r = rollupMonthlyBalance([
    { type: 'holiday', worked: 0, expected: 0 },
    { type: 'weekoff', worked: 0, expected: 0 },
    { worked: 9, expected: 9 },
  ]);
  assert.equal(r.requiredHours, 9);
  assert.equal(r.currentBalance, 0);
  assert.equal(r.finalShortage, 0);
});

test('actualWorkedHours (gross) vs effectiveHours (net) tracked separately', () => {
  const r = rollupMonthlyBalance([{ worked: 8, span: 9, expected: 9 }]);   // 1h break
  assert.equal(r.actualWorkedHours, 9);
  assert.equal(r.effectiveHours, 8);
  assert.equal(r.currentBalance, -1);
});

// ── Builder integration (I/O stubbed) — shift-per-date, leave, holiday, absent ──
test('buildMonthlyBalance: historical shift per date, leave/holiday/absent, no incomplete', async () => {
  const d365 = require('../src/services/d365.service');
  const attnCfg = require('../src/services/attendance.config');
  const shiftHistory = require('../src/services/shift-history.service');
  const payrollSettings = require('../src/services/payroll-settings.service');
  const EMP = 'emp-1';
  // Past month so capTo = month end (no "today pending" branch).
  const Y = 2020, M = 1;
  // Records: 29th = 10h (present), 30th = 6h (half). 31st = no record (absent).
  const recs = [
    { hr_hrattendanceid: 'a1', hr_date: '2020-01-29', hr_allpunches: JSON.stringify(['09:00', '19:00']), hr_punchcount: 2 },
    { hr_hrattendanceid: 'a2', hr_date: '2020-01-30', hr_allpunches: JSON.stringify(['09:00', '15:00']), hr_punchcount: 2 },
  ];
  const orig = { gl: d365.getList, woff: attnCfg.weekOffDays, sr: shiftHistory.shiftResolverFor, ps: payrollSettings.getResolved };
  // Restrict the working window to Jan 27–31 (firstAttendanceDate) and make 28th a holiday,
  // 27th an approved leave day; 29 present, 30 half, 31 absent. Week-off disabled for determinism.
  attnCfg.weekOffDays = [];
  attnCfg.setDynamicHolidays(['2020-01-28']);
  payrollSettings.getResolved = async () => ({ lateLogin: { graceMinutes: 15 } });
  shiftHistory.shiftResolverFor = async () => ({ forDate: () => ({ code: 'GEN', name: 'General', start: '09:00', end: '18:00', durationHours: 9, isNight: false, grace: 5 }) });
  d365.getList = async (entity, opts) => {
    if (entity === d365.constructor.entities.leave) {
      return { data: [{ hr_fromdate: '2020-01-27', hr_todate: '2020-01-27', hr_status: 123140001 }] };   // approved leave 27th
    }
    // attendance entity
    if (opts && opts.top === 1) return { data: [{ hr_date: '2020-01-27' }] };   // firstAttendanceDate
    return { data: recs };
  };
  try {
    const r = await buildMonthlyBalance({ employeeId: EMP, year: Y, month: M });
    const byDate = new Map(r.days.map((d) => [d.date, d]));
    // 27th approved leave → expected 0, counted as approved-leave hours
    assert.equal(byDate.get('2020-01-27').type, 'leave');
    assert.equal(byDate.get('2020-01-27').expected, 0);
    // 28th holiday → expected 0
    assert.equal(byDate.get('2020-01-28').type, 'holiday');
    assert.equal(byDate.get('2020-01-28').expected, 0);
    // 29th present 10h → expected 9
    assert.equal(byDate.get('2020-01-29').type, 'working');
    assert.equal(byDate.get('2020-01-29').worked, 10);
    assert.equal(byDate.get('2020-01-29').expected, 9);
    // 30th half 6h → expected 5
    assert.equal(byDate.get('2020-01-30').worked, 6);
    assert.equal(byDate.get('2020-01-30').expected, 5);
    // 31st absent → expected 9 (full-day shortage)
    assert.equal(byDate.get('2020-01-31').type, 'absent');
    assert.equal(byDate.get('2020-01-31').expected, 9);
    // Aggregates: required 0+0+9+5+9 = 23 ; effective 10+6 = 16 ; balance (1)+(1)+(-9) = -7
    assert.equal(r.requiredHours, 23);
    assert.equal(r.effectiveHours, 16);
    assert.equal(r.approvedLeaveHours, 9);
    assert.equal(r.currentBalance, -7);
    assert.equal(r.finalShortage, 7);
    // No 'incomplete' anywhere
    assert.ok(r.days.every((d) => d.type !== 'incomplete'));
  } finally {
    d365.getList = orig.gl; attnCfg.weekOffDays = orig.woff; shiftHistory.shiftResolverFor = orig.sr; payrollSettings.getResolved = orig.ps;
    attnCfg.setDynamicHolidays([]);
  }
});
