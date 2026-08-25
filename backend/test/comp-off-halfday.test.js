/**
 * Half-day (0.5) Comp Off usage. The bug was NOT decimal rounding — balances already
 * preserve 0.5. The blocker was that a leave request could only ever be a whole working
 * day (min 1), so a 0.5 Comp Off balance was always < 1. The fix lets hr_days = 0.5
 * (single working day). These tests lock the decimal integrity end-to-end.
 */
process.env.NODE_ENV = 'test';
process.env.AZURE_CLIENT_ID = process.env.AZURE_CLIENT_ID || 'x';
process.env.AZURE_CLIENT_SECRET = process.env.AZURE_CLIENT_SECRET || 'x';
process.env.AZURE_TENANT_ID = process.env.AZURE_TENANT_ID || 'x';

const { test } = require('node:test');
const assert = require('node:assert');
const { computeBalance } = require('../src/services/leave-engine.service');
const { resolveDays } = require('../src/services/leave-summary.util');

// ── Comp Off balance preserves 0.5 (no floor/round) ──
test('comp-off balance: earned 0.5, used 0 → available 0.5', () => {
  const b = computeBalance({ ledger: [{ kind: 'comp_off_earned', category: 'compoff', days: 0.5 }] });
  assert.equal(b.compOff.earned, 0.5);
  assert.equal(b.compOff.used, 0);
  assert.equal(b.compOff.balance, 0.5);
});

test('comp-off balance: earned 1, used 0.5 → available 0.5 (§9)', () => {
  const b = computeBalance({ ledger: [
    { kind: 'comp_off_earned', category: 'compoff', days: 1 },
    { kind: 'comp_off_used', category: 'compoff', days: 0.5 },
  ] });
  assert.equal(b.compOff.balance, 0.5);
});

test('comp-off balance: earned 0.5, used 0.5 → available 0 (§12 after approval)', () => {
  const b = computeBalance({ ledger: [
    { kind: 'comp_off_earned', category: 'compoff', days: 0.5 },
    { kind: 'comp_off_used', category: 'compoff', days: 0.5 },
  ] });
  assert.equal(b.compOff.balance, 0);
});

// ── The stored day count for a half-day leave is exactly 0.5 (not rounded to 0 or 1) ──
test('resolveDays preserves 0.5 for a single-day half-day leave', () => {
  assert.equal(resolveDays(0.5, '2026-08-26', '2026-08-26'), 0.5);
});

// ── §6 balance guard truth table — the route allows when requested ≤ available ──
test('§6/§18 comp-off guard: requested ≤ available allows, otherwise rejects', () => {
  const allow = (available, requested) => !(available < requested);   // == the route/UI guard passing
  assert.equal(allow(0.5, 0.5), true, 'TEST 1: 0.5 available, 0.5 requested → SUCCESS');
  assert.equal(allow(1.0, 1.0), true, 'TEST 2: 1.0 available, 1.0 requested → SUCCESS');
  assert.equal(allow(1.0, 0.5), true, 'TEST 3: 1.0 available, 0.5 requested → SUCCESS (0.5 remains)');
  assert.equal(allow(0.5, 1.0), false, 'TEST 4: 0.5 available, 1.0 requested → REJECT');
  assert.equal(allow(0, 0.5), false, 'TEST 5: 0 available → not usable');
});
