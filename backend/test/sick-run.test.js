/**
 * Consecutive Sick-Leave run — the medical-certificate trigger. Pure, no network.
 */
process.env.NODE_ENV = 'test';
process.env.AZURE_CLIENT_ID = process.env.AZURE_CLIENT_ID || 'test-client';
process.env.AZURE_CLIENT_SECRET = process.env.AZURE_CLIENT_SECRET || 'test-secret';
process.env.AZURE_TENANT_ID = process.env.AZURE_TENANT_ID || 'test-tenant';
process.env.D365_BASE_URL = process.env.D365_BASE_URL || 'https://example.crm.dynamics.com';

const { test } = require('node:test');
const assert = require('node:assert');
const { computeSickRunDays } = require('../src/services/sick-run.service');

const allWorking = () => true;
// Mon–Fri working, Sat/Sun off (UTC weekday).
const weekdaysOnly = (d) => { const w = new Date(`${d}T00:00:00Z`).getUTCDay(); return w !== 0 && w !== 6; };

test('two adjacent working-day Sick Leaves → run of 2 (certificate required)', () => {
  const set = new Set(['2026-08-03', '2026-08-04']);   // Mon+Tue
  assert.strictEqual(computeSickRunDays({ requestFrom: '2026-08-04', requestTo: '2026-08-04', slWorkingDates: set, isWorkingDay: weekdaysOnly }), 2);
});

test('non-adjacent Sick Leaves (gap of working days) → run of 1 (no certificate)', () => {
  const set = new Set(['2026-08-04', '2026-08-11']);
  assert.strictEqual(computeSickRunDays({ requestFrom: '2026-08-11', requestTo: '2026-08-11', slWorkingDates: set, isWorkingDay: allWorking }), 1);
});

test('SL, Present, SL → not consecutive (run of 1)', () => {
  // Mon SL(03), Tue present(04 not in set), Wed SL(05); request = Wed.
  const set = new Set(['2026-08-03', '2026-08-05']);
  assert.strictEqual(computeSickRunDays({ requestFrom: '2026-08-05', requestTo: '2026-08-05', slWorkingDates: set, isWorkingDay: allWorking }), 1);
});

test('weekly-off/holiday between two SL days is ignored → consecutive run', () => {
  // Fri 07 SL + (Sat/Sun off) + Mon 10 SL → run of 2.
  const set = new Set(['2026-08-07', '2026-08-10']);
  assert.strictEqual(computeSickRunDays({ requestFrom: '2026-08-10', requestTo: '2026-08-10', slWorkingDates: set, isWorkingDay: weekdaysOnly }), 2);
});

test('a single-day request with no neighbours → run of 1', () => {
  const set = new Set(['2026-08-04']);
  assert.strictEqual(computeSickRunDays({ requestFrom: '2026-08-04', requestTo: '2026-08-04', slWorkingDates: set, isWorkingDay: allWorking }), 1);
});

test('a 3 working-day request span → run of 3', () => {
  const set = new Set(['2026-08-04', '2026-08-05', '2026-08-06']);
  assert.strictEqual(computeSickRunDays({ requestFrom: '2026-08-04', requestTo: '2026-08-06', slWorkingDates: set, isWorkingDay: weekdaysOnly }), 3);
});

test('request entirely on a weekly-off → 0 working days, no run', () => {
  const set = new Set(['2026-08-08']);   // Saturday
  assert.strictEqual(computeSickRunDays({ requestFrom: '2026-08-08', requestTo: '2026-08-08', slWorkingDates: set, isWorkingDay: weekdaysOnly }), 0);
});
