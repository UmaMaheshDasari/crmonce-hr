/**
 * Payroll access control + single-employee generation (real payrollRouter over HTTP).
 *
 * Locks the four guarantees the payroll review flagged:
 *   1. Employee visibility — the employee list is self-scoped AND released-only
 *      (`hr_status eq paid`); draft/approved rows are invisible until HR releases.
 *   2. Payslip endpoints — an employee cannot fetch someone else's row (403) nor
 *      an unreleased one (403); once released it is served.
 *   3. Single-employee generation — `employeeIds: [<guid>]` narrows the run to
 *      exactly that employee (the employee-fetch filter is GUID-scoped). A
 *      malformed selection is REJECTED 400 (never silently widened to "everyone"),
 *      and omitting it keeps the unchanged bulk (all-active) behaviour.
 *   4. Duplicate prevention — an existing DRAFT row is UPDATED in place; approved/
 *      released and locked rows are skipped, never overwritten or duplicated.
 *
 * No network: d365 / payrollSettings / ptMaster / salaryStructure / advance /
 * leaveEngine / activity / company are stubbed (mirrors document-upload.test.js).
 */
process.env.NODE_ENV = 'test';
process.env.AZURE_CLIENT_ID = process.env.AZURE_CLIENT_ID || 'test-client';
process.env.AZURE_CLIENT_SECRET = process.env.AZURE_CLIENT_SECRET || 'test-secret';
process.env.AZURE_TENANT_ID = process.env.AZURE_TENANT_ID || 'test-tenant';

const { test, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const express = require('express');
const d365 = require('../src/services/d365.service');
const { toValue } = require('../src/services/picklist');
const payrollSettings = require('../src/services/payroll-settings.service');
const ptMaster = require('../src/services/pt-master.service');
const salaryStructure = require('../src/services/salary-structure.service');
const advanceService = require('../src/services/advance.service');
const leaveEngine = require('../src/services/leave-engine.service');
const activity = require('../src/services/activity.service');
const company = require('../src/services/company.service');
const payrollRouter = require('../src/modules/payroll/payroll.routes');
const { parseEmployeeIds, runGeneration, finalizeMonth } = payrollRouter;

const E = d365.constructor.entities;
const PAYROLL = E.payroll;
const EMP = '11111111-1111-1111-1111-111111111111';
const EMP2 = '22222222-2222-2222-2222-222222222222';
const DRAFT = toValue('hr_payroll_status', 'draft');
const PROCESSED = toValue('hr_payroll_status', 'processed');
const RELEASED = toValue('hr_payroll_status', 'paid');
const ACTIVE = toValue('hr_employee_status', 'active');
const EMPLOYEE_ROW = { hr_hremployeeid: EMP, hr_hremployee1: 'Test Emp', hr_ptstate: 'Karnataka' };
const STRUCTURE = { id: 'ss-1', effectiveFrom: '2026-01-01', basic: 30000, hra: 10000, special: 0, medical: 0, conveyance: 0, otherAllowance: 0, pfApplicable: true, pfAmount: 1800, professionalTax: 0, incomeTax: 0, otherDeductions: 0 };
const HR = { id: 'hr-guid', role: 'hr_manager', name: 'HR Manager' };
const EMPLOYEE = { id: EMP, role: 'employee', name: 'Test Emp' };

const draftRow = (id = 'row-draft') => ({
  hr_hrpayrollid: id, hr_month: 11, hr_year: 2026, hr_basic: 30000, hr_hra: 10000, hr_allowances: 0,
  hr_deductions: 0, hr_gross: 40000, hr_netpay: 38200, hr_pf: 1800, hr_professionaltax: 200,
  hr_status: DRAFT, hr_locked: 'false', _hr_hremployee_value: EMP,
});

let server, base, currentUser;
let calls, created, updates, payrollRows, payrollById, saved;

const empCall = () => calls.filter((c) => c.entity === E.employee).pop();

before(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.user = currentUser; next(); });
  app.use('/payroll', payrollRouter);
  // Same JSON error contract as server.js (so a failure surfaces err.message).
  app.use((err, req, res, next) => { res.status(err.status || 500).json({ error: err.message || 'Internal server error' }); });   // eslint-disable-line no-unused-vars
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server?.close(); });

