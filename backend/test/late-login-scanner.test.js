/**
 * Daily Late Login policy scanner — punch-only detection + request/punch reconciliation +
 * correction reversal (spec §2/§3/§5/§6). Drives the REAL detection util (computeSession) via
 * stubbed attendance records; collaborators (existingLateFor / recordPunchLateEvent /
 * reversePunchAutoRecord / shift / d365) are stubbed. No network.
 */
process.env.NODE_ENV = 'test';
process.env.AZURE_CLIENT_ID = process.env.AZURE_CLIENT_ID || 'x';
process.env.AZURE_CLIENT_SECRET = process.env.AZURE_CLIENT_SECRET || 'x';
process.env.AZURE_TENANT_ID = process.env.AZURE_TENANT_ID || 'x';

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const d365 = require('../src/services/d365.service');
const shiftHistory = require('../src/services/shift-history.service');
const lateLogin = require('../src/services/late-login.service');
const leaveEngine = require('../src/services/leave-engine.service');
const PP = require('../src/services/permission-policy.service');
const scanner = require('../src/services/late-login-scanner.service');

const ATT = d365.constructor.entities.attendance;
const LATE = d365.constructor.entities.lateLogin;
const NOV = '2026-11-10';
const OCT = '2026-10-31';
const SHIFT = { start: '09:00', end: '18:00', grace: 5 };

let orig;
beforeEach(() => {
  orig = { gl: d365.getList, rs: shiftHistory.resolveShiftForDate, ex: lateLogin.existingLateFor, rec: lateLogin.recordPunchLateEvent, rev: lateLogin.reversePunchAutoRecord };
  shiftHistory.resolveShiftForDate = async () => SHIFT;
});
afterEach(() => { d365.getList = orig.gl; shiftHistory.resolveShiftForDate = orig.rs; lateLogin.existingLateFor = orig.ex; lateLogin.recordPunchLateEvent = orig.rec; lateLogin.reversePunchAutoRecord = orig.rev; });

// punchesByEmp: { empId: ['09:30','18:00'] }; existingByEmp: { empId: record|null }
function harness({ punchesByEmp = {}, existingByEmp = {} } = {}) {
  const calls = { recorded: [], reversed: [] };
  d365.getList = async (entity, opts) => {
    if (entity !== ATT) return { data: [] };
    const id = (String(opts.filter || '').match(/_hr_hremployee_value eq '([^']+)'/) || [])[1];
    const punches = punchesByEmp[id];
    return { data: punches ? [{ hr_hrattendanceid: `att-${id}`, hr_date: NOV, hr_allpunches: JSON.stringify(punches) }] : [] };
  };
  lateLogin.existingLateFor = async (empId) => existingByEmp[empId] || null;
  lateLogin.recordPunchLateEvent = async (a) => { calls.recorded.push(a); return { recordId: 'new', status: 'auto_approved', decision: { n: 1 } }; };
  lateLogin.reversePunchAutoRecord = async (r) => { calls.reversed.push(r); return { reversed: true }; };
  return calls;
}
const emps = [{ hr_hremployeeid: 'A', hr_hremployee1: 'Amy' }, { hr_hremployeeid: 'B', hr_hremployee1: 'Ben' }, { hr_hremployeeid: 'C', hr_hremployee1: 'Cid' }, { hr_hremployeeid: 'D', hr_hremployee1: 'Dot' }, { hr_hremployeeid: 'E', hr_hremployee1: 'Eli' }];

test('punch-only late (09:30, no request) → a Late Login event is recorded', async () => {
  const calls = harness({ punchesByEmp: { A: ['09:30', '18:00'] } });
  const s = await scanner.scanDate(NOV, { employees: [emps[0]] });
  assert.strictEqual(s.detected, 1);
  assert.strictEqual(s.created, 1);
  assert.strictEqual(calls.recorded.length, 1);
  assert.strictEqual(calls.recorded[0].employeeId, 'A');
});

