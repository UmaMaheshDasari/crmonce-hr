/**
 * Monthly permission policy — create() integration + manager decision (effective 2026-11-01).
 *
 * The monthly policy applies to EARLY LOGOUT ONLY. Under the revised policy every qualifying
 * early-logout event is auto_approved (NO CL/salary penalty); only the notification stage
 * escalates (4th HR warning, 5th final, 6th+ escalation). LATE LOGIN is information-only and
 * EXEMPT — it is never counted, never auto_approved by the policy, never escalated, never
 * debits CL. Pre-effective dates keep the legacy 'submitted' behaviour. No attendance punch is
 * ever written. d365 + leave engine + notify are stubbed — no network.
 */
process.env.NODE_ENV = 'test';
process.env.EMAIL_DRY_RUN = 'true';
process.env.TENANT_MAIL_DOMAINS = 'crmonce.com';
process.env.AZURE_CLIENT_ID = process.env.AZURE_CLIENT_ID || 'x';
process.env.AZURE_CLIENT_SECRET = process.env.AZURE_CLIENT_SECRET || 'x';
process.env.AZURE_TENANT_ID = process.env.AZURE_TENANT_ID || 'x';

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const d365 = require('../src/services/d365.service');
const payrollSettings = require('../src/services/payroll-settings.service');
const leaveEngine = require('../src/services/leave-engine.service');
const notif = require('../src/services/notification.service');
const lateLogin = require('../src/services/late-login.service');

const LATE = d365.constructor.entities.lateLogin;
const ATT = d365.constructor.entities.attendance;
const EMP = d365.constructor.entities.employee;
const NOV = '2026-11-10';   // post-effective
const OCT = '2026-10-31';   // pre-effective

let orig;
beforeEach(() => {
  orig = {
    gio: d365.getByIdOptional, gl: d365.getList, glo: d365.getListOptional, cr: d365.create, up: d365.update,
    ps: payrollSettings.getResolved, rl: leaveEngine.readLedger, gb: leaveEngine.getBalance, add: leaveEngine.addLedgerEntry,
    se: notif.sendEmail, nu: notif.notifyUser, bc: notif.broadcast,
  };
  notif.sendEmail = async () => ({ success: true });
  notif.notifyUser = () => {}; notif.broadcast = () => {};
});
afterEach(() => {
  d365.getByIdOptional = orig.gio; d365.getList = orig.gl; d365.getListOptional = orig.glo; d365.create = orig.cr; d365.update = orig.up;
  payrollSettings.getResolved = orig.ps; leaveEngine.readLedger = orig.rl; leaveEngine.getBalance = orig.gb; leaveEngine.addLedgerEntry = orig.add;
  notif.sendEmail = orig.se; notif.notifyUser = orig.nu; notif.broadcast = orig.bc;
});

// prior = qualifying events already this month (per type, keyed by requestType in the filter).
function stub({ priorByType = {}, shiftStart = '09:00', shiftEnd = '18:00', clRemaining = 10 } = {}) {
  payrollSettings.getResolved = async () => ({ lateLogin: { maxPerMonth: 3, backdatedDays: 30, allowFuture: true, attendanceMode: 'late_present' } });
  const creates = [], updates = [], ledgerWrites = [];
  d365.getByIdOptional = async (entity) => (entity === EMP
    ? { hr_hremployeeid: 'E1', hr_shiftstarttime: shiftStart, hr_shiftendtime: shiftEnd, hr_email: 'v@crmonce.com', hr_hremployee1: 'Vishwesh', hr_employeeid: 'EMP1039' } : {});
  d365.getListOptional = async () => ({ data: [] });   // no shift history
  d365.getList = async (entity, opts) => {
    const f = String(opts?.filter || '');
    if (entity === LATE && /hr_date eq/.test(f)) return { data: [] };                     // duplicate check → none
    if (entity === LATE && /hr_month eq/.test(f)) {                                       // qualifyingCount (per type)
      const type = (f.match(/hr_requesttype eq '([^']+)'/) || [])[1];
      const n = priorByType[type] || 0;
      return { data: Array.from({ length: n }, () => ({ hr_status: 'auto_approved' })) };
    }
    if (entity === EMP) return { data: [] };                                              // hrEmails
    return { data: [] };
  };
  d365.create = async (entity, payload) => { creates.push({ entity, payload }); return { hr_lateloginid: 'REC1' }; };
  d365.update = async (entity, id, patch) => { updates.push({ entity, id, patch }); return {}; };
  // Leave engine (CL debit path)
  leaveEngine.readLedger = async () => [];
  leaveEngine.getBalance = async () => ({ casual: { remaining: clRemaining } });
  leaveEngine.addLedgerEntry = async (e) => { ledgerWrites.push(e); return {}; };
  return { creates, updates, ledgerWrites };
}
// Early Logout (the policy-tracked type): leaving 17:00 against an 18:00 shift end = 1h early (valid).
const mk = (over = {}) => ({ employeeId: 'E1', employeeName: 'V', date: NOV, actualTime: '17:00', reason: 'r', requestType: 'early_logout', ...over });

