/**
 * Early Logout + the 2-hour permission window (spec §1–§4). Early Logout reuses the Late
 * Login permission-record flow (same table, hr_requesttype='early_logout') — an INFORMATION
 * record, NO approval, and crucially NO attendance punch is ever inserted or modified.
 *
 * Covers: the pure overnight-safe evaluators; create() for Early Logout under / exactly /
 * over 2 hours; the wrong-side-of-shift guard; overnight shifts; and that submission never
 * writes an attendance record. Pure/mocked — Dataverse is never contacted.
 */
process.env.NODE_ENV = 'test';
process.env.EMAIL_DRY_RUN = 'true';
process.env.TENANT_MAIL_DOMAINS = 'crmonce.com';
process.env.AZURE_CLIENT_ID = process.env.AZURE_CLIENT_ID || 'test-client';
process.env.AZURE_CLIENT_SECRET = process.env.AZURE_CLIENT_SECRET || 'test-secret';
process.env.AZURE_TENANT_ID = process.env.AZURE_TENANT_ID || 'test-tenant';

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const lateLogin = require('../src/services/late-login.service');
const d365 = require('../src/services/d365.service');
const payrollSettings = require('../src/services/payroll-settings.service');

const LATE = d365.constructor.entities.lateLogin;
const ATT = d365.constructor.entities.attendance;
const EMP = d365.constructor.entities.employee;
const TODAY = new Date().toISOString().slice(0, 10);
const LIMIT_MSG = 'Permission is allowed only up to 2 hours. Please apply for leave for a longer duration.';

let orig;
beforeEach(() => { orig = { gio: d365.getByIdOptional, gl: d365.getList, glo: d365.getListOptional, cr: d365.create, ps: payrollSettings.getResolved }; });
afterEach(() => { d365.getByIdOptional = orig.gio; d365.getList = orig.gl; d365.getListOptional = orig.glo; d365.create = orig.cr; payrollSettings.getResolved = orig.ps; });

// Stub everything create() touches. Records EVERY d365.create call (entity + payload) so a
// test can prove NO attendance punch was written. shiftStart/shiftEnd drive the shift window.
function stub({ shiftStart = '09:00', shiftEnd = '18:00' } = {}) {
  payrollSettings.getResolved = async () => ({ lateLogin: { maxPerMonth: 3, backdatedDays: 30, allowFuture: false, attendanceMode: 'late_present' } });
  const creates = [];
  d365.getByIdOptional = async (entity) => (entity === EMP
    ? { hr_hremployeeid: 'E1', hr_shiftstarttime: shiftStart, hr_shiftendtime: shiftEnd, hr_email: 'v@crmonce.com', hr_hremployee1: 'Vishwesh', hr_employeeid: 'EMP1039' } : {});
  d365.getListOptional = async () => ({ data: [] });   // no shift history → falls back to the employee shift
  d365.getList = async () => ({ data: [] });            // dup check / monthlyCount / hrEmails all empty
  d365.create = async (entity, payload) => { creates.push({ entity, payload }); return { hr_lateloginid: 'EL1' }; };
  return creates;
}
const earlyLogout = (actualTime, extra = {}) => lateLogin.create({ employeeId: 'E1', employeeName: 'V', date: TODAY, actualTime, reason: 'personal', requestType: 'early_logout', ...extra });

// ── Pure evaluators (overnight-safe) ─────────────────────────────────────────
test('evaluatePermission — Late Login: on-time=range, ≤2h=ok, >2h=limit', () => {
  const ev = (time) => lateLogin.evaluatePermission({ requestType: 'late_login', shiftStart: '09:00', shiftEnd: '18:00', time });
  assert.strictEqual(ev('09:00').error, 'range');   // not late at all
  assert.strictEqual(ev('09:30').error, null);
  assert.strictEqual(ev('09:30').minutes, 30);
  assert.strictEqual(ev('11:00').error, null);       // exactly 2h → allowed
  assert.strictEqual(ev('11:00').minutes, 120);
  assert.strictEqual(ev('11:01').error, 'limit');    // 2h1m → blocked
});

test('evaluatePermission — Early Logout: at end=range, ≤2h=ok, >2h=limit', () => {
  const ev = (time) => lateLogin.evaluatePermission({ requestType: 'early_logout', shiftStart: '09:00', shiftEnd: '18:00', time });
  assert.strictEqual(ev('18:00').error, 'range');    // not early at all
  assert.strictEqual(ev('17:00').minutes, 60);
  assert.strictEqual(ev('16:00').error, null);       // exactly 2h → allowed
  assert.strictEqual(ev('16:00').minutes, 120);
  assert.strictEqual(ev('15:59').error, 'limit');    // 2h1m → blocked
});

test('evaluatePermission — OVERNIGHT shift 22:00→06:00', () => {
  const late = (t) => lateLogin.evaluatePermission({ requestType: 'late_login', shiftStart: '22:00', shiftEnd: '06:00', time: t });
  const early = (t) => lateLogin.evaluatePermission({ requestType: 'early_logout', shiftStart: '22:00', shiftEnd: '06:00', time: t });
  assert.strictEqual(late('23:30').minutes, 90);         // 90 min late
  assert.strictEqual(late('00:30').minutes, 150);        // after midnight → 2.5h late
  assert.strictEqual(late('00:30').error, 'limit');      // > 2h → blocked
  assert.strictEqual(early('04:00').minutes, 120);       // leaving 04:00, shift ends 06:00 → 2h early (allowed)
  assert.strictEqual(early('04:00').error, null);
  assert.strictEqual(early('03:59').error, 'limit');     // 2h1m early → blocked
});

