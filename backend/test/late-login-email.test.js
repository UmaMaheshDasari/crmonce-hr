/**
 * Late Login (manual request) — now an INFORMATION record, NOT an approval workflow.
 *   • Submission → information-only HR email (no Approve/Reject, no token), FROM the
 *     employee's own mailbox.
 *   • Daily verification job → if the employee checked in, mark 'completed'; else mark
 *     'absent_leave_required' and email the employee to apply Leave (deduped by ledger).
 *
 * Microsoft Graph is never contacted (mock transport). No live data.
 */
process.env.NODE_ENV = 'test';
process.env.EMAIL_DRY_RUN = 'true';
process.env.TENANT_MAIL_DOMAINS = 'crmonce.com';
process.env.AZURE_CLIENT_ID = process.env.AZURE_CLIENT_ID || 'test-client';
process.env.AZURE_CLIENT_SECRET = process.env.AZURE_CLIENT_SECRET || 'test-secret';
process.env.AZURE_TENANT_ID = process.env.AZURE_TENANT_ID || 'test-tenant';

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const notif = require('../src/services/notification.service');
const ledger = require('../src/services/notification-ledger.service');
const T = require('../src/services/email/templates');
const lateLogin = require('../src/services/late-login.service');
const d365 = require('../src/services/d365.service');

const LATE = d365.constructor.entities.lateLogin;
const ATT = d365.constructor.entities.attendance;
const EMP = d365.constructor.entities.employee;

const recipientsOf = (r) => [...r.body.message.toRecipients, ...r.body.message.ccRecipients].map(x => x.emailAddress.address);
const hasButtons = (html) => /action=(approved|rejected)|>Approve<|>Reject</.test(html);

// In-memory ledger store (mirrors the Dataverse key semantics) for dedup assertions.
function memStore() {
  const rows = [];
  const key = (e, d, t) => `${e}|${String(d ?? '').slice(0, 10)}|${t}`;
  return {
    rows,
    async hasSent(e, d, t) { return rows.some(r => r.k === key(e, d, t) && r.status === 'sent'); },
    async record(rec) { rows.push({ k: key(rec.employeeId, rec.date, rec.type), ...rec }); },
  };
}

const payrollSettings = require('../src/services/payroll-settings.service');
let orig;
beforeEach(() => {
  orig = { gio: d365.getByIdOptional, gl: d365.getList, glo: d365.getListOptional, up: d365.update, cr: d365.create, ps: payrollSettings.getResolved };
  notif.clearOutbox();
  notif.setTransport(() => {});
});
afterEach(() => {
  d365.getByIdOptional = orig.gio; d365.getList = orig.gl; d365.getListOptional = orig.glo; d365.update = orig.up; d365.create = orig.cr;
  payrollSettings.getResolved = orig.ps;
  notif.resetTransport(); notif.clearOutbox(); ledger.setStore(null);
});

// Stub every dependency create() touches; returns the array of payloads written.
function stubCreate({ existingForDate = false, shiftStart = '16:30', monthCount = 0 } = {}) {
  payrollSettings.getResolved = async () => ({ lateLogin: { maxPerMonth: 3, backdatedDays: 30, allowFuture: false, attendanceMode: 'late_present' } });
  const created = [];
  d365.getByIdOptional = async (entity) => (entity === EMP
    ? { hr_hremployeeid: 'E1', hr_shiftstarttime: shiftStart, hr_email: 'v@crmonce.com', hr_hremployee1: 'Vishwesh', hr_employeeid: 'EMP1039' } : {});
  d365.getList = async (entity, opts) => {
    const flt = String(opts?.filter || '');
    if (entity === LATE && /ne 'cancelled'/.test(flt)) return { data: existingForDate ? [{ hr_lateloginid: 'X', hr_status: 'submitted' }] : [] };  // duplicate check
    if (entity === LATE) return { data: Array.from({ length: monthCount }, () => ({ hr_status: 'submitted' })) };                                      // monthlyCount
    if (entity === EMP) return { data: [{ hr_email: 'hr@crmonce.com' }] };                                                                            // hrEmails
    return { data: [] };
  };
  d365.create = async (_e, payload) => { created.push(payload); return { hr_lateloginid: 'NEW1' }; };
  return created;
}
const TODAY = new Date().toISOString().slice(0, 10);