// ── Early Logout: the monthly policy applies (revised — every event auto_approved) ──
test('Early Logout 1st event (Nov) → auto_approved', async () => {
  const s = stub({ priorByType: { early_logout: 0 } });
  const r = await lateLogin.create(mk());
  assert.strictEqual(r.record.status, 'auto_approved');
  assert.strictEqual(s.creates[0].payload.hr_status, 'auto_approved');
});

test('Early Logout 2nd event → auto_approved', async () => {
  stub({ priorByType: { early_logout: 1 } });
  const r = await lateLogin.create(mk());
  assert.strictEqual(r.record.status, 'auto_approved');
});

test('Early Logout 3rd event → auto_approved, NO escalation email, NO CL', async () => {
  const s = stub({ priorByType: { early_logout: 2 } });
  const r = await lateLogin.create(mk());
  assert.strictEqual(r.record.status, 'auto_approved');
  assert.ok(!s.creates[0].payload.hr_managerstatus, 'no manager approval under the revised policy');
  assert.strictEqual(r.warning, '', '1st–3rd: no warning email');
  assert.strictEqual(s.ledgerWrites.length, 0, 'never a CL debit');
});

test('Early Logout 4th event → auto_approved + HR warning, NEVER a CL/leave debit', async () => {
  const s = stub({ priorByType: { early_logout: 3 }, clRemaining: 5 });
  const r = await lateLogin.create(mk());
  assert.strictEqual(r.record.status, 'auto_approved');
  assert.strictEqual(s.ledgerWrites.length, 0, 'NO CL deduction at the 4th event');
  assert.match(r.warning, /HR warning/i);
});

test('Early Logout 5th event → auto_approved + FINAL warning, no CL', async () => {
  const s = stub({ priorByType: { early_logout: 4 }, clRemaining: 0 });
  const r = await lateLogin.create(mk());
  assert.strictEqual(r.record.status, 'auto_approved');
  assert.strictEqual(s.ledgerWrites.length, 0);
  assert.match(r.warning, /final warning/i);
});

test('Early Logout 6th event → auto_approved + HR/manager escalation, no CL', async () => {
  const s = stub({ priorByType: { early_logout: 5 } });
  const r = await lateLogin.create(mk());
  assert.strictEqual(r.record.status, 'auto_approved');
  assert.strictEqual(s.ledgerWrites.length, 0);
  assert.match(r.warning, /contact HR or your manager/i);
});

// ── Late Login: EXEMPT — always information-only 'submitted', never the policy ──
test('Late Login is EXEMPT: 1st/2nd/3rd/4th all → submitted, no warning, no CL (count ignored)', async () => {
  for (const prior of [0, 1, 2, 3, 5]) {
    const s = stub({ priorByType: { late_login: prior } });
    const r = await lateLogin.create(mk({ requestType: 'late_login', actualTime: '09:30' }));   // 30 min late (valid)
    assert.strictEqual(r.record.status, 'submitted', `prior=${prior} → submitted`);
    assert.strictEqual(s.creates[0].payload.hr_status, 'submitted');
    assert.strictEqual(r.warning, '', 'no monthly escalation warning for Late Login');
    assert.strictEqual(s.ledgerWrites.length, 0, 'Late Login never debits CL');
  }
});

test('Late Login and Early Logout: only Early Logout is counted/auto-approved', async () => {
  // Late Login already has 5 this month → still 'submitted' (exempt). Early Logout 1st → auto_approved.
  let s = stub({ priorByType: { late_login: 5, early_logout: 0 } });
  const late = await lateLogin.create(mk({ requestType: 'late_login', actualTime: '09:30' }));
  assert.strictEqual(late.record.status, 'submitted', 'Late Login is never auto_approved by the policy');
  s = stub({ priorByType: { late_login: 5, early_logout: 0 } });
  const early = await lateLogin.create(mk({ requestType: 'early_logout', actualTime: '17:00' }));
  assert.strictEqual(early.record.status, 'auto_approved', 'Early Logout is counted/auto-approved independently');
});

test('month boundary: an Oct 31 Early Logout is PRE-effective → legacy submitted (no policy)', async () => {
  const s = stub({ priorByType: { early_logout: 5 } });   // prior count irrelevant pre-effective
  const r = await lateLogin.create(mk({ date: OCT }));
  assert.strictEqual(r.record.status, 'submitted');
  assert.strictEqual(s.ledgerWrites.length, 0, 'no CL debit before the effective date');
});

