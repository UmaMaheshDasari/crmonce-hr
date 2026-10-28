/**
 * Automated reminders — Profile/Document completion, Passport deadline, Goal due dates.
 * Pure decision helpers (goalMilestone / monthsBefore / isPassportComplete / dueByInterval) + the three
 * runners, with the notification ledger backed by an in-memory store and the email
 * transport mocked. No network, no Dataverse, no real emails. Routing asserted on the
 * actual Graph payload: From HR@, To employee ONLY, CC info@ only.
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
const notif = require('../src/services/notification.service');
const ledger = require('../src/services/notification-ledger.service');
const profile = require('../src/services/profile.service');
const company = require('../src/services/company.service');
const reminders = require('../src/services/reminder.service');

const toOf = (r) => r.body.message.toRecipients.map(x => x.emailAddress.address);
const ccOf = (r) => r.body.message.ccRecipients.map(x => x.emailAddress.address);
const dstr = (d) => String(d ?? '').slice(0, 10);
const shiftDate = (ds, delta) => { const t = new Date(`${ds}T00:00:00Z`); t.setUTCDate(t.getUTCDate() + delta); return t.toISOString().slice(0, 10); };

// In-memory ledger store (mirrors the Dataverse key semantics) for dedupe + lastSentOn.
function memStore() {
  const rows = [];
  return {
    rows,
    async hasSent(e, d, t) { return rows.some(r => r.employeeId === e && r.date === dstr(d) && r.type === t && r.status === 'sent'); },
    async claim() { return { won: true, id: null }; },                 // single-process test → always win
    async finalize(_id, rec) { rows.push({ ...rec, date: dstr(rec.date) }); },
    async record(rec) { rows.push({ ...rec, date: dstr(rec.date) }); },
    async lastSentOn(e, t) { const s = rows.filter(r => r.employeeId === e && r.type === t && r.status === 'sent').map(r => r.date).sort(); return s.length ? s[s.length - 1] : null; },
  };
}

const DOCSET = d365.constructor.entities.document;
let DOCS = [];   // documents returned for every employee in a test
let origGLO, origGetCompany;
beforeEach(() => {
  origGLO = d365.getListOptional;
  d365.getListOptional = async (entity) => (entity === DOCSET ? { data: DOCS.map(x => ({ hr_name: x.name, hr_documenttype: x.type, hr_status: x.status })) } : { data: [] });
  DOCS = [];
  // Company Settings supplies the reminder interval (default seed = '3') — stub so
  // resolveIntervalDays() needs no network and the cadence is a deterministic 3.
  origGetCompany = company.getCompany;
  company.getCompany = async () => ({ hr_reminderintervaldays: '3', hr_requireddocs: '' });
  ledger.setStore(memStore());
  notif.clearOutbox();
});
afterEach(() => { d365.getListOptional = origGLO; company.getCompany = origGetCompany; ledger.setStore(null); notif.resetTransport(); notif.clearOutbox(); });

// A fully-complete employee: every COMPLETION_FIELD filled + hr_passport filled.
function completeEmp(over = {}) {
  const e = { hr_hremployeeid: 'E1', hr_hremployee1: 'Amy', hr_email: 'amy@crmonce.com', hr_status: undefined, hr_passport: 'P1234567' };
  for (const f of profile.COMPLETION_FIELDS) e[f] = 'x';
  return { ...e, ...over };
}
const TODAY = '2026-10-28';

const N = 3;   // default cadence used by the dueByInterval (profile/passport) tests below

// ── Pure: passport + interval ─────────────────────────────────────────────────
test('isPassportComplete: filled vs empty', () => {
  assert.strictEqual(reminders.isPassportComplete({ hr_passport: 'A1' }), true);
  assert.strictEqual(reminders.isPassportComplete({ hr_passport: '  ' }), false);
  assert.strictEqual(reminders.isPassportComplete({}), false);
});
test('dueByInterval: never-sent → due; sent today → not due; sent 3d ago → due; 2d ago → not due', async () => {
  const store = memStore(); ledger.setStore(store);
  assert.strictEqual(await reminders.dueByInterval('E1', 'PROFILE_REMINDER', TODAY, N), true);        // never
  store.rows.push({ employeeId: 'E1', type: 'PROFILE_REMINDER', status: 'sent', date: TODAY });
  assert.strictEqual(await reminders.dueByInterval('E1', 'PROFILE_REMINDER', TODAY, N), false);       // today
  store.rows.push({ employeeId: 'E2', type: 'PROFILE_REMINDER', status: 'sent', date: shiftDate(TODAY, -3) });
  assert.strictEqual(await reminders.dueByInterval('E2', 'PROFILE_REMINDER', TODAY, N), true);        // 3d ago
  store.rows.push({ employeeId: 'E3', type: 'PROFILE_REMINDER', status: 'sent', date: shiftDate(TODAY, -2) });
  assert.strictEqual(await reminders.dueByInterval('E3', 'PROFILE_REMINDER', TODAY, N), false);       // 2d ago
});

// ── A. Profile/document reminders ─────────────────────────────────────────────
test('profile: incomplete → ONE email, From HR@, To employee only, CC info@', async () => {
  const sent = []; notif.setTransport((req) => sent.push(req));
  DOCS = [{ name: 'Aadhaar Card', type: 'Aadhaar Card', status: 'verified' }];
  const emp = completeEmp(); delete emp.hr_phone;   // make profile incomplete (missing Personal Info)
  const r = await reminders.runProfileReminders({ todayDs: TODAY, employees: [emp], requiredDocs: ['Aadhaar Card'] });
  assert.strictEqual(r.sent, 1);
  assert.strictEqual(sent.length, 1);
  assert.strictEqual(sent[0].sender, 'HR@crmonce.com');
  assert.deepStrictEqual(toOf(sent[0]), ['amy@crmonce.com']);
  assert.deepStrictEqual(ccOf(sent[0]), ['info@crmonce.com']);
});
test('profile: complete employee → no email (reminders stop when complete)', async () => {
  const sent = []; notif.setTransport((req) => sent.push(req));
  DOCS = [{ name: 'Aadhaar Card', type: 'Aadhaar Card', status: 'verified' }];
  const r = await reminders.runProfileReminders({ todayDs: TODAY, employees: [completeEmp()], requiredDocs: ['Aadhaar Card'] });
  assert.strictEqual(r.complete, 1); assert.strictEqual(r.sent, 0); assert.strictEqual(sent.length, 0);
});
test('profile: a required doc NOT verified still counts as missing (never asks for a complete item though)', async () => {
  const sent = []; notif.setTransport((req) => sent.push(req));
  DOCS = [{ name: 'Aadhaar Card', type: 'Aadhaar Card', status: 'pending' }];   // uploaded but not verified
  const r = await reminders.runProfileReminders({ todayDs: TODAY, employees: [completeEmp()], requiredDocs: ['Aadhaar Card'] });
  assert.strictEqual(r.sent, 1);
  assert.match(sent[0].body.message.body.content, /Aadhaar Card/);   // the outstanding (unverified) doc is listed
});
test('profile: running twice the same day sends only ONE email (ledger dedupe)', async () => {
  const sent = []; notif.setTransport((req) => sent.push(req));
  DOCS = [];
  const emp = completeEmp(); delete emp.hr_phone;
  const args = { todayDs: TODAY, employees: [emp], requiredDocs: ['Aadhaar Card'] };
  await reminders.runProfileReminders(args);
  const r2 = await reminders.runProfileReminders(args);
  assert.strictEqual(sent.length, 1);
  assert.ok(r2.sent === 0 && (r2.held >= 1 || r2.complete === 0));
});
test('profile: within the interval window → held (no second email before N days)', async () => {
  const store = memStore(); ledger.setStore(store);
  store.rows.push({ employeeId: 'E1', type: 'PROFILE_REMINDER', status: 'sent', date: shiftDate(TODAY, -1) });   // sent yesterday
  const sent = []; notif.setTransport((req) => sent.push(req));
  const emp = completeEmp(); delete emp.hr_phone;
  const r = await reminders.runProfileReminders({ todayDs: TODAY, employees: [emp], requiredDocs: ['Aadhaar Card'] });
  assert.strictEqual(r.sent, 0); assert.strictEqual(r.held, 1); assert.strictEqual(sent.length, 0);
});

test('profile: the interval comes from Company Settings — interval 5 holds a 3-day-old reminder', async () => {
  company.getCompany = async () => ({ hr_reminderintervaldays: '5', hr_requireddocs: '' });   // configured cadence = 5 days
  const store = memStore(); ledger.setStore(store);
  store.rows.push({ employeeId: 'E1', type: 'PROFILE_REMINDER', status: 'sent', date: shiftDate(TODAY, -3) });   // 3 days ago
  const sent = []; notif.setTransport((req) => sent.push(req));
  const emp = completeEmp(); delete emp.hr_phone;
  const r = await reminders.runProfileReminders({ todayDs: TODAY, employees: [emp], requiredDocs: ['Aadhaar Card'] });
  assert.strictEqual(r.intervalDays, 5);
  assert.strictEqual(r.sent, 0); assert.strictEqual(r.held, 1); assert.strictEqual(sent.length, 0);   // 3 < 5 → held
});

// ── B. Passport reminders ─────────────────────────────────────────────────────
test('passport: empty passport before deadline → reminder (From HR@, To emp, CC info@)', async () => {
  const sent = []; notif.setTransport((req) => sent.push(req));
  const emp = completeEmp({ hr_passport: '' });
  const r = await reminders.runPassportReminders({ todayDs: TODAY, employees: [emp] });   // 2026-10-28 < deadline
  assert.strictEqual(r.sent, 1); assert.strictEqual(r.overdue, false);
  assert.strictEqual(sent[0].sender, 'HR@crmonce.com');
  assert.deepStrictEqual(toOf(sent[0]), ['amy@crmonce.com']);
  assert.deepStrictEqual(ccOf(sent[0]), ['info@crmonce.com']);
});
test('passport: filled passport → no reminder', async () => {
  const sent = []; notif.setTransport((req) => sent.push(req));
  const r = await reminders.runPassportReminders({ todayDs: TODAY, employees: [completeEmp({ hr_passport: 'Z9' })] });
  assert.strictEqual(r.complete, 1); assert.strictEqual(r.sent, 0); assert.strictEqual(sent.length, 0);
});
test('passport: on/after the deadline the email is the OVERDUE variant', async () => {
  const sent = []; notif.setTransport((req) => sent.push(req));
  const r = await reminders.runPassportReminders({ todayDs: '2026-11-05', employees: [completeEmp({ hr_passport: '' })] });
  assert.strictEqual(r.overdue, true); assert.strictEqual(r.sent, 1);
  assert.match(sent[0].body.message.subject, /overdue/i);
});

// ── C. Goal reminders ─────────────────────────────────────────────────────────
const G = (over) => ({ hr_hrgoalid: 'G1', hr_hrgoal1: 'Q4 Target', hr_status: 'in_progress', hr_duedate: shiftDate(TODAY, 3), hr_employeeid: 'E1', hr_progress: 40, ...over });
const ALL = { m3: true, m2: true, m1: true, d15: true, d7: true, d3: true, d1: true, due: true, overdue: true, overdueInterval: 3 };

// ── Pure: monthsBefore (calendar months, month-end + leap safe) ───────────────
test('monthsBefore: clamps to month-end and handles leap years + year rollover', () => {
  assert.strictEqual(reminders.monthsBefore('2026-05-31', 3), '2026-02-28');   // Feb clamp (non-leap)
  assert.strictEqual(reminders.monthsBefore('2028-03-31', 1), '2028-02-29');   // Feb 29 (leap)
  assert.strictEqual(reminders.monthsBefore('2026-01-15', 1), '2025-12-15');   // year rollover
  assert.strictEqual(reminders.monthsBefore('2026-03-30', 1), '2026-02-28');   // 30 → 28 clamp
  assert.strictEqual(reminders.monthsBefore('2026-11-28', 1), '2026-10-28');   // normal
  assert.strictEqual(reminders.monthsBefore('bad', 1), null);
});

// ── Pure: goalMilestone (exact-date; settings-driven) ─────────────────────────
test('goalMilestone: fixed milestones fire on their exact target date', () => {
  assert.strictEqual(reminders.goalMilestone('in_progress', shiftDate(TODAY, 7), TODAY, ALL).milestone.key, 'd7');
  assert.strictEqual(reminders.goalMilestone('in_progress', shiftDate(TODAY, 1), TODAY, ALL).milestone.key, 'd1');
  assert.strictEqual(reminders.goalMilestone('in_progress', TODAY, TODAY, ALL).milestone.key, 'due');
  assert.strictEqual(reminders.goalMilestone('in_progress', '2026-11-28', TODAY, ALL).milestone.key, 'm1');  // 1 calendar month
});
test('goalMilestone: a disabled milestone does not fire', () => {
  assert.strictEqual(reminders.goalMilestone('in_progress', shiftDate(TODAY, 7), TODAY, { ...ALL, d7: false }).reason, 'not_due');
});
test('goalMilestone: closed/no-due excluded; overdue honors interval + toggle', () => {
  assert.strictEqual(reminders.goalMilestone('completed', shiftDate(TODAY, 1), TODAY, ALL).reason, 'closed');
  assert.strictEqual(reminders.goalMilestone('missed', shiftDate(TODAY, 1), TODAY, ALL).reason, 'closed');
  assert.strictEqual(reminders.goalMilestone('in_progress', '', TODAY, ALL).reason, 'no_due');
  assert.strictEqual(reminders.goalMilestone('in_progress', shiftDate(TODAY, -3), TODAY, ALL).reason, 'overdue');      // 3 % 3 == 0
  assert.strictEqual(reminders.goalMilestone('in_progress', shiftDate(TODAY, -2), TODAY, ALL).reason, 'not_due');      // 2 % 3 != 0
  assert.strictEqual(reminders.goalMilestone('in_progress', shiftDate(TODAY, -3), TODAY, { ...ALL, overdue: false }).reason, 'not_due');
});
test('goalMilestone: a changed due date recomputes the milestone day', () => {
  // Same today; due moved from +7 (fires d7) to +5 (no milestone that day).
  assert.strictEqual(reminders.goalMilestone('in_progress', shiftDate(TODAY, 7), TODAY, ALL).reason, 'fixed');
  assert.strictEqual(reminders.goalMilestone('in_progress', shiftDate(TODAY, 5), TODAY, ALL).reason, 'not_due');
});

test('goal: due in 3 days → ONE email, From HR@, To emp, CC info@, with name/due/status', async () => {
  const sent = []; notif.setTransport((req) => sent.push(req));
  const r = await reminders.runGoalReminders({ todayDs: TODAY, employees: [completeEmp()], goals: [G()] });
  assert.strictEqual(r.sent, 1);
  assert.strictEqual(sent[0].sender, 'HR@crmonce.com');
  assert.deepStrictEqual(toOf(sent[0]), ['amy@crmonce.com']);
  assert.deepStrictEqual(ccOf(sent[0]), ['info@crmonce.com']);
  assert.match(sent[0].body.message.body.content, /Q4 Target/);
});
test('goal: completed → no email', async () => {
  const sent = []; notif.setTransport((req) => sent.push(req));
  const r = await reminders.runGoalReminders({ todayDs: TODAY, employees: [completeEmp()], goals: [G({ hr_status: 'completed' })] });
  assert.strictEqual(r.skippedClosed, 1); assert.strictEqual(sent.length, 0);
});
test('goal: not a reminder day (due in 5) → no email', async () => {
  const sent = []; notif.setTransport((req) => sent.push(req));
  const r = await reminders.runGoalReminders({ todayDs: TODAY, employees: [completeEmp()], goals: [G({ hr_duedate: shiftDate(TODAY, 5) })] });
  assert.strictEqual(r.skippedNotDue, 1); assert.strictEqual(sent.length, 0);
});
test('goal: two goals for the SAME employee on the SAME day → two distinct sends (per-goal key)', async () => {
  const sent = []; notif.setTransport((req) => sent.push(req));
  const r = await reminders.runGoalReminders({ todayDs: TODAY, employees: [completeEmp()], goals: [G({ hr_hrgoalid: 'G1' }), G({ hr_hrgoalid: 'G2', hr_hrgoal1: 'Second Goal' })] });
  assert.strictEqual(r.sent, 2); assert.strictEqual(sent.length, 2);
});
test('goal: inactive/unknown employee → never reminded', async () => {
  const sent = []; notif.setTransport((req) => sent.push(req));
  const r = await reminders.runGoalReminders({ todayDs: TODAY, employees: [], goals: [G()] });   // E1 not in active map
  assert.strictEqual(r.skippedInactive, 1); assert.strictEqual(sent.length, 0);
});
test('goal: running twice the same day → one email per goal (ledger dedupe)', async () => {
  const sent = []; notif.setTransport((req) => sent.push(req));
  const args = { todayDs: TODAY, employees: [completeEmp()], goals: [G()] };
  await reminders.runGoalReminders(args);
  await reminders.runGoalReminders(args);
  assert.strictEqual(sent.length, 1);
});
test('goal: missing due date is skipped safely (no throw)', async () => {
  const sent = []; notif.setTransport((req) => sent.push(req));
  const r = await reminders.runGoalReminders({ todayDs: TODAY, employees: [completeEmp()], goals: [G({ hr_duedate: '' })] });
  assert.strictEqual(r.skippedNoDate, 1); assert.strictEqual(sent.length, 0);
});
test('goal runner: disabling the 3-days milestone in Company Settings suppresses it', async () => {
  company.getCompany = async () => ({ hr_goalrem_d3: 'false', hr_requireddocs: '' });   // 3-days-before OFF
  const sent = []; notif.setTransport((req) => sent.push(req));
  const r = await reminders.runGoalReminders({ todayDs: TODAY, employees: [completeEmp()], goals: [G()] });   // due in 3 → d3
  assert.strictEqual(r.sent, 0); assert.strictEqual(r.skippedNotDue, 1); assert.strictEqual(sent.length, 0);
});
test('goal runner: a 1-calendar-month-before milestone sends with the right wording', async () => {
  const sent = []; notif.setTransport((req) => sent.push(req));
  const r = await reminders.runGoalReminders({ todayDs: TODAY, employees: [completeEmp()], goals: [G({ hr_duedate: '2026-11-28' })] });   // +1 month from 2026-10-28
  assert.strictEqual(r.sent, 1);
  assert.match(sent[0].body.message.subject, /1 month before due/i);
});

// ── Ledger: Graph-send failure → not 'sent', retryable, never double-sends ────
test('ledger: a Graph send FAILURE is not recorded as sent, retries later, and never double-sends', async () => {
  const store = memStore(); ledger.setStore(store);
  const emp = completeEmp(); delete emp.hr_phone;   // incomplete → a reminder is attempted
  const args = { todayDs: TODAY, employees: [emp], requiredDocs: ['Aadhaar Card'] };

  // 1) transport throws (Graph failure) → send fails, ledger records 'failed' (never 'sent')
  notif.setTransport(() => { throw new Error('graph 503'); });
  const r1 = await reminders.runProfileReminders(args);
  assert.strictEqual(r1.sent, 0);
  assert.strictEqual(store.rows.some(x => x.type === 'PROFILE_REMINDER' && x.status === 'sent'), false);
  assert.ok(store.rows.some(x => x.type === 'PROFILE_REMINDER' && x.status === 'failed'), 'recorded failed → retryable');

  // 2) transport recovers → the retry succeeds, exactly ONE email
  const sent = []; notif.setTransport((req) => sent.push(req));
  const r2 = await reminders.runProfileReminders(args);
  assert.strictEqual(r2.sent, 1);
  assert.strictEqual(sent.length, 1);

  // 3) run again the same day → suppressed by the ledger (no duplicate successful send)
  const r3 = await reminders.runProfileReminders(args);
  assert.strictEqual(r3.sent, 0);
  assert.strictEqual(sent.length, 1, 'still exactly one successful send for this employee/type/date');
});

// ── Goal runner: overdue cadence + closed exclusion (real runner, mocked deps) ──
test('goal runner: overdue in-progress goal sends at the interval, not before; completed/exceeded/missed excluded', async () => {
  const sent = []; notif.setTransport((req) => sent.push(req));
  const goals = [
    G({ hr_hrgoalid: 'OV3', hr_status: 'in_progress', hr_duedate: shiftDate(TODAY, -3) }),   // overdue by 3 (= interval) → SEND
    G({ hr_hrgoalid: 'OV1', hr_status: 'in_progress', hr_duedate: shiftDate(TODAY, -1) }),   // overdue by 1 (< interval) → not yet
    G({ hr_hrgoalid: 'DONE', hr_status: 'completed', hr_duedate: shiftDate(TODAY, -3) }),     // excluded
    G({ hr_hrgoalid: 'EXC',  hr_status: 'exceeded',  hr_duedate: shiftDate(TODAY, -3) }),     // excluded
    G({ hr_hrgoalid: 'MIS',  hr_status: 'missed',    hr_duedate: shiftDate(TODAY, -3) }),     // excluded
  ];
  const r = await reminders.runGoalReminders({ todayDs: TODAY, employees: [completeEmp()], goals });
  assert.strictEqual(r.sent, 1);              // only the overdue-by-3 in-progress goal
  assert.strictEqual(r.skippedClosed, 3);     // completed + exceeded + missed
  assert.ok(r.skippedNotDue >= 1);            // the overdue-by-1 goal
  assert.strictEqual(sent.length, 1);
  assert.strictEqual(sent[0].sender, 'HR@crmonce.com');
  assert.deepStrictEqual(toOf(sent[0]), ['amy@crmonce.com']);
  assert.deepStrictEqual(ccOf(sent[0]), ['info@crmonce.com']);
});

test('goal runner: a longer configured OVERDUE interval delays the overdue reminder', async () => {
  company.getCompany = async () => ({ hr_goaloverdueintervaldays: '5', hr_requireddocs: '' });   // overdue cadence = 5
  const sent = []; notif.setTransport((req) => sent.push(req));
  const r = await reminders.runGoalReminders({ todayDs: TODAY, employees: [completeEmp()], goals: [
    G({ hr_hrgoalid: 'OV3b', hr_status: 'in_progress', hr_duedate: shiftDate(TODAY, -3) }),   // 3 not a multiple of 5 → hold
    G({ hr_hrgoalid: 'OV5',  hr_status: 'in_progress', hr_duedate: shiftDate(TODAY, -5) }),   // 5 = interval → send
  ] });
  assert.strictEqual(r.overdueInterval, 5);
  assert.strictEqual(r.sent, 1); assert.strictEqual(sent.length, 1);
});