// ── Templates (pure, no network) ────────────────────────────────────────────
test('lateLoginInfo template: Shift Start / Late Login labels, hours+minutes late-by, no buttons', () => {
  const { subject, html } = T.lateLoginInfo({
    employeeName: 'Boina Vishwesh', employeeId: 'E1', department: 'Engineering',
    date: '14 August 2026', expectedTime: '09:00 AM', actualTime: '11:30 AM', lateBy: 150, reason: 'Bank work', remarks: 'nil',
  });
  assert.strictEqual(subject, 'Late Login Information - Boina Vishwesh - 14 August 2026');
  assert.match(html, /Dear HR/);
  assert.match(html, /Boina Vishwesh/);
  assert.match(html, /E1/);                          // employee id
  assert.match(html, /Shift Start Time/);            // renamed field
  assert.match(html, /Late Login Time/);             // renamed field
  assert.match(html, /09:00 AM/);                    // shift start
  assert.match(html, /11:30 AM/);                    // late login
  assert.match(html, /2 hours 30 minutes/);          // late by (150 min → hours+minutes)
  assert.match(html, /Bank work/);                   // reason (full)
  assert.match(html, /No approval is required/i);
  assert.strictEqual(hasButtons(html), false);       // NO approve/reject
});

// ── create(): duplicate prevention, time validation, status, AM/PM ──────────
test('duplicate: an existing active Late Login for the same employee+date is rejected (409)', async () => {
  stubCreate({ existingForDate: true });
  await assert.rejects(
    () => lateLogin.create({ employeeId: 'E1', employeeName: 'V', date: TODAY, expectedTime: '16:30', actualTime: '18:30', reason: 'x' }),
    (e) => e.status === 409 && /already exists for this date/i.test(e.message),
  );
});

test('different employee, same date → allowed (duplicate guard is per employee)', async () => {
  const created = stubCreate({ existingForDate: false });   // no record for THIS employee
  const r = await lateLogin.create({ employeeId: 'E2', employeeName: 'Other', date: TODAY, expectedTime: '16:30', actualTime: '18:30', reason: 'x' });
  assert.strictEqual(r.record.status, 'submitted');
  assert.strictEqual(created.length, 1);
});

test('same employee, different date → allowed', async () => {
  const created = stubCreate({ existingForDate: false });
  await lateLogin.create({ employeeId: 'E1', employeeName: 'V', date: TODAY, expectedTime: '16:30', actualTime: '18:30', reason: 'x' });
  assert.strictEqual(created.length, 1);
});

test('Late Login BEFORE shift start → 400 "must be later than Shift Start Time"', async () => {
  stubCreate({ shiftStart: '16:30' });   // shift 4:30 PM
  await assert.rejects(
    () => lateLogin.create({ employeeId: 'E1', employeeName: 'V', date: TODAY, expectedTime: '16:30', actualTime: '11:30', reason: 'x' }),  // 11:30 AM
    (e) => e.status === 400 && /later than Shift Start Time/i.test(e.message),
  );
});

test('Late Login AFTER shift start → allowed; status=submitted; shift start is server-resolved', async () => {
  const created = stubCreate({ shiftStart: '16:30' });
  const r = await lateLogin.create({ employeeId: 'E1', employeeName: 'V', date: TODAY, expectedTime: 'ignored', actualTime: '18:30', reason: 'x' });
  assert.strictEqual(r.record.status, 'submitted');
  assert.strictEqual(created[0].hr_expectedtime, '16:30', 'shift start comes from the shift config, not the client');
  assert.ok(!('hr_managerstatus' in created[0]) || created[0].hr_managerstatus === '', 'no approval state');
});

test('AM/PM preserved: a 11:30 PM late login is stored as 23:30 (not 11:30)', async () => {
  const created = stubCreate({ shiftStart: '16:30' });
  await lateLogin.create({ employeeId: 'E1', employeeName: 'V', date: TODAY, expectedTime: '16:30', actualTime: '23:30', reason: 'x' });
  assert.strictEqual(created[0].hr_actualtime, '23:30', 'PM value kept as 24h 23:30');
});