test('late punch WITH a matching permission already present → counted once (no new record)', async () => {
  const calls = harness({ punchesByEmp: { B: ['09:30', '18:00'] }, existingByEmp: { B: { hr_lateloginid: 'perm-B', hr_createdby: 'someone' } } });
  const s = await scanner.scanDate(NOV, { employees: [emps[1]] });
  assert.strictEqual(s.detected, 1);
  assert.strictEqual(s.created, 0);
  assert.strictEqual(s.reconciledExisting, 1);
  assert.strictEqual(calls.recorded.length, 0, 'the same event is not double-counted');
});

test('correction to on-time (09:03) with a prior AUTO record → reversed (penalty undone)', async () => {
  const calls = harness({ punchesByEmp: { C: ['09:03', '18:00'] }, existingByEmp: { C: { hr_lateloginid: 'auto-C', hr_createdby: lateLogin.AUTO_CREATED_BY, hr_employeeid: 'C', hr_date: NOV } } });
  const s = await scanner.scanDate(NOV, { employees: [emps[2]] });
  assert.strictEqual(s.detected, 0, 'no longer late');
  assert.strictEqual(s.reversedCorrections, 1);
  assert.strictEqual(calls.reversed.length, 1);
});

test('on-time with an EMPLOYEE-submitted record is NOT auto-reversed', async () => {
  const calls = harness({ punchesByEmp: { C: ['09:03', '18:00'] }, existingByEmp: { C: { hr_lateloginid: 'perm-C', hr_createdby: 'employee' } } });
  const s = await scanner.scanDate(NOV, { employees: [emps[2]] });
  assert.strictEqual(s.reversedCorrections, 0);
  assert.strictEqual(calls.reversed.length, 0, 'never auto-reverse an employee request');
});

test('no attendance record (D) and on-time no-record (E) → nothing recorded', async () => {
  const calls = harness({ punchesByEmp: { E: ['09:00', '18:00'] } });   // D has no record; E on-time
  const s = await scanner.scanDate(NOV, { employees: [emps[3], emps[4]] });
  assert.strictEqual(s.created, 0);
  assert.strictEqual(calls.recorded.length, 0);
});

test('re-run is idempotent: a prior AUTO record for a still-late day → reconciled, no duplicate', async () => {
  const calls = harness({ punchesByEmp: { A: ['09:30', '18:00'] }, existingByEmp: { A: { hr_lateloginid: 'auto-A', hr_createdby: lateLogin.AUTO_CREATED_BY } } });
  const s = await scanner.scanDate(NOV, { employees: [emps[0]] });
  assert.strictEqual(s.created, 0);
  assert.strictEqual(s.reconciledExisting, 1);
  assert.strictEqual(calls.recorded.length, 0, 'second scan does not create a second event');
});

test('pre-effective date (Oct 31) → skipped entirely (no scan, no records)', async () => {
  const calls = harness({ punchesByEmp: { A: ['09:30', '18:00'] } });
  const s = await scanner.scanDate(OCT, { employees: [emps[0]] });
  assert.strictEqual(s.skipped, 'pre_effective');
  assert.strictEqual(calls.recorded.length, 0);
});

test('scanner only ever records LATE LOGIN (never early logout) — recordPunchLateEvent is the only writer', async () => {
  const calls = harness({ punchesByEmp: { A: ['09:30', '16:00'] } });   // also an early-ish logout
  await scanner.scanDate(NOV, { employees: [emps[0]] });
  assert.strictEqual(calls.recorded.length, 1);
  // The scanner has no early-logout path at all; it only calls recordPunchLateEvent (late_login).
  assert.ok(calls.recorded.every(c => !('requestType' in c) || c.requestType === undefined), 'no early_logout request type produced');
});

