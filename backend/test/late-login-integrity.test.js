/**
 * HR/Admin Late Login integrity report — read-only composition + authorization.
 *  • Dry-run reconcile is the discrepancy/flag source and performs NO writes.
 *  • Negative CL balances via leaveEngine.getBalance (read-only).
 *  • Run-history category is reported UNAVAILABLE (no persistence), never fabricated.
 *  • The route is gated on reports.view; errors never leak raw exception detail.
 * d365 / leave engine / collaborators stubbed; no network.
 */
process.env.NODE_ENV = 'test';
process.env.AZURE_CLIENT_ID = process.env.AZURE_CLIENT_ID || 'x';
process.env.AZURE_CLIENT_SECRET = process.env.AZURE_CLIENT_SECRET || 'x';
process.env.AZURE_TENANT_ID = process.env.AZURE_TENANT_ID || 'x';
process.env.LATE_LOGIN_RUN_HISTORY = 'false';   // isolate: this suite asserts the run-history-unavailable path

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const d365 = require('../src/services/d365.service');
const leaveEngine = require('../src/services/leave-engine.service');
const PP = require('../src/services/permission-policy.service');
const reconciler = require('../src/services/late-login-reconciler.service');
const scanner = require('../src/services/late-login-scanner.service');
const integrity = require('../src/services/late-login-integrity.service');
const { requireAnyPermission } = require('../src/middleware/auth.middleware');

const NOV = '2026-11-10';
const penalty = (emp, date = NOV) => ({ hr_reason: PP.clReason('late_login', emp, date), hr_days: '-0.5' });

// ── Authorization (route guard = reports.view) ──
function guard(role) {
  const mw = requireAnyPermission('reports.view');
  const req = { user: { role, id: 'u1' } };
  let status = 200, passed = false;
  const res = { status(c) { status = c; return this; }, json() { return this; } };
  mw(req, res, () => { passed = true; });
  return { passed, status };
}
test('authorization: HR/Admin allowed; ordinary employee + recruiter denied (403)', () => {
  assert.deepEqual(guard('super_admin'), { passed: true, status: 200 });
  assert.deepEqual(guard('hr_manager'), { passed: true, status: 200 });
  assert.equal(guard('employee').passed, false);
  assert.equal(guard('employee').status, 403);
  assert.equal(guard('recruiter').passed, false);
});

// ── resolveRange validation / bounding ──
test('resolveRange: validates + clamps to the max horizon; rejects from>to', () => {
  const r = integrity.resolveRange({ from: '2020-01-01', to: '2026-11-30' });
  assert.ok(r.from > '2026-01-01', 'over-long range clamped to the horizon');
  assert.throws(() => integrity.resolveRange({ from: '2026-11-30', to: '2026-11-01' }), /on or before/);
});

// ── Composition + NO-WRITE guarantee ──
let orig;
beforeEach(() => {
  orig = { ga: d365.getAll, gl: d365.getList, cr: d365.create, up: d365.update, del: d365.delete, rl: leaveEngine.readLedger, gb: leaveEngine.getBalance, add: leaveEngine.addLedgerEntry, ae: scanner.activeEmployees, ex: require('../src/services/late-login.service').existingLateFor, rev: require('../src/services/late-login.service').reversePunchAutoRecord, rs: require('../src/services/shift-history.service').resolveShiftForDate };
});
afterEach(() => { Object.assign(d365, { getAll: orig.ga, getList: orig.gl, create: orig.cr, update: orig.up, delete: orig.del }); Object.assign(leaveEngine, { readLedger: orig.rl, getBalance: orig.gb, addLedgerEntry: orig.add }); scanner.activeEmployees = orig.ae; const ll = require('../src/services/late-login.service'); ll.existingLateFor = orig.ex; ll.reversePunchAutoRecord = orig.rev; require('../src/services/shift-history.service').resolveShiftForDate = orig.rs; });

function stub({ ledgerRows = [], punchesByEmp = {}, activeByKey = {}, employees = [], balances = {} } = {}) {
  const writes = [];
  d365.create = async (...a) => { writes.push(['create', a[0]]); return {}; };
  d365.update = async (...a) => { writes.push(['update', a[0]]); return {}; };
  d365.delete = async (...a) => { writes.push(['delete', a[0]]); return {}; };
  leaveEngine.addLedgerEntry = async (...a) => { writes.push(['ledger', a]); return {}; };
  d365.getAll = async () => ({ data: ledgerRows.filter(r => /^PERMISSION_CL_/.test(r.hr_reason)), count: ledgerRows.length });
  d365.getList = async (entity, opts) => {
    if (entity === d365.constructor.entities.attendance) {
      const id = (String(opts.filter || '').match(/_hr_hremployee_value eq '([^']+)'/) || [])[1];
      const p = punchesByEmp[id];
      return { data: p ? [{ hr_date: NOV, hr_allpunches: JSON.stringify(p) }] : [] };
    }
    return { data: [] };
  };
  leaveEngine.readLedger = async () => ledgerRows.slice();
  leaveEngine.getBalance = async (id) => ({ casual: { remaining: balances[id] != null ? balances[id] : 5 } });
  scanner.activeEmployees = async () => employees;
  require('../src/services/shift-history.service').resolveShiftForDate = async () => ({ start: '09:00', end: '18:00', grace: 5 });
  const ll = require('../src/services/late-login.service');
  ll.existingLateFor = async (empId, date, type) => activeByKey[`${type}:${empId}:${date}`] || null;
  ll.reversePunchAutoRecord = async (...a) => { writes.push(['reverseAuto', a]); return { reversed: true }; };
  return { writes };
}

