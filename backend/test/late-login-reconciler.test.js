/**
 * Ledger scan for the revised (NO-penalty) policy: the reconciler is READ-ONLY and only flags
 * LEGACY CL residuals (from the old policy) for an approved remediation plan — it never debits,
 * reverses, or mutates the ledger/records. Also covers reason parsing, the bounded/cap-visible
 * discovery window, and per-event isolation. d365 stubbed; no network.
 */
process.env.NODE_ENV = 'test';
process.env.AZURE_CLIENT_ID = process.env.AZURE_CLIENT_ID || 'x';
process.env.AZURE_CLIENT_SECRET = process.env.AZURE_CLIENT_SECRET || 'x';
process.env.AZURE_TENANT_ID = process.env.AZURE_TENANT_ID || 'x';

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const d365 = require('../src/services/d365.service');
const leaveEngine = require('../src/services/leave-engine.service');
const PP = require('../src/services/permission-policy.service');
const R = require('../src/services/late-login-reconciler.service');

const NOV = '2026-11-10';
const penalty = (emp, date = NOV, type = 'late_login') => ({ hr_reason: PP.clReason(type, emp, date), hr_days: '-0.5' });
const reversal = (emp, date = NOV, type = 'late_login') => ({ hr_reason: PP.clReversalReason(type, emp, date), hr_days: '0.5' });

// ── parseEventReason + resolveWindow ──
test('parseEventReason: valid keys parse; junk and bad dates are rejected', () => {
  assert.deepStrictEqual(R.parseEventReason(PP.clReason('late_login', 'EMP1', NOV)), { requestType: 'late_login', employeeId: 'EMP1', date: NOV });
  assert.deepStrictEqual(R.parseEventReason(PP.clReversalReason('early_logout', 'E2', NOV)), { requestType: 'early_logout', employeeId: 'E2', date: NOV });
  assert.strictEqual(R.parseEventReason('carry_forward credit'), null);
  assert.strictEqual(R.parseEventReason('PERMISSION_CL_PENALTY:late_login:E1:2026-13-40'), null);
  assert.strictEqual(R.parseEventReason('PERMISSION_CL_PENALTY:bogus:E1:2026-11-10'), null);
});

test('resolveWindow: default 35, clamped [1,95], NaN-safe', () => {
  assert.strictEqual(R.resolveWindow(undefined), 35);
  assert.strictEqual(R.resolveWindow(10), 10);
  assert.strictEqual(R.resolveWindow(0), 1);
  assert.strictEqual(R.resolveWindow(9999), R.MAX_RECONCILE_WINDOW);
  assert.strictEqual(R.resolveWindow('abc'), 35);
});

// ── classifyEvent (pure, read-only) ──
test('classifyEvent: non-zero net → flag legacy_penalty_requires_review; zero net → noop', () => {
  assert.deepStrictEqual(R.classifyEvent(-0.5), { action: 'flag', flag: 'legacy_penalty_requires_review' });
  assert.deepStrictEqual(R.classifyEvent(-1.0), { action: 'flag', flag: 'legacy_penalty_requires_review' });
  assert.deepStrictEqual(R.classifyEvent(0), { action: 'noop' });
  assert.deepStrictEqual(R.classifyEvent(1e-12), { action: 'noop' });   // within tolerance
});

// ── End-to-end scan: READ-ONLY, flags legacy residuals, never writes ──
let orig;
beforeEach(() => { orig = { ga: d365.getAll, cr: d365.create, up: d365.update, del: d365.delete, add: leaveEngine.addLedgerEntry }; });
afterEach(() => { d365.getAll = orig.ga; d365.create = orig.cr; d365.update = orig.up; d365.delete = orig.del; leaveEngine.addLedgerEntry = orig.add; });

function harness({ ledgerRows = [] } = {}) {
  const writes = [];
  d365.getAll = async () => ({ data: ledgerRows.filter(r => /^PERMISSION_CL_/.test(r.hr_reason)), count: ledgerRows.length });
  d365.create = async (...a) => { writes.push(['create', a[0]]); return {}; };
  d365.update = async (...a) => { writes.push(['update', a[0]]); return {}; };
  d365.delete = async (...a) => { writes.push(['delete', a[0]]); return {}; };
  leaveEngine.addLedgerEntry = async (...a) => { writes.push(['ledger', a]); return {}; };
  return { writes };
}
const range = () => R.reconcileRange({ from: '2026-11-01', to: '2026-11-30' });

test('legacy penalty residual (net -0.5) → FLAGGED for remediation; NO write of any kind', async () => {
  const H = harness({ ledgerRows: [penalty('A')] });
  const s = await range();
  assert.strictEqual(s.legacyPenalties, 1);
  assert.strictEqual(s.flags.legacy_penalty_requires_review, 1);
  assert.ok(s.report.some(r => r.kind === 'legacy_penalty_requires_review' && r.employeeId === 'A' && r.needsApprovedRemediation === true));
  assert.strictEqual(H.writes.length, 0, 'read-only — never debits/reverses/mutates');
});

