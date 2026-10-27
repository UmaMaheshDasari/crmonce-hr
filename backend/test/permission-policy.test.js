/**
 * Monthly permission policy (Late Login / Early Logout), effective 2026-11-01.
 * Pure tier decision + effective-date boundary + the idempotent, balance-checked 0.5-day
 * Casual Leave debit (authoritative leave engine stubbed — no network).
 */
process.env.NODE_ENV = 'test';
process.env.AZURE_CLIENT_ID = process.env.AZURE_CLIENT_ID || 'x';
process.env.AZURE_CLIENT_SECRET = process.env.AZURE_CLIENT_SECRET || 'x';
process.env.AZURE_TENANT_ID = process.env.AZURE_TENANT_ID || 'x';

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const PP = require('../src/services/permission-policy.service');
const leaveEngine = require('../src/services/leave-engine.service');

// ── Effective-date boundary (spec: not retroactive before 2026-11-01) ──
test('effectiveFor: Oct 31 2026 = NO, Nov 1 2026 = YES', () => {
  assert.strictEqual(PP.effectiveFor('2026-10-31'), false);
  assert.strictEqual(PP.effectiveFor('2026-11-01'), true);
  assert.strictEqual(PP.effectiveFor('2026-12-15'), true);
  assert.strictEqual(PP.effectiveFor(''), false);
});

// ── Tier decision (1st/2nd auto, 3rd manager, 4th+ deduct) ──
test('decide: ALL auto_approved; stages at 4=hr_warning, 5=final_warning, 6+=escalation (no penalty)', () => {
  assert.deepStrictEqual(PP.decide(0), { n: 1, outcome: 'auto_approved', stage: null });
  assert.deepStrictEqual(PP.decide(1), { n: 2, outcome: 'auto_approved', stage: null });
  assert.deepStrictEqual(PP.decide(2), { n: 3, outcome: 'auto_approved', stage: null });
  assert.deepStrictEqual(PP.decide(3), { n: 4, outcome: 'auto_approved', stage: 'hr_warning' });
  assert.deepStrictEqual(PP.decide(4), { n: 5, outcome: 'auto_approved', stage: 'final_warning' });
  assert.deepStrictEqual(PP.decide(5), { n: 6, outcome: 'auto_approved', stage: 'escalation' });
  assert.deepStrictEqual(PP.decide(9), { n: 10, outcome: 'auto_approved', stage: 'escalation' });
  // No outcome is ever a CL deduction or manager approval under the revised policy.
  for (let p = 0; p < 12; p++) assert.strictEqual(PP.decide(p).outcome, 'auto_approved');
});

test('isQualifying: rejected 3rd + cancellations do NOT count; everything else does', () => {
  assert.strictEqual(PP.isQualifying('manager_rejected'), false);
  assert.strictEqual(PP.isQualifying('rejected'), false);
  assert.strictEqual(PP.isQualifying('cancelled'), false);
  for (const s of ['auto_approved', 'manager_pending', 'manager_approved', 'cl_deducted', 'hr_review', 'submitted'])
    assert.strictEqual(PP.isQualifying(s), true, `${s} qualifies`);
});

// ── CL debit: authoritative, idempotent, balance-checked ──
let orig;
beforeEach(() => { orig = { rl: leaveEngine.readLedger, gb: leaveEngine.getBalance, add: leaveEngine.addLedgerEntry }; });
afterEach(() => { leaveEngine.readLedger = orig.rl; leaveEngine.getBalance = orig.gb; leaveEngine.addLedgerEntry = orig.add; });

