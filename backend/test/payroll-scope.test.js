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
const { parseEmployeeIds, runGeneration } = payrollRouter;

const E = d365.constructor.entities;
const PAYROLL = E.payroll;
const EMP = '11111111-1111-1111-1111-111111111111';
const EMP2 = '22222222-2222-2222-2222-222222222222';
const DRAFT = toValue('hr_payroll_status', 'draft');
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
    gl: d365.getListOptional, gb: d365.getByIdOptional, g: d365.getList, c: d365.create, u: d365.update,
    ps: payrollSettings.getResolved, slabs: ptMaster.loadActiveSlabs, pt: ptMaster.getProfessionalTax,
    st: salaryStructure.getActiveStructure, adv: advanceService.applyMonthlyRecovery,
    split: leaveEngine.splitMonthLeave, bal: leaveEngine.getBalance, pend: leaveEngine.pendingMonthDays,
    rec: activity.record, co: company.getCompany,
  };

  d365.getListOptional = async (entity, params) => {
    calls.push({ entity, params });
    if (entity === E.employee) return { data: [EMPLOYEE_ROW], count: 1 };
    if (entity === PAYROLL) {
      const f = String(params.filter || '');
      const rows = f
        ? payrollRows.filter((r) => f.includes(`_hr_hremployee_value eq '${r._hr_hremployee_value}'`))
        : payrollRows.slice();
      const releasedOnly = f.includes(`hr_status eq ${RELEASED}`);
      return { data: releasedOnly ? rows.filter((r) => String(r.hr_status) === String(RELEASED)) : rows, count: rows.length };
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
  advanceService.applyMonthlyRecovery = async () => 0;
  leaveEngine.splitMonthLeave = async () => ({ paidLeaveDays: 0, lopLeaveDays: 0 });
  leaveEngine.getBalance = async () => ({ casual: { remaining: 0 }, sick: { remaining: 0 }, earned: { used: 0 }, compOff: { balance: 0 } });
  leaveEngine.pendingMonthDays = async () => 0;
  activity.record = () => {};
  company.getCompany = async () => ({ hr_name: 'Crmonce HR', hr_gstin: '', hr_cin: '', hr_addressline: 'Test', hr_email: 'hr@crmonce.com', hr_website: 'crmonce.com' });
});

afterEach(() => {
  Object.assign(d365, { getListOptional: saved.gl, getByIdOptional: saved.gb, getList: saved.g, create: saved.c, update: saved.u });
  payrollSettings.getResolved = saved.ps;
  ptMaster.loadActiveSlabs = saved.slabs; ptMaster.getProfessionalTax = saved.pt;
  salaryStructure.getActiveStructure = saved.st;
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

test('release lifecycle: PATCH /:id/release flips the status → the employee can now see the payslip', async () => {
  currentUser = HR;
  payrollRows = [draftRow('row-draft')];
  const res = await fetch(`${base}/payroll/row-draft/release`, { method: 'PATCH' });
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