test('report generation performs ZERO writes (no ledger/create/update/delete/reverse)', async () => {
  const H = stub({
    ledgerRows: [penalty('A'), penalty('B')],
    punchesByEmp: { A: ['09:03', '18:00'], B: ['09:30', '18:00'] },   // A on-time orphan, B still-late orphan
    activeByKey: {},
    employees: [{ hr_hremployeeid: 'A', hr_hremployee1: 'Amy' }, { hr_hremployeeid: 'B', hr_hremployee1: 'Ben' }],
    balances: { A: -1, B: 2 },
  });
  const rep = await integrity.buildReport({ from: '2026-11-01', to: '2026-11-30' });
  assert.strictEqual(H.writes.length, 0, 'the report wrote nothing');
  assert.strictEqual(rep.readOnly, true);
});

test('categories: legacy CL penalties (from dry-run) + negative balance; run-history reflects store', async () => {
  stub({
    ledgerRows: [penalty('A'), penalty('B')],   // legacy residual CL for A and B
    employees: [{ hr_hremployeeid: 'A', hr_hremployee1: 'Amy' }, { hr_hremployeeid: 'B', hr_hremployee1: 'Ben' }, { hr_hremployeeid: 'C', hr_hremployee1: 'Cid' }],
    balances: { A: 5, B: 2, C: -0.5 },
  });
  const rep = await integrity.buildReport({ from: '2026-11-01', to: '2026-11-30' });
  // A & B = legacy_penalty_requires_review (action); C = negative balance (action).
  assert.ok(rep.findings.some(f => f.category === 'legacy_penalty_requires_review' && f.employeeId === 'A' && f.needsAction === true));
  assert.ok(rep.findings.some(f => f.category === 'legacy_penalty_requires_review' && f.employeeId === 'B'));
  assert.ok(rep.findings.some(f => f.category === 'negative_cl_balance' && f.employeeId === 'C' && f.currentBalance === -0.5));
  assert.strictEqual(rep.runHistory.available, false);   // disabled in this suite's env
  assert.strictEqual(rep.balances.available, true);
  assert.ok(rep.summary.byCategory.legacy_penalty_requires_review >= 2);
});

test('an already-net-zero legacy event is NOT flagged (no residual)', async () => {
  stub({ ledgerRows: [penalty('A'), { hr_reason: PP.clReversalReason('late_login', 'A', NOV), hr_days: '0.5' }], employees: [{ hr_hremployeeid: 'A', hr_hremployee1: 'Amy' }], balances: { A: 5 } });
  const rep = await integrity.buildReport({ from: '2026-11-01', to: '2026-11-30' });
  assert.ok(!rep.findings.some(f => f.category === 'legacy_penalty_requires_review'), 'zero-net event not flagged');
});

test('category filter and pagination', async () => {
  stub({ ledgerRows: [penalty('A'), penalty('B'), penalty('C')], employees: [], balances: {} });
  const filtered = await integrity.buildReport({ from: '2026-11-01', to: '2026-11-30', category: 'legacy_penalty_requires_review', includeBalances: false });
  assert.ok(filtered.findings.every(f => f.category === 'legacy_penalty_requires_review'));
  const paged = await integrity.buildReport({ from: '2026-11-01', to: '2026-11-30', category: 'legacy_penalty_requires_review', pageSize: 2, page: 1, includeBalances: false });
  assert.strictEqual(paged.findings.length, 2);
  assert.strictEqual(paged.totalFindings, 3);
});

test('balance scan skipped (documented) when active-employee count exceeds the cap', async () => {
  const many = Array.from({ length: integrity.BALANCE_SCAN_EMPLOYEE_CAP + 1 }, (_, i) => ({ hr_hremployeeid: 'E' + i, hr_hremployee1: 'x' }));
  stub({ ledgerRows: [], employees: many });
  const rep = await integrity.buildReport({ from: '2026-11-01', to: '2026-11-30' });
  assert.strictEqual(rep.balances.available, false);
  assert.match(rep.balances.note, /exceeds the .* cap/);
});