test('debitCasualHalfDay: sufficient CL → 0.5 negative casual adjustment written', async () => {
  leaveEngine.readLedger = async () => [];
  leaveEngine.getBalance = async () => ({ casual: { remaining: 5 } });
  let written = null; leaveEngine.addLedgerEntry = async (e) => { written = e; return {}; };
  const r = await PP.debitCasualHalfDay({ employeeId: 'E1', employeeName: 'V', date: '2026-11-10', requestType: 'late_login', createdBy: 'policy' });
  assert.strictEqual(r.outcome, 'cl_deducted');
  assert.strictEqual(r.days, 0.5);
  assert.strictEqual(written.kind, 'adjustment');
  assert.strictEqual(written.category, 'casual');
  assert.strictEqual(written.days, -0.5, 'debit is a NEGATIVE casual adjustment (authoritative reduction)');
  assert.strictEqual(written.reason, PP.clReason('late_login', 'E1', '2026-11-10'));   // event-keyed (type:employee:date)
});

test('debitCasualHalfDay: insufficient CL (< 0.5) → hr_review, NO ledger write (no negative balance)', async () => {
  leaveEngine.readLedger = async () => [];
  leaveEngine.getBalance = async () => ({ casual: { remaining: 0.25 } });
  let wrote = false; leaveEngine.addLedgerEntry = async () => { wrote = true; return {}; };
  const r = await PP.debitCasualHalfDay({ employeeId: 'E1', date: '2026-11-10', requestType: 'late_login', recordId: 'LL2' });
  assert.strictEqual(r.outcome, 'hr_review');
  assert.strictEqual(r.reason, 'insufficient_cl');
  assert.strictEqual(wrote, false, 'never writes a debit when CL is insufficient');
});

test('debitCasualHalfDay: IDEMPOTENT — a debit already recorded for this event is not written twice', async () => {
  const key = PP.clReason('late_login', 'E1', '2026-11-10');
  leaveEngine.readLedger = async () => [{ hr_reason: key, hr_days: '-0.5' }];   // already debited for this event
  let wrote = false; leaveEngine.addLedgerEntry = async () => { wrote = true; return {}; };
  const r = await PP.debitCasualHalfDay({ employeeId: 'E1', date: '2026-11-10', requestType: 'late_login' });
  assert.strictEqual(r.outcome, 'cl_deducted');
  assert.strictEqual(r.already, true);
  assert.strictEqual(wrote, false, 'no second debit for the same event (retry/concurrency safe)');
});

test('debitCasualHalfDay: leave engine error → hr_review (fail-safe, no fabricated deduction)', async () => {
  leaveEngine.readLedger = async () => { throw new Error('dataverse down'); };
  leaveEngine.getBalance = async () => { throw new Error('dataverse down'); };
  const r = await PP.debitCasualHalfDay({ employeeId: 'E1', date: '2026-11-10', requestType: 'late_login' });
  assert.strictEqual(r.outcome, 'hr_review');
  assert.strictEqual(r.reason, 'error');
});

// ── Multi-flip reconciliation (Issue 1): a simulated append-only ledger converges to the
//    correct net across late→on-time→late→on-time, with repeated scans being no-ops. ──
function ledgerSim() {
  const rows = [];
  leaveEngine.readLedger = async () => rows.slice();
  leaveEngine.getBalance = async () => ({ casual: { remaining: 10 } });   // always enough CL here
  leaveEngine.addLedgerEntry = async (e) => { rows.push({ hr_reason: e.reason, hr_days: String(e.days) }); return {}; };
  const net = () => Math.round(rows.reduce((s, r) => s + Number(r.hr_days), 0) * 100) / 100;
  return { rows, net };
}
const ev = { employeeId: 'E1', employeeName: 'V', date: '2026-11-10', requestType: 'late_login' };

test('multi-flip: late → on-time → late → on-time converges to net 0 (no residual penalty)', async () => {
  const L = ledgerSim();
  await PP.debitCasualHalfDay(ev);                 assert.strictEqual(L.net(), -0.5);   // late → -0.5
  await PP.reverseCasualHalfDay(ev);               assert.strictEqual(L.net(), 0);      // on-time → 0
  await PP.debitCasualHalfDay(ev);                 assert.strictEqual(L.net(), -0.5);   // late again → -0.5
  const final = await PP.reverseCasualHalfDay(ev); assert.strictEqual(L.net(), 0);      // on-time again → 0 (FIXED)
  assert.strictEqual(final.reversed, true);
  assert.strictEqual(L.rows.length, 4, 'append-only: every transition recorded, none rewritten');
});