beforeEach(() => {
  calls = []; created = []; updates = []; payrollRows = []; payrollById = {};
  saved = {
    gl: d365.getListOptional, gb: d365.getByIdOptional, g: d365.getList, ga: d365.getAll, c: d365.create, u: d365.update,
    ps: payrollSettings.getResolved, slabs: ptMaster.loadActiveSlabs, pt: ptMaster.getProfessionalTax,
    st: salaryStructure.getActiveStructure, sts: salaryStructure.getActiveStructureStrict, adv: advanceService.applyMonthlyRecovery,
    split: leaveEngine.splitMonthLeave, bal: leaveEngine.getBalance, pend: leaveEngine.pendingMonthDays,
    rec: activity.record, co: company.getCompany,
  };

  d365.getListOptional = async (entity, params) => {
    calls.push({ entity, params });
    if (entity === E.employee) return { data: [EMPLOYEE_ROW], count: 1 };
    if (entity === PAYROLL) {
      const f = String(params.filter || '');
      let rows = payrollRows.slice();
      if (/_hr_hremployee_value eq '/.test(f)) rows = rows.filter((r) => f.includes(`_hr_hremployee_value eq '${r._hr_hremployee_value}'`));
      if (f.includes(`hr_status eq ${RELEASED}`)) rows = rows.filter((r) => String(r.hr_status) === String(RELEASED));
      if (f.includes(`hr_status eq ${DRAFT}`)) rows = rows.filter((r) => String(r.hr_status) === String(DRAFT));   // finalizeMonth draft filter
      return { data: rows, count: rows.length };
    }
    return { data: [] };
  };
  d365.getByIdOptional = async (entity, id) => {
    calls.push({ entity, id });
    if (entity === PAYROLL) return payrollById[id];
    if (entity === E.employee) return { hr_hremployeeid: id, hr_hremployee1: 'Test Emp', hr_email: 'emp@test.com', hr_department: 'Eng', hr_designation: 'Dev' };
    return {};
  };
  d365.getList = async () => ({ data: [] });   // attendance: none this month (warning only)
  // Bulk month-release pages through getAll — emulate it over payrollRows (month filter only).
  d365.getAll = async (entity, params) => {
    calls.push({ entity, params, all: true });
    if (entity === PAYROLL) return { data: payrollRows.slice(), count: payrollRows.length };
    return { data: [], count: 0 };
  };
  d365.create = async (entity, data) => { created.push(data); return { hr_hrpayrollid: `new-${created.length}` }; };
  d365.update = async (entity, id, data) => {
    updates.push({ id, data });
    const row = payrollRows.find((r) => r.hr_hrpayrollid === id) || payrollById[id];
    if (row) Object.assign(row, data);
    return {};
  };

  // Legacy day-based rules month (effectiveDate in the future) → no monthly-balance branch.
  payrollSettings.getResolved = async () => ({ ...payrollSettings.resolve(null), attendanceRules: { effectiveDate: '2100-01-01' } });
  ptMaster.loadActiveSlabs = async () => [{ id: 'pt-1' }];
  ptMaster.getProfessionalTax = async () => 200;
  salaryStructure.getActiveStructure = async () => STRUCTURE;
  salaryStructure.getActiveStructureStrict = async () => STRUCTURE;   // approve/release gate uses the strict resolver
  advanceService.applyMonthlyRecovery = async () => 0;
  leaveEngine.splitMonthLeave = async () => ({ paidLeaveDays: 0, lopLeaveDays: 0 });
  leaveEngine.getBalance = async () => ({ casual: { remaining: 0 }, sick: { remaining: 0 }, earned: { used: 0 }, compOff: { balance: 0 } });
  leaveEngine.pendingMonthDays = async () => 0;
  activity.record = () => {};
  company.getCompany = async () => ({ hr_name: 'Crmonce HR', hr_gstin: '', hr_cin: '', hr_addressline: 'Test', hr_email: 'hr@crmonce.com', hr_website: 'crmonce.com' });
});

afterEach(() => {
  Object.assign(d365, { getListOptional: saved.gl, getByIdOptional: saved.gb, getList: saved.g, getAll: saved.ga, create: saved.c, update: saved.u });
  payrollSettings.getResolved = saved.ps;
  ptMaster.loadActiveSlabs = saved.slabs; ptMaster.getProfessionalTax = saved.pt;
  salaryStructure.getActiveStructure = saved.st;
  salaryStructure.getActiveStructureStrict = saved.sts;
  advanceService.applyMonthlyRecovery = saved.adv;
  Object.assign(leaveEngine, { splitMonthLeave: saved.split, getBalance: saved.bal, pendingMonthDays: saved.pend });
  activity.record = saved.rec;
  company.getCompany = saved.co;
});

// ── parseEmployeeIds: the selection contract (never silently widens the run) ──
test('parseEmployeeIds: absent → bulk generation for ALL active employees (ids: null)', () => {
  assert.deepStrictEqual(parseEmployeeIds(undefined), { ok: true, ids: null });
  assert.deepStrictEqual(parseEmployeeIds(null), { ok: true, ids: null });
});

test('parseEmployeeIds: a single GUID is accepted and de-duplicated', () => {
  assert.deepStrictEqual(parseEmployeeIds([EMP]), { ok: true, ids: [EMP] });
  assert.deepStrictEqual(parseEmployeeIds([EMP, EMP, EMP]), { ok: true, ids: [EMP] });
});

test('parseEmployeeIds: malformed selections are REJECTED 400 (an id can only narrow, never widen)', () => {
  for (const bad of ['abc', 42, [], [42], ['not-a-guid'], [EMP, '']]) {
    const r = parseEmployeeIds(bad);
    assert.strictEqual(r.ok, false, `expected rejection for ${JSON.stringify(bad)}`);
    assert.strictEqual(r.error.status, 400);
    assert.match(r.error.message, /non-empty array of employee GUIDs/);
  }
});

// ── Employee visibility: self-scoped + released-only ──
test('GET / (employee) is self-scoped AND released-only — drafts stay invisible', async () => {
  currentUser = EMPLOYEE;
  payrollRows = [draftRow('row-draft'), { ...draftRow('row-paid'), hr_status: RELEASED }];
  const res = await fetch(`${base}/payroll`);
  assert.strictEqual(res.status, 200);
  const body = await res.json();
  assert.strictEqual(body.data.length, 1, 'only the RELEASED row is listed');
  assert.strictEqual(body.data[0].hr_status, 'paid', 'labelled picklist value of the released row');
  const payrollCalls = calls.filter((c) => c.entity === PAYROLL);
  assert.ok(payrollCalls.length >= 1);
  assert.match(payrollCalls[0].params.filter, new RegExp(`_hr_hremployee_value eq '${EMP}'`), 'self-scoped');
  assert.match(payrollCalls[0].params.filter, new RegExp(`hr_status eq ${RELEASED}`), 'released-only');
});

test('GET / (HR, no employeeId filter) sees every row — drafts included', async () => {
  currentUser = HR;
  payrollRows = [draftRow('row-draft'), { ...draftRow('row-paid'), hr_status: RELEASED }];
  const body = await (await fetch(`${base}/payroll`)).json();
  assert.strictEqual(body.data.length, 2);
});

// ── Payslip endpoints: self-scope + release gate ──
test('GET /:id/payslip (employee) — someone else\'s row → 403 Access denied', async () => {
  currentUser = EMPLOYEE;
  payrollById = { 'row-x': { ...draftRow('row-x'), hr_status: RELEASED, _hr_hremployee_value: EMP2 } };
  const res = await fetch(`${base}/payroll/row-x/payslip`);
  assert.strictEqual(res.status, 403);
  assert.match((await res.json()).error, /Access denied/i);
});

test('GET /:id/payslip-data (employee, OWN row, NOT released) → 403 not released', async () => {
  currentUser = EMPLOYEE;
  payrollById = { 'row-draft': draftRow('row-draft') };
  const res = await fetch(`${base}/payroll/row-draft/payslip-data`);
  assert.strictEqual(res.status, 403);
  assert.match((await res.json()).error, /not been released yet/i);
});

test('GET /:id/payslip-data (employee, OWN row, RELEASED) → 200 with the payslip model', async () => {
  currentUser = EMPLOYEE;
  payrollById = { 'row-paid': { ...draftRow('row-paid'), hr_status: RELEASED } };
  const res = await fetch(`${base}/payroll/row-paid/payslip-data`);
  assert.strictEqual(res.status, 200);
  const body = await res.json();
  assert.ok(body.meta && body.meta.monthYear, 'payslip model returned');
});

test('release lifecycle: PATCH /:id/release flips an APPROVED row → the employee can now see the payslip', async () => {
  currentUser = HR;
  const row = { ...draftRow('row-approved'), hr_status: PROCESSED };   // Approved, ready to release
  payrollRows = [row];
  payrollById = { 'row-approved': row };                               // release reads the row by id
  const res = await fetch(`${base}/payroll/row-approved/release`, { method: 'PATCH' });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(updates.length, 1);
  assert.strictEqual(updates[0].data.hr_status, RELEASED, 'release stores the paid status');
  // … and that release is exactly what makes it visible to the employee:
  currentUser = EMPLOYEE;
  const body = await (await fetch(`${base}/payroll`)).json();
  assert.strictEqual(body.data.length, 1, 'released payslip now listed for the employee');
});

// ── Single-employee generation (backend already supported one employee) ──
test('POST /generate with employeeIds:[emp] → exactly that employee, one row created, bound to them', async () => {
  currentUser = HR;
  const res = await fetch(`${base}/payroll/generate`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ month: 11, year: 2026, employeeIds: [EMP] }),
  });
  assert.strictEqual(res.status, 200);
  const body = await res.json();
  assert.strictEqual(body.created, 1);
  assert.strictEqual(body.updated, 0);
  assert.strictEqual(empCall().params.filter, `hr_hremployeeid eq '${EMP}'`, 'employee fetch narrowed to the one GUID');
  assert.strictEqual(created.length, 1);
  assert.strictEqual(created[0]['hr_hremployee@odata.bind'], `/hr_hremployees(${EMP})`);
});