test('resolveShiftStart: reads the employee shift start (Attendance source of truth), never hardcoded 09:00', async () => {
  const origGio = d365.getByIdOptional;
  try {
    d365.getByIdOptional = async () => ({ hr_hremployeeid: 'E1', hr_shiftstarttime: '11:30', hr_shiftendtime: '20:30' });
    assert.strictEqual(await lateLogin.resolveShiftStart('E1'), '11:30');
    // No shift configured → the configured default shift (GENERAL 09:00), not a frontend hardcode.
    d365.getByIdOptional = async () => ({ hr_hremployeeid: 'E2' });
    assert.strictEqual(await lateLogin.resolveShiftStart('E2'), '09:00');
  } finally { d365.getByIdOptional = origGio; }
});

test('lateLoginLeaveRequired template: guidance to apply Leave — no buttons', () => {
  const { subject, html } = T.lateLoginLeaveRequired({ employeeName: 'Boina Vishwesh', date: '15 August 2026' });
  assert.strictEqual(subject, 'Leave Request Required - 15 August 2026');
  assert.match(html, /no Check-In was recorded/i);
  assert.match(html, /apply for Leave/i);
  assert.strictEqual(hasButtons(html), false);
});

test('policy(): FUTURE dates are always allowed for Late Login (info record), even if the setting is off', async () => {
  const ps = require('../src/services/payroll-settings.service');
  const origResolved = ps.getResolved;
  try {
    ps.getResolved = async () => ({ lateLogin: { graceMinutes: 5, maxPerMonth: 3, backdatedDays: 30, allowFuture: false, attendanceMode: 'late_present' } });
    const p = await lateLogin.policy();
    assert.strictEqual(p.allowFuture, true, 'allowFuture is forced true regardless of the stored setting');
    assert.strictEqual(p.maxPerMonth, 3, 'other settings pass through unchanged');
  } finally { ps.getResolved = origResolved; }
});

test('lateByMinutes: actual − expected, no grace subtracted', () => {
  assert.strictEqual(lateLogin.lateByMinutes('09:00', '10:15'), 75);
  assert.strictEqual(lateLogin.lateByMinutes('09:30', '09:42'), 12);
  assert.strictEqual(lateLogin.lateByMinutes('09:00', '09:03'), 3);   // still recorded; not gated away
  assert.strictEqual(lateLogin.lateByMinutes('', ''), null);
});

// ── HR information email: FROM employee mailbox, TO HR, no buttons ──────────
test('emailLateLoginInfoToHR: FROM the employee mailbox, TO HR, information-only', async () => {
  d365.getByIdOptional = async (entity) => (entity === EMP
    ? { hr_email: 'vishwesh@crmonce.com', hr_hremployee1: 'Boina Vishwesh', hr_department: 'ADM', hr_employeeid: 'EMP1039' } : {});
  d365.getList = async (entity) => (entity === EMP
    ? { data: [{ hr_email: 'hr@crmonce.com' }, { hr_email: 'admin@crmonce.com' }] } : { data: [] });

  const sent = [];
  notif.setTransport((req, ctx) => sent.push({ req, ctx }));
  await lateLogin.emailLateLoginInfoToHR({
    employeeId: 'd79c1f3c-4c32-f111-88b5-7ced8daf0197', employeeName: 'Boina Vishwesh', date: '2026-08-14',
    expectedTime: '09:00', actualTime: '10:15', reason: 'Bank work', remarks: '',
  });
  assert.strictEqual(sent.length, 1, 'one HR information email');
  assert.strictEqual(sent[0].req.sender, 'vishwesh@crmonce.com');           // FROM employee mailbox
  assert.deepStrictEqual(recipientsOf(sent[0].req).sort(), ['admin@crmonce.com', 'hr@crmonce.com']);   // TO HR
  assert.strictEqual(sent[0].ctx.meta.type, 'late_login_info');
  assert.strictEqual(hasButtons(sent[0].ctx.html), false);
  assert.match(sent[0].ctx.subject, /^Late Login Information - Boina Vishwesh/);
  assert.match(sent[0].ctx.html, /EMP1039/);                                // HUMAN employee id
  assert.ok(!/d79c1f3c/.test(sent[0].ctx.html), 'the GUID is never shown');
});