test('over-deducted legacy (net -1.0) → flagged once; still no write (no auto-correction)', async () => {
  const H = harness({ ledgerRows: [penalty('A'), { hr_reason: PP.clReason('late_login', 'A', NOV), hr_days: '-0.5' }] });
  const s = await range();
  assert.strictEqual(s.legacyPenalties, 1);
  assert.strictEqual(H.writes.length, 0);
});

test('already-net-zero event (debit + reversal) → NOT flagged, no write', async () => {
  const H = harness({ ledgerRows: [penalty('A'), reversal('A')] });
  const s = await range();
  assert.strictEqual(s.legacyPenalties, 0);
  assert.strictEqual(s.flagged, 0);
  assert.strictEqual(H.writes.length, 0);
});

test('REPEATED runs are idempotent (read-only → never create rows)', async () => {
  const H = harness({ ledgerRows: [penalty('A'), penalty('B')] });
  await range(); await range(); await range();
  assert.strictEqual(H.writes.length, 0);
});

test('early_logout legacy residual is also flagged (read-only)', async () => {
  const H = harness({ ledgerRows: [penalty('A', NOV, 'early_logout')] });
  const s = await range();
  assert.strictEqual(s.flags.legacy_penalty_requires_review, 1);
  assert.strictEqual(H.writes.length, 0);
});

test('per-event isolation: a bad row does not abort the rest', async () => {
  const H = harness({ ledgerRows: [{ hr_reason: 'PERMISSION_CL_PENALTY:late_login:A:2026-13-99', hr_days: '-0.5' }, penalty('B')] });
  const s = await range();
  assert.strictEqual(s.invalidReason, 1, 'A has an impossible date → invalid');
  assert.strictEqual(s.legacyPenalties, 1, 'B still flagged');
  assert.strictEqual(H.writes.length, 0);
});

// ── P2: cap-truncation visibility + bounded per-day subdivision ──
test('P2: below cap → not truncated', async () => {
  harness({ ledgerRows: [penalty('A')] });
  const s = await range();
  assert.strictEqual(s.truncated, false);
  assert.strictEqual(s.partial, false);
});

test('P2: aggregate truncates → per-day subdivision completes (partial=false)', async () => {
  const baseGa = d365.getAll;
  d365.getAll = async (_e, opts) => {
    const f = String(opts.filter || '');
    const ge = (f.match(/ge '([^']+)'/) || [])[1]; const le = (f.match(/le '([^']+)'/) || [])[1];
    if (ge !== le) return { data: [penalty('A')], count: 99999 };          // aggregate: truncated
    return { data: ge === NOV ? [penalty('A')] : [], count: ge === NOV ? 1 : 0 };   // single day: fits
  };
  try {
    const s = await R.reconcileRange({ from: '2026-11-10', to: '2026-11-12' });
    assert.strictEqual(s.truncated, true);
    assert.strictEqual(s.partial, false);
    assert.strictEqual(s.legacyPenalties, 1);
  } finally { d365.getAll = baseGa; }
});

test('P2: a single day still over the cap → PARTIAL', async () => {
  const baseGa = d365.getAll;
  d365.getAll = async () => ({ data: [penalty('A')], count: 99999 });
  try {
    const s = await R.reconcileRange({ from: '2026-11-10', to: '2026-11-11' });
    assert.strictEqual(s.truncated, true);
    assert.strictEqual(s.partial, true);
  } finally { d365.getAll = baseGa; }
});

// ── dry-run is read-only (same as live here, since the scan never writes) ──
test('dryRun: read-only, reports legacy penalties, writes nothing', async () => {
  const H = harness({ ledgerRows: [penalty('A'), penalty('B')] });
  const s = await R.reconcileRange({ from: '2026-11-01', to: '2026-11-30', dryRun: true });
  assert.strictEqual(s.dryRun, true);
  assert.strictEqual(s.readOnly, true);
  assert.strictEqual(s.legacyPenalties, 2);
  assert.strictEqual(H.writes.length, 0);
});

test('invalid reasons are counted, never processed as events', async () => {
  const baseGa = d365.getAll;
  d365.getAll = async () => ({ data: [{ hr_reason: 'PERMISSION_CL_PENALTY:bogus:E1:2026-11-10', hr_days: '-0.5' }], count: 1 });
  try {
    const s = await R.reconcileRange({ from: '2026-11-01', to: '2026-11-30' });
    assert.strictEqual(s.invalidReason, 1);
    assert.strictEqual(s.events, 0);
  } finally { d365.getAll = baseGa; }
});