test('POST /generate without employeeIds → bulk (ALL active employees) preserved', async () => {
  currentUser = HR;
  const res = await fetch(`${base}/payroll/generate`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ month: 11, year: 2026 }),
  });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(empCall().params.filter, `hr_status eq ${ACTIVE}`, 'legacy all-active filter unchanged');
  assert.strictEqual(created.length, 1);
});

test('POST /generate with a malformed employeeIds selection → 400, nothing written', async () => {
  currentUser = HR;
  const res = await fetch(`${base}/payroll/generate`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ month: 11, year: 2026, employeeIds: ['not-a-guid'] }),
  });
  assert.strictEqual(res.status, 400);
  assert.match((await res.json()).error, /non-empty array of employee GUIDs/);
  assert.strictEqual(created.length, 0);
  assert.strictEqual(updates.length, 0);
});

test('employee role cannot POST /generate (payroll.process is HR-gated)', async () => {
  currentUser = EMPLOYEE;
  const res = await fetch(`${base}/payroll/generate`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ month: 11, year: 2026 }),
  });
  assert.strictEqual(res.status, 403);
});

// ── Duplicate prevention (runGeneration core, also used by Automation) ──
test('runGeneration: an existing DRAFT row is UPDATED in place (no duplicate row created)', async () => {
  payrollRows = [draftRow('row-draft')];
  const r = await runGeneration({ month: 11, year: 2026, employeeIds: [EMP] });
  assert.strictEqual(r.updated, 1);
  assert.strictEqual(r.created, 0);
  assert.strictEqual(updates.length, 1);
  assert.strictEqual(updates[0].id, 'row-draft');
  assert.strictEqual(created.length, 0);
});