test('evaluatePermission — midnight & date boundaries', () => {
  const ev = (rt, s, e, t) => lateLogin.evaluatePermission({ requestType: rt, shiftStart: s, shiftEnd: e, time: t });
  // Day shift 09:00–18:00: a 00:00 login is OUTSIDE the shift → range (not "within 2h").
  assert.strictEqual(ev('late_login', '09:00', '18:00', '00:00').error, 'range');
  // Overnight 22:00→06:00: midnight (00:00) is 2h after start → allowed (crosses the date boundary).
  assert.strictEqual(ev('late_login', '22:00', '06:00', '00:00').minutes, 120);
  assert.strictEqual(ev('late_login', '22:00', '06:00', '00:00').error, null);
  // Overnight early logout: leaving 05:00 (next day) when shift ends 06:00 → 1h early (allowed).
  assert.strictEqual(ev('early_logout', '22:00', '06:00', '05:00').minutes, 60);
  // Overnight early logout at midnight → 6h early → blocked.
  assert.strictEqual(ev('early_logout', '22:00', '06:00', '00:00').error, 'limit');
});

test('evaluatePermission — invalid / unparseable times fail OPEN (skipped, never a crash or false block)', () => {
  for (const bad of ['', 'abc', null, undefined, '9am']) {
    const late = lateLogin.evaluatePermission({ requestType: 'late_login', shiftStart: '09:00', shiftEnd: '18:00', time: bad });
    assert.strictEqual(late.skipped, true, `late/${bad} → skipped`);
    assert.strictEqual(late.error, null);
    const early = lateLogin.evaluatePermission({ requestType: 'early_logout', shiftStart: '09:00', shiftEnd: '18:00', time: bad });
    assert.strictEqual(early.skipped, true, `early/${bad} → skipped`);
  }
  // An unresolved shift reference also fails open (never blocks a legit submit on a lookup miss).
  assert.strictEqual(lateLogin.evaluatePermission({ requestType: 'late_login', shiftStart: '', shiftEnd: '', time: '09:30' }).skipped, true);
});

test('permissionMinutes (edit path): overnight-safe forward distance', () => {
  // late-by = START→login; early-by = logout→END.
  assert.strictEqual(lateLogin.permissionMinutes({ requestType: 'late_login', ref: '09:00', time: '10:30' }), 90);
  assert.strictEqual(lateLogin.permissionMinutes({ requestType: 'early_logout', ref: '18:00', time: '16:30' }), 90);
  assert.strictEqual(lateLogin.permissionMinutes({ requestType: 'early_logout', ref: '06:00', time: '04:00' }), 120);  // overnight
});

// ── create(): Early Logout 2-hour rule + record shape ────────────────────────
test('Early Logout 1 hour early → allowed; stored as a permission record (type=early_logout, status=submitted)', async () => {
  const creates = stub({ shiftStart: '09:00', shiftEnd: '18:00' });
  const r = await earlyLogout('17:00');
  assert.strictEqual(r.record.status, 'submitted');
  const payload = creates[0].payload;
  assert.strictEqual(payload.hr_requesttype, 'early_logout');
  assert.strictEqual(payload.hr_expectedtime, '18:00', 'reference time stored is the shift END');
  assert.strictEqual(payload.hr_actualtime, '17:00');
});

test('Early Logout EXACTLY 2 hours early → allowed (boundary inclusive)', async () => {
  const creates = stub({ shiftStart: '09:00', shiftEnd: '18:00' });
  await earlyLogout('16:00');
  assert.strictEqual(creates.length, 1);
});

test('Early Logout 2h 1min early → blocked with the exact leave message (400)', async () => {
  stub({ shiftStart: '09:00', shiftEnd: '18:00' });
  await assert.rejects(() => earlyLogout('15:59'), (e) => e.status === 400 && e.message === LIMIT_MSG);
});

test('Early Logout at/after shift end → 400 "must be earlier than Shift End Time"', async () => {
  stub({ shiftStart: '09:00', shiftEnd: '18:00' });
  await assert.rejects(() => earlyLogout('18:00'), (e) => e.status === 400 && /earlier than Shift End Time/i.test(e.message));
});

test('Early Logout OVERNIGHT (22:00→06:00): 04:00 allowed, 03:59 blocked', async () => {
  const creates = stub({ shiftStart: '22:00', shiftEnd: '06:00' });
  await earlyLogout('04:00');
  assert.strictEqual(creates.length, 1, '2h early on an overnight shift is allowed');
  stub({ shiftStart: '22:00', shiftEnd: '06:00' });
  await assert.rejects(() => earlyLogout('03:59'), (e) => e.status === 400 && e.message === LIMIT_MSG);
});

test('Early Logout submission inserts NO attendance punch (permission record only)', async () => {
  const creates = stub({ shiftStart: '09:00', shiftEnd: '18:00' });
  await earlyLogout('17:00');
  // Every write went to the Late Login table — never the attendance table.
  assert.ok(creates.length >= 1);
  assert.ok(creates.every(c => c.entity === LATE), 'only permission-record writes');
  assert.ok(!creates.some(c => c.entity === ATT), 'no attendance record created');
  const p = creates[0].payload;
  for (const punchField of ['hr_allpunches', 'hr_intime', 'hr_outtime', 'hr_punchcount']) {
    assert.ok(!(punchField in p), `no punch field ${punchField} written`);
  }
});

// ── Late Login unchanged: still an information record, no punch ──────────────
test('Late Login submission also inserts NO attendance punch', async () => {
  const creates = stub({ shiftStart: '09:00', shiftEnd: '18:00' });
  await lateLogin.create({ employeeId: 'E1', employeeName: 'V', date: TODAY, actualTime: '09:45', reason: 'bus' });
  assert.ok(creates.every(c => c.entity === LATE));
  assert.ok(!creates.some(c => c.entity === ATT));
});