test('multi-flip: late → on-time → late ends at net -0.5 (penalty correctly stands)', async () => {
  const L = ledgerSim();
  await PP.debitCasualHalfDay(ev);     assert.strictEqual(L.net(), -0.5);
  await PP.reverseCasualHalfDay(ev);   assert.strictEqual(L.net(), 0);
  await PP.debitCasualHalfDay(ev);     assert.strictEqual(L.net(), -0.5);
});

test('repeated scans of a STABLE state are no-ops (idempotent) — no extra rows, net unchanged', async () => {
  const L = ledgerSim();
  await PP.debitCasualHalfDay(ev);
  const before = L.rows.length;
  await PP.debitCasualHalfDay(ev);   // re-scan, still late
  await PP.debitCasualHalfDay(ev);
  assert.strictEqual(L.rows.length, before, 'no duplicate debit rows');
  assert.strictEqual(L.net(), -0.5);
});

test('DUPLICATE records / concurrent paths cannot double-deduct one event (CL is event-keyed)', async () => {
  const L = ledgerSim();
  // Simulate the permission path AND the scanner both processing the SAME event (e.g. a
  // duplicate hr_lateLogin record slipped through under concurrency). The event-keyed reconciler
  // deducts exactly once regardless.
  await PP.debitCasualHalfDay({ ...ev, createdBy: 'request' });
  await PP.debitCasualHalfDay({ ...ev, createdBy: 'scanner' });
  await PP.debitCasualHalfDay({ ...ev, createdBy: 'retry' });
  assert.strictEqual(L.net(), -0.5, 'one real-world event → exactly one 0.5 CL deduction');
  assert.strictEqual(L.rows.length, 1, 'no duplicate debit rows even across paths');
});

test('reversal never exceeds the debit: reversing an un-debited event writes nothing, net stays 0', async () => {
  const L = ledgerSim();
  const r1 = await PP.reverseCasualHalfDay(ev);
  assert.strictEqual(r1.reversed, false);
  assert.strictEqual(L.rows.length, 0);
  assert.strictEqual(L.net(), 0);
});

test('reverseCasualHalfDay: writes a compensating +0.5 ONLY when a debit exists and no reversal yet (idempotent)', async () => {
  const debitKey = PP.clReason('late_login', 'E1', '2026-11-10');
  // No debit → nothing to reverse.
  leaveEngine.readLedger = async () => [];
  let wrote = null; leaveEngine.addLedgerEntry = async (e) => { wrote = e; return {}; };
  assert.deepStrictEqual((await PP.reverseCasualHalfDay({ employeeId: 'E1', date: '2026-11-10', requestType: 'late_login' })).reversed, false);
  assert.strictEqual(wrote, null);
  // Debit present → reverse once (+0.5).
  leaveEngine.readLedger = async () => [{ hr_reason: debitKey, hr_days: '-0.5' }];
  const r = await PP.reverseCasualHalfDay({ employeeId: 'E1', employeeName: 'V', date: '2026-11-10', requestType: 'late_login' });
  assert.strictEqual(r.reversed, true);
  assert.strictEqual(wrote.days, 0.5, 'compensating positive casual adjustment');
  assert.strictEqual(wrote.reason, PP.clReversalReason('late_login', 'E1', '2026-11-10'));
  // Reversal already present (net zero) → no second reversal.
  leaveEngine.readLedger = async () => [{ hr_reason: debitKey, hr_days: '-0.5' }, { hr_reason: PP.clReversalReason('late_login', 'E1', '2026-11-10'), hr_days: '0.5' }];
  wrote = null;
  assert.strictEqual((await PP.reverseCasualHalfDay({ employeeId: 'E1', date: '2026-11-10', requestType: 'late_login' })).already, true);
  assert.strictEqual(wrote, null, 'reversal is idempotent');
});