test('emailLateLoginInfoToHR: employee without a company mailbox → skipped, no throw', async () => {
  d365.getByIdOptional = async () => ({ hr_email: 'someone@gmail.com', hr_hremployee1: 'X' });
  d365.getList = async () => ({ data: [{ hr_email: 'hr@crmonce.com' }] });
  const sent = [];
  notif.setTransport((req, ctx) => sent.push({ req, ctx }));
  await lateLogin.emailLateLoginInfoToHR({ employeeId: 'E1', employeeName: 'X', date: '2026-08-14', expectedTime: '09:00', actualTime: '10:00', reason: 'r' });
  assert.strictEqual(sent.length, 0, 'external mailbox → nothing sent, submission not broken');
});

// ── Daily verification job ──────────────────────────────────────────────────
function stubForVerify({ status = 'submitted', punches = null } = {}) {
  const updates = [];
  const row = { hr_lateloginid: 'LL1', hr_employeeid: 'E1', hr_employeename: 'Boina Vishwesh', hr_date: '2026-08-15', hr_status: status };
  d365.getListOptional = async (entity) => (entity === LATE ? { data: [row] } : { data: [] });
  d365.getByIdOptional = async (entity) => (entity === EMP ? { hr_email: 'vishwesh@crmonce.com', hr_hremployee1: 'Boina Vishwesh' } : {});
  d365.getList = async (entity) => {
    if (entity === ATT) return { data: punches ? [{ hr_allpunches: JSON.stringify(punches) }] : [] };
    if (entity === EMP) return { data: [{ hr_email: 'hr@crmonce.com' }] };
    return { data: [] };
  };
  d365.update = async (_e, id, patch) => { updates.push({ id, patch }); return {}; };
  return updates;
}

test('verify: employee checked in → record marked completed, NO leave email', async () => {
  ledger.setStore(memStore());
  const updates = stubForVerify({ punches: [{ t: '10:15', d: 'in' }] });
  const sent = [];
  notif.setTransport((req, ctx) => sent.push({ req, ctx }));
  const r = await lateLogin.verifyTodaysAttendance();
  assert.strictEqual(r.attended, 1);
  assert.strictEqual(r.absent, 0);
  assert.deepStrictEqual(updates.map(u => u.patch.hr_status), ['completed']);
  assert.strictEqual(sent.length, 0, 'no leave email when present');
});

test('verify: no check-in → marked absent_leave_required + ONE leave email to employee', async () => {
  ledger.setStore(memStore());
  const updates = stubForVerify({ punches: null });
  const sent = [];
  notif.setTransport((req, ctx) => sent.push({ req, ctx }));
  const r = await lateLogin.verifyTodaysAttendance();
  assert.strictEqual(r.absent, 1);
  assert.deepStrictEqual(updates.map(u => u.patch.hr_status), ['absent_leave_required']);
  assert.strictEqual(sent.length, 1, 'one leave-required email');
  assert.deepStrictEqual(recipientsOf(sent[0].req), ['vishwesh@crmonce.com']);   // TO the employee
  assert.match(sent[0].ctx.subject, /^Leave Request Required/);
  assert.strictEqual(hasButtons(sent[0].ctx.html), false);
});

test('verify: re-run (or a second PM2 worker) → the leave email is NOT sent twice (ledger dedup)', async () => {
  const store = memStore();
  ledger.setStore(store);
  const sent = [];
  notif.setTransport((req, ctx) => sent.push({ req, ctx }));

  stubForVerify({ punches: null });
  await lateLogin.verifyTodaysAttendance();      // worker A
  stubForVerify({ punches: null });              // worker B sees the same (unpunched) day
  await lateLogin.verifyTodaysAttendance();

  assert.strictEqual(sent.length, 1, 'exactly ONE leave email across both runs');
  assert.strictEqual(store.rows.filter(r => r.status === 'sent' && r.type === 'LATE_LOGIN_LEAVE_REQUIRED').length, 1);
});
