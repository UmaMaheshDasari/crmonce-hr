/**
 * EFFECTIVE DATE (2026-08-01) — the new hour-based rules apply ONLY from Aug 1, 2026.
 *
 *   date < 2026-08-01  → LEGACY calc (shift/2 half-day threshold + 'incomplete')
 *   date >= 2026-08-01 → NEW calc (7h Full / 5h Half, no 'incomplete', expected/balance)
 * The monthly balance never reads pre-cutoff days, so July can never carry into August.
 * No historical record is ever modified (the calc is read-only).
 */
process.env.NODE_ENV = 'test';
process.env.AZURE_CLIENT_ID = process.env.AZURE_CLIENT_ID || 'x';
process.env.AZURE_CLIENT_SECRET = process.env.AZURE_CLIENT_SECRET || 'x';
process.env.AZURE_TENANT_ID = process.env.AZURE_TENANT_ID || 'x';

const { test } = require('node:test');
const assert = require('node:assert');
const { computeSession } = require('../src/services/attendance.util');
const policy = require('../src/services/company.policy');
policy.reload();

// Even punch pair for N effective hours on the GENERAL shift (start 09:00, no breaks).
const pair = (hours) => {
  const end = 9 * 60 + Math.round(hours * 60);
  return ['09:00', `${String(Math.floor(end / 60)).padStart(2, '0')}:${String(end % 60).padStart(2, '0')}`];
};

// 6h EFFECTIVE is the discriminator: legacy (shift/2 = 4.5h → present) vs new (<7h → half).
test('2026-07-31 → OLD calculation (legacy present + incomplete, no expected)', () => {
  const c = computeSession(pair(6), 'GENERAL', { date: '2026-07-31' });
  assert.equal(c.newRules, false);
  assert.equal(c.status, 'present');       // 6h >= shift/2 (4.5) → Present under the OLD rule
  assert.equal(c.expectedHours, 0);        // expected/balance never applied to legacy days
  assert.equal(c.dailyBalanceHours, 0);
  const odd = computeSession(['09:00'], 'GENERAL', { date: '2026-07-31' });
  assert.equal(odd.status, 'incomplete');  // OLD odd-punch status preserved
});

test('2026-08-01 → NEW calculation (half_day, no incomplete, expected 5h)', () => {
  const c = computeSession(pair(6), 'GENERAL', { date: '2026-08-01' });
  assert.equal(c.newRules, true);
  assert.equal(c.status, 'half_day');      // 6h < 7 → Half Day under the NEW rule
  assert.equal(c.expectedHours, 5);
  assert.equal(c.dailyBalanceHours, 1);    // 6 − 5
  // A PREVIOUS date with an open/missing-OUT punch is FINALIZED (never IN PROGRESS) —
  // classified by its actual worked hours. A lone IN (0 effective) → Half Day, with the
  // missing punch surfaced separately. IN PROGRESS is today-only.
  const odd = computeSession(['09:00'], 'GENERAL', { date: '2026-08-01' });
  assert.equal(odd.status, 'half_day');
  assert.notEqual(odd.status, 'in_progress');
  assert.equal(odd.attendanceIssue, 'Missing Check Out');
});

test('2026-08-24 → NEW calculation', () => {
  const c = computeSession(pair(6), 'GENERAL', { date: '2026-08-24' });
  assert.equal(c.newRules, true);
  assert.equal(c.status, 'half_day');
});

test('no date supplied → NEW rules (live punches are current)', () => {
  const c = computeSession(pair(6), 'GENERAL');
  assert.equal(c.newRules, true);
  assert.equal(c.status, 'half_day');
});

test('the boundary flips ONLY at the cutoff — same punches, Jul 31 vs Aug 1 differ', () => {
  const jul = computeSession(pair(6), 'GENERAL', { date: '2026-07-31' });
  const aug = computeSession(pair(6), 'GENERAL', { date: '2026-08-01' });
  assert.equal(jul.status, 'present');
  assert.equal(aug.status, 'half_day');
  assert.notEqual(jul.status, aug.status);
});

// ── Monthly balance: pre-cutoff month is empty; July never carries into August ──
test('July 2026 monthly balance is empty (0 carry into August); no writes', async () => {
  const d365 = require('../src/services/d365.service');
  const shiftHistory = require('../src/services/shift-history.service');
  const payrollSettings = require('../src/services/payroll-settings.service');
  const { buildMonthlyBalance } = require('../src/services/monthly-balance.service');
  const orig = { gl: d365.getList, cr: d365.create, up: d365.update, del: d365.delete, sr: shiftHistory.shiftResolverFor, ps: payrollSettings.getResolved };
  payrollSettings.getResolved = async () => ({ lateLogin: { graceMinutes: 15 } });
  shiftHistory.shiftResolverFor = async () => ({ forDate: () => ({ start: '09:00', end: '18:00', durationHours: 9, isNight: false, grace: 5 }) });
  // Guard: the calc must NEVER write historical records.
  const noWrite = (name) => async () => { throw new Error(`monthly balance must not ${name}`); };
  d365.create = noWrite('create'); d365.update = noWrite('update'); d365.delete = noWrite('delete');
  d365.getList = async (entity, opts) => {
    if (entity === d365.constructor.entities.leave) return { data: [] };
    if (opts && opts.top === 1) return { data: [{ hr_date: '2026-07-01' }] };
    // A July day that WOULD be a shortage under the new rule — must still be ignored.
    return { data: [{ hr_date: '2026-07-15', hr_allpunches: JSON.stringify(['09:00', '16:00']), hr_punchcount: 2 }] };
  };
  try {
    const r = await buildMonthlyBalance({ employeeId: 'e', year: 2026, month: 7 });
    assert.equal(r.workingDays, 0);      // no pre-cutoff day enters the new calc
    assert.equal(r.totalWorkedHours, 0);
    assert.equal(r.finalRequiredHours, 0);
    assert.equal(r.monthlyDifference, 0); // pre-cutoff month is empty; August starts fresh
    assert.equal(r.shortageHours, 0);
  } finally {
    Object.assign(d365, { getList: orig.gl, create: orig.cr, update: orig.up, delete: orig.del });
    shiftHistory.shiftResolverFor = orig.sr; payrollSettings.getResolved = orig.ps;
  }
});

// ── September does NOT carry August (each month is independent — NO carry-forward) ──
test('September is independent — August shortage is NOT carried forward', async () => {
  const { computeMonthlySummary } = require('../src/services/monthly-balance.service');
  // August ended at a 3h shortage — irrelevant to September.
  const aug = computeMonthlySummary({ workingDays: 22, presentWorkedHours: 195 });
  assert.equal(aug.monthlyDifference, -3);      // 195 worked − 198 required
  // September computed on its own data only; no August difference is fed in or added.
  const sep = computeMonthlySummary({ workingDays: 20, presentWorkedHours: 180 });
  assert.equal(sep.monthlyDifference, 0);       // starts fresh at 0, not -3
  assert.ok(!('previousCarryForward' in sep) && !('carryForward' in sep));
});