test('INCOMPLETE attendance (late check-in, no check-out) is NOT recorded by the scanner', async () => {
  const calls = harness({ punchesByEmp: { A: ['09:30'] } });   // single punch → incomplete
  const s = await scanner.scanDate(NOV, { employees: [emps[0]] });
  assert.strictEqual(s.detected, 0);
  assert.strictEqual(calls.recorded.length, 0, 'incomplete day never auto-penalised');
});

test('an existing record for a still-late day is counted once (reconciledExisting) with NO CL write', async () => {
  const origAdd = leaveEngine.addLedgerEntry;
  let ledgerWrites = 0;
  leaveEngine.addLedgerEntry = async () => { ledgerWrites++; return {}; };
  try {
    const calls = harness({ punchesByEmp: { A: ['09:30', '18:00'] }, existingByEmp: { A: { hr_lateloginid: 'auto-A', hr_createdby: lateLogin.AUTO_CREATED_BY, hr_status: 'auto_approved', hr_employeeid: 'A', hr_date: NOV } } });
    const s = await scanner.scanDate(NOV, { employees: [emps[0]] });
    assert.strictEqual(s.reconciledExisting, 1);
    assert.strictEqual(calls.recorded.length, 0, 'not re-recorded');
    assert.strictEqual(ledgerWrites, 0, 'revised policy never writes CL from the scanner');
  } finally { leaveEngine.addLedgerEntry = origAdd; }
});

test('a FAILED permission lookup → error counted; nothing recorded or reversed (retried next scan, no false warning)', async () => {
  const calls = harness({ punchesByEmp: { A: ['09:30', '18:00'] } });
  lateLogin.existingLateFor = async () => { throw new Error('dataverse 503'); };   // lookup is ambiguous/failed
  const s = await scanner.scanDate(NOV, { employees: [emps[0]] });
  assert.strictEqual(s.errors, 1, 'surfaced as an error for retry');
  assert.strictEqual(s.created, 0);
  assert.strictEqual(calls.recorded.length, 0, 'no punch event recorded → no no-request warning on incomplete info');
  assert.strictEqual(calls.reversed.length, 0);
});

test('existingLateFor matches ONLY the same date → an unrelated-date request does not suppress a new event', async () => {
  // Not using harness(): exercise the REAL existingLateFor against a date-aware d365 stub.
  d365.getList = async (entity, opts) => {
    const f = String(opts.filter || '');
    if (entity === LATE && f.includes(`hr_date eq '${NOV}'`)) return { data: [{ hr_lateloginid: 'req', hr_status: 'auto_approved', hr_createdby: 'employee' }] };
    return { data: [] };   // any other date → no match
  };
  const match = await lateLogin.existingLateFor('A', NOV, 'late_login');
  const other = await lateLogin.existingLateFor('A', '2026-11-25', 'late_login');
  assert.ok(match && match.hr_lateloginid === 'req', 'a same-date request is matched (counted once)');
  assert.strictEqual(other, null, 'a request on a different date does NOT match → a warning would not be wrongly suppressed');
});

test('existingLateFor strict mode rethrows on a lookup failure (so callers can avoid a false warning)', async () => {
  d365.getList = async () => { throw new Error('boom'); };
  assert.strictEqual(await lateLogin.existingLateFor('A', NOV, 'late_login'), null, 'non-strict swallows → null');
  await assert.rejects(() => lateLogin.existingLateFor('A', NOV, 'late_login', { strict: true }), /boom/);
});

test('resolveWindow: default 3, clamped to [1,31], NaN-safe (no excessive/invalid window)', () => {
  assert.strictEqual(scanner.resolveWindow(undefined), 3);
  assert.strictEqual(scanner.resolveWindow(5), 5);
  assert.strictEqual(scanner.resolveWindow(0), 1);
  assert.strictEqual(scanner.resolveWindow(-10), 1);
  assert.strictEqual(scanner.resolveWindow(99999), scanner.MAX_SCAN_WINDOW);
  assert.strictEqual(scanner.resolveWindow('abc'), 3);
  assert.strictEqual(scanner.resolveWindow(4.9), 4);
});
