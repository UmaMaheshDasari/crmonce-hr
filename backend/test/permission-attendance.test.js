/**
 * Punch-based Late Login detection + request/punch reconciliation (spec §3). Pure helpers,
 * exercised through the authoritative attendance engine (computeSession). No network.
 * NOTE: these helpers are the SAFE foundation; automatic counting/CL deduction from punches
 * (for employees who never filed a permission) is NOT wired — see the reported blocker.
 */
process.env.NODE_ENV = 'test';
process.env.AZURE_CLIENT_ID = process.env.AZURE_CLIENT_ID || 'x';
process.env.AZURE_CLIENT_SECRET = process.env.AZURE_CLIENT_SECRET || 'x';
process.env.AZURE_TENANT_ID = process.env.AZURE_TENANT_ID || 'x';

const { test } = require('node:test');
const assert = require('node:assert');
const { lateEventForDate, reconcileQualifyingDates } = require('../src/services/permission-attendance.util');

const SHIFT = { start: '09:00', end: '18:00', grace: 5 };
const rec = (punches) => ({ hr_date: '2026-11-10', hr_allpunches: JSON.stringify(punches) });

// ── Grace boundary (spec: 09:05 not late, 09:06 late) ──
test('09:05 check-in → NOT a qualifying late event (within 5-min grace)', () => {
  const e = lateEventForDate(rec(['09:05', '18:05']), SHIFT, '2026-11-10', { effectiveFrom: '2026-11-01' });
  assert.strictEqual(e.hasCheckIn, true);
  assert.strictEqual(e.lateEntryMinutes, 0);
  assert.strictEqual(e.qualifies, false);
});

test('09:06 check-in → qualifying late event (past the grace)', () => {
  const e = lateEventForDate(rec(['09:06', '18:06']), SHIFT, '2026-11-10', { effectiveFrom: '2026-11-01' });
  assert.strictEqual(e.lateEntryMinutes, 6);   // measured from shift start, not grace end
  assert.strictEqual(e.qualifies, true);
});

test('09:00 on-time → not late', () => {
  assert.strictEqual(lateEventForDate(rec(['09:00', '18:00']), SHIFT, '2026-11-10', { effectiveFrom: '2026-11-01' }).qualifies, false);
});

// ── Corrected punch within grace → on-time (authoritative record decides) ──
test('a corrected authoritative record with a check-in within grace is NOT late', () => {
  // e.g. a missing-punch correction produced an authoritative 09:04 check-in → on-time.
  const e = lateEventForDate(rec(['09:04', '18:10']), SHIFT, '2026-11-10', { effectiveFrom: '2026-11-01' });
  assert.strictEqual(e.qualifies, false);
});

// ── Incomplete / no check-in → not counted ──
test('no check-in (empty punches) → not a qualifying event', () => {
  const e = lateEventForDate(rec([]), SHIFT, '2026-11-10', { effectiveFrom: '2026-11-01' });
  assert.strictEqual(e.hasCheckIn, false);
  assert.strictEqual(e.qualifies, false);
});

test('INCOMPLETE day (late check-in, no check-out) → NOT auto-penalised', () => {
  const e = lateEventForDate(rec(['09:30']), SHIFT, '2026-11-10', { effectiveFrom: '2026-11-01' });
  assert.strictEqual(e.hasCheckIn, true);
  assert.strictEqual(e.lateEntryMinutes, 30);          // it IS a late check-in…
  assert.notStrictEqual(e.status, 'present');
  assert.strictEqual(e.qualifies, false);              // …but the day is not finalised → not counted
});

test('finalised HALF-DAY with a late check-in → qualifies (finalised worked day)', () => {
  const e = lateEventForDate(rec(['09:30', '14:30']), SHIFT, '2026-11-10', { effectiveFrom: '2026-11-01' });
  assert.strictEqual(e.status, 'half_day');
  assert.strictEqual(e.lateEntryMinutes, 30);
  assert.strictEqual(e.qualifies, true);
});

// ── Effective-date gate (not retroactive) ──
test('a late check-in BEFORE the effective date does not qualify', () => {
  const e = lateEventForDate({ hr_date: '2026-10-31', hr_allpunches: JSON.stringify(['09:30', '18:00']) }, SHIFT, '2026-10-31', { effectiveFrom: '2026-11-01' });
  assert.strictEqual(e.lateEntryMinutes, 30);   // it IS late…
  assert.strictEqual(e.qualifies, false);       // …but pre-effective → not counted
});

// ── Reconciliation: same date via permission AND punch = counted once ──
test('reconcileQualifyingDates: dedups a date covered by both a permission and a late punch', () => {
  const out = reconcileQualifyingDates({
    permissionDates: ['2026-11-03', '2026-11-10'],
    punchLateDates: ['2026-11-10', '2026-11-15'],   // 11-10 overlaps a permission → one event
  });
  assert.deepStrictEqual(out, ['2026-11-03', '2026-11-10', '2026-11-15']);
  assert.strictEqual(out.length, 3, 'the overlapping date is counted once');
});

test('reconcileQualifyingDates: handles empty inputs', () => {
  assert.deepStrictEqual(reconcileQualifyingDates({}), []);
  assert.deepStrictEqual(reconcileQualifyingDates({ punchLateDates: ['2026-11-01'] }), ['2026-11-01']);
});