test('runGeneration: a RELEASED (finalised) row is skipped — never overwritten, never duplicated', async () => {
  payrollRows = [{ ...draftRow('row-paid'), hr_status: RELEASED }];
  const r = await runGeneration({ month: 11, year: 2026, employeeIds: [EMP] });
  assert.strictEqual(r.skipped, 1);
  assert.strictEqual(r.created + r.updated, 0);
});

test('runGeneration: a LOCKED month is never regenerated', async () => {
  payrollRows = [{ ...draftRow('row-lock'), hr_locked: 'true' }];
  const r = await runGeneration({ month: 11, year: 2026, employeeIds: [EMP] });
  assert.strictEqual(r.locked, 1);
  assert.strictEqual(r.created + r.updated, 0);
});

// ── Release All: partial-failure resilience, accurate counts, safe retry ──
const postReleaseMonth = (body = { month: 11, year: 2026 }) =>
  fetch(`${base}/payroll/release-month`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

test('Release All: one row\'s update fails → batch continues; the failed row is never flipped to paid (so never notified)', async () => {
  currentUser = HR;
  payrollRows = [
    { ...draftRow('p-ok1'), hr_status: PROCESSED },
    { ...draftRow('p-bad'), hr_status: PROCESSED },
    { ...draftRow('p-ok2'), hr_status: PROCESSED },
  ];
  // ONLY the middle row's update throws (a non-missing-property error → not retried/stripped).
  d365.update = async (entity, id, data) => {
    if (id === 'p-bad') throw new Error('Dataverse 500 on update');
    updates.push({ id, data });
    const row = payrollRows.find((r) => r.hr_hrpayrollid === id); if (row) Object.assign(row, data);
    return {};
  };
  const body = await (await postReleaseMonth()).json();
  assert.strictEqual(body.released, 2, 'both good rows released despite the middle failure');
  assert.strictEqual(body.failed, 1);
  assert.strictEqual(body.skippedDrafts, 0);
  assert.strictEqual(body.alreadyPaid, 0);
  // The bad row was NEVER flipped to paid — the notify call is gated behind a successful
  // update, so a failed release can never have notified its employee.
  assert.deepStrictEqual(updates.map((u) => u.id).sort(), ['p-ok1', 'p-ok2']);
  assert.ok(body.failures.some((f) => f.id === 'p-bad' && f.reason === 'update_failed'), 'failure detail names the row + reason');
  assert.ok(!body.failures.some((f) => f.id === 'p-ok1' || f.id === 'p-ok2'), 'successful rows are not in failures');
});

test('Release All: drafts skipped, already-paid counted + left unchanged, only approved released (retry-safe)', async () => {
  currentUser = HR;
  payrollRows = [
    { ...draftRow('paid1'), hr_status: RELEASED },
    { ...draftRow('appr1'), hr_status: PROCESSED },
    { ...draftRow('draft1'), hr_status: DRAFT },
  ];
  const body = await (await postReleaseMonth()).json();
  assert.strictEqual(body.released, 1);
  assert.strictEqual(body.alreadyPaid, 1);
  assert.strictEqual(body.skippedDrafts, 1);
  assert.strictEqual(body.failed, 0);
  assert.deepStrictEqual(updates.map((u) => u.id), ['appr1'], 'the paid and draft rows are never written (re-run = no re-notify)');
});

test('Release All: processes EVERY approved row the paginated helper returns (>5,000, beyond one page)', async () => {
  currentUser = HR;
  const N = 5001;
  payrollRows = Array.from({ length: N }, (_, i) => ({ ...draftRow(`r${i}`), hr_hrpayrollid: `r${i}`, hr_status: PROCESSED }));
  const body = await (await postReleaseMonth()).json();
  assert.strictEqual(body.released, N, 'all 5,001 approved rows released — nothing lost past the 5,000 page cap');
  assert.strictEqual(updates.length, N);
  assert.ok(calls.some((c) => c.all && c.entity === PAYROLL), 'release used the paginated getAll helper, not a single capped page');
});

// ── Single release: state gate (Fix 3) ──
test('Single release: a DRAFT row cannot be released → 409, nothing written', async () => {
  currentUser = HR;
  payrollById = { d1: { ...draftRow('d1'), hr_status: DRAFT } };
  const res = await fetch(`${base}/payroll/d1/release`, { method: 'PATCH' });
  assert.strictEqual(res.status, 409);
  assert.match((await res.json()).error, /approved payroll can be released/i);
  assert.strictEqual(updates.length, 0);
});

test('Single release: an already-PAID row → 409, left unchanged', async () => {
  currentUser = HR;
  payrollById = { pd: { ...draftRow('pd'), hr_status: RELEASED } };
  const res = await fetch(`${base}/payroll/pd/release`, { method: 'PATCH' });
  assert.strictEqual(res.status, 409);
  assert.match((await res.json()).error, /already released/i);
  assert.strictEqual(updates.length, 0);
});

test('Single release: a missing row → 404', async () => {
  currentUser = HR;
  payrollById = {};   // id resolves to undefined
  const res = await fetch(`${base}/payroll/ghost/release`, { method: 'PATCH' });
  assert.strictEqual(res.status, 404);
});

test('Single release: an APPROVED row with an ACTIVE structure still releases → 200 (not over-blocked)', async () => {
  currentUser = HR;
  payrollById = { ok: { ...draftRow('ok'), hr_status: PROCESSED } };   // STRUCTURE stub has no status → active
  const res = await fetch(`${base}/payroll/ok/release`, { method: 'PATCH' });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(updates.length, 1);
  assert.strictEqual(updates[0].data.hr_status, RELEASED);
});

// ── Disabled salary structure gate (Fix 2) — single approve, single release, and bulk ──
test('Disabled structure: cannot approve a draft nor release an approved row → 409; bulk skips them too', async () => {
  currentUser = HR;
  salaryStructure.getActiveStructureStrict = async () => ({ ...STRUCTURE, status: 'disabled' });
  payrollById = {
    'dz-draft': { ...draftRow('dz-draft'), hr_status: DRAFT },
    'dz-appr': { ...draftRow('dz-appr'), hr_status: PROCESSED },
  };
  // Approve a DRAFT whose structure is disabled → 409 BEFORE any payslip email/update.
  const app = await fetch(`${base}/payroll/dz-draft/approve`, { method: 'PATCH' });
  assert.strictEqual(app.status, 409);
  assert.match((await app.json()).error, /disabled/i);
  // Release an APPROVED row whose structure is disabled → 409.
  const rel = await fetch(`${base}/payroll/dz-appr/release`, { method: 'PATCH' });
  assert.strictEqual(rel.status, 409);
  assert.match((await rel.json()).error, /disabled/i);
  assert.strictEqual(updates.length, 0, 'neither endpoint wrote anything');
  // Bulk Release All applies the SAME rule: an approved row with a disabled structure is skipped.
  payrollRows = [{ ...draftRow('dz-appr'), hr_status: PROCESSED }];
  const body = await (await postReleaseMonth()).json();
  assert.strictEqual(body.released, 0);
  assert.strictEqual(body.skippedDisabled, 1);
  assert.strictEqual(updates.length, 0, 'bulk wrote nothing for the disabled-structure row');
});

// ── Single approve: state gate (only a DRAFT may be approved) ──
test('Approve: a DRAFT row is approved → 200, status set to processed', async () => {
  currentUser = HR;
  payrollById = { 'ap-draft': { ...draftRow('ap-draft'), hr_status: DRAFT } };
  // Employee WITHOUT a mailbox → emailPayslip returns early (no PDF build, no network send).
  d365.getByIdOptional = async (entity, id) => {
    calls.push({ entity, id });
    if (entity === PAYROLL) return payrollById[id];
    if (entity === E.employee) return { hr_hremployeeid: id, hr_hremployee1: 'Test Emp' };   // no hr_email
    return {};
  };
  const res = await fetch(`${base}/payroll/ap-draft/approve`, { method: 'PATCH' });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(updates.length, 1);
  assert.strictEqual(updates[0].data.hr_status, PROCESSED, 'draft → processed on approve');
});

test('Approve: an already-APPROVED (processed) row → 409, nothing written', async () => {
  currentUser = HR;
  payrollById = { 'ap-proc': { ...draftRow('ap-proc'), hr_status: PROCESSED } };
  const res = await fetch(`${base}/payroll/ap-proc/approve`, { method: 'PATCH' });
  assert.strictEqual(res.status, 409);
  assert.match((await res.json()).error, /already approved/i);
  assert.strictEqual(updates.length, 0);
});

test('Approve: an already-PAID row → 409, nothing written', async () => {
  currentUser = HR;
  payrollById = { 'ap-paid': { ...draftRow('ap-paid'), hr_status: RELEASED } };
  const res = await fetch(`${base}/payroll/ap-paid/approve`, { method: 'PATCH' });
  assert.strictEqual(res.status, 409);
  assert.match((await res.json()).error, /already released/i);
  assert.strictEqual(updates.length, 0);
});

test('Approve: a missing row → 404', async () => {
  currentUser = HR;
  payrollById = {};   // id resolves to undefined
  const res = await fetch(`${base}/payroll/ap-ghost/approve`, { method: 'PATCH' });
  assert.strictEqual(res.status, 404);
  assert.strictEqual(updates.length, 0);
});

// ── Fail-CLOSED: a salary-structure verification FAILURE must never approve/release on a guess ──
test('Approve: structure verification failure → 503, nothing written', async () => {
  currentUser = HR;
  salaryStructure.getActiveStructureStrict = async () => { throw new Error('Dataverse 500 on lookup'); };
  payrollById = { 'uv-d': { ...draftRow('uv-d'), hr_status: DRAFT } };
  const res = await fetch(`${base}/payroll/uv-d/approve`, { method: 'PATCH' });
  assert.strictEqual(res.status, 503);
  const body = await res.json();
  assert.strictEqual(body.code, 'structure_unverified');
  assert.strictEqual(updates.length, 0);
});

test('Single release: structure verification failure → 503, nothing written', async () => {
  currentUser = HR;
  salaryStructure.getActiveStructureStrict = async () => { throw new Error('Dataverse 500 on lookup'); };
  payrollById = { 'uv-a': { ...draftRow('uv-a'), hr_status: PROCESSED } };
  const res = await fetch(`${base}/payroll/uv-a/release`, { method: 'PATCH' });
  assert.strictEqual(res.status, 503);
  assert.strictEqual((await res.json()).code, 'structure_unverified');
  assert.strictEqual(updates.length, 0);
});

test('Release All: an unverifiable row is counted as FAILED and skipped; the batch continues', async () => {
  currentUser = HR;
  // Verification throws ONLY for the middle employee; others verify fine.
  salaryStructure.getActiveStructureStrict = async (_d, empId) => {
    if (empId === EMP2) throw new Error('Dataverse 500 on lookup');
    return STRUCTURE;
  };
  payrollRows = [
    { ...draftRow('u-ok1'), hr_status: PROCESSED, _hr_hremployee_value: EMP },
    { ...draftRow('u-bad'), hr_status: PROCESSED, _hr_hremployee_value: EMP2 },
    { ...draftRow('u-ok2'), hr_status: PROCESSED, _hr_hremployee_value: EMP },
  ];
  const body = await (await postReleaseMonth()).json();
  assert.strictEqual(body.released, 2, 'the two verifiable rows still release');
  assert.strictEqual(body.failed, 1, 'the unverifiable row is counted as failed');
  assert.strictEqual(body.skippedDisabled, 0);
  assert.ok(body.failures.some((f) => f.id === 'u-bad' && f.reason === 'structure_unverified'));
  assert.deepStrictEqual(updates.map((u) => u.id).sort(), ['u-ok1', 'u-ok2'], 'the unverifiable row was never written');
});

test('finalizeMonth: a draft whose structure cannot be verified is NOT finalised (left a draft)', async () => {
  salaryStructure.getActiveStructureStrict = async () => { throw new Error('Dataverse 500 on lookup'); };
  payrollRows = [{ ...draftRow('fin-uv'), hr_status: DRAFT }];
  const r = await finalizeMonth({ month: 11, year: 2026 });
  assert.strictEqual(r.approved, 0, 'nothing approved');
  assert.strictEqual(r.skippedUnverified, 1);
  assert.strictEqual(updates.length, 0, 'the draft was left untouched');
});