test('month boundary RESET (Early Logout): Nov has 5 qualifying, but a December event is the 1st', async () => {
  const s = stub({ clRemaining: 10 });
  d365.getList = async (entity, opts) => {
    const f = String(opts?.filter || '');
    if (entity === LATE && /hr_date eq/.test(f)) return { data: [] };                              // dup guard → none
    if (entity === LATE && /hr_month eq '2026-11'/.test(f)) return { data: Array.from({ length: 5 }, () => ({ hr_status: 'auto_approved' })) };
    if (entity === LATE && /hr_month eq '2026-12'/.test(f)) return { data: [] };                   // new month → 0 prior
    return { data: [] };
  };
  const r = await lateLogin.create(mk({ date: '2026-12-05' }));
  assert.strictEqual(r.record.month, '2026-12');
  assert.strictEqual(r.record.status, 'auto_approved');
  assert.strictEqual(r.warning, '', 'the 1st event of the new month → no escalation email (count reset)');
  assert.strictEqual(s.ledgerWrites.length, 0, 'no CL at any count');
});

test('no attendance punch is inserted/modified by any event', async () => {
  const s = stub({ priorByType: { early_logout: 3 }, clRemaining: 5 });
  await lateLogin.create(mk());
  assert.ok(s.creates.every(c => c.entity === LATE), 'only the permission record is created');
  assert.ok(!s.creates.some(c => c.entity === ATT) && !s.updates.some(u => u.entity === ATT), 'attendance entity untouched');
});

test('NO CL is ever written, even at the 4th+ Early Logout and even if a legacy debit row exists', async () => {
  const s = stub({ priorByType: { early_logout: 3 }, clRemaining: 5 });
  leaveEngine.readLedger = async () => [{ hr_reason: require('../src/services/permission-policy.service').clReason('early_logout', 'E1', NOV), hr_days: '-0.5' }];
  const r = await lateLogin.create(mk());
  assert.strictEqual(r.record.status, 'auto_approved');
  assert.strictEqual(s.ledgerWrites.length, 0, 'the policy never debits/reverses CL');
});

test('rejected/cancelled Early Logout events do NOT inflate the count: 2 qualifying + 1 rejected → 3rd (auto, no email), no CL', async () => {
  const s = stub({ clRemaining: 10 });
  d365.getList = async (entity, opts) => {
    const f = String(opts?.filter || '');
    if (entity === LATE && /hr_date eq/.test(f)) return { data: [] };
    if (entity === LATE && /hr_month eq/.test(f)) return { data: [
      { hr_status: 'auto_approved' }, { hr_status: 'auto_approved' }, { hr_status: 'manager_rejected' },
    ] };
    return { data: [] };
  };
  const r = await lateLogin.create(mk());
  assert.strictEqual(r.record.status, 'auto_approved');
  assert.strictEqual(r.warning, '', 'the 3rd has no escalation email; the rejected one did not push it to the 4th');
  assert.strictEqual(s.ledgerWrites.length, 0);
});

// ── Manager decision on a legacy manager_pending record (type-agnostic mechanics) ──
test('managerDecision approve → manager_approved (counts); reject → manager_rejected (does not count)', async () => {
  const row = { hr_lateloginid: 'REC1', hr_employeeid: 'E1', hr_employeename: 'V', hr_status: 'manager_pending', hr_requesttype: 'early_logout', hr_date: NOV };
  const updates = [];
  d365.getByIdOptional = async () => row;
  d365.update = async (_e, _id, patch) => { updates.push(patch); return {}; };
  const a = await lateLogin.managerDecision('REC1', 'approved', { name: 'HR One' });
  assert.strictEqual(a.status, 'manager_approved');
  assert.strictEqual(updates[0].hr_status, 'manager_approved');
  assert.strictEqual(updates[0].hr_managerstatus, 'approved');

  updates.length = 0;
  const rj = await lateLogin.managerDecision('REC1', 'rejected', { name: 'HR One' });
  assert.strictEqual(rj.status, 'manager_rejected');
  assert.strictEqual(require('../src/services/permission-policy.service').isQualifying('manager_rejected'), false);
});

test('managerDecision on a non-pending record → 409', async () => {
  d365.getByIdOptional = async () => ({ hr_lateloginid: 'REC1', hr_status: 'auto_approved', hr_requesttype: 'early_logout', hr_date: NOV });
  await assert.rejects(() => lateLogin.managerDecision('REC1', 'approved', { name: 'HR' }), (e) => e.status === 409);
});
