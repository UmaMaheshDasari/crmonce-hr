/**
 * Goal Assignment Notification System — validates the email (TO/CC/subject/body),
 * the in-app notification, the activity feed entry, no-duplicate-email guard, and
 * transient-failure retry. Microsoft Graph is NEVER contacted (mock transport);
 * all D365 reads/writes are stubbed. No real goals, no production data.
 */
process.env.NODE_ENV = 'test';
process.env.EMAIL_DRY_RUN = 'true';
process.env.TENANT_MAIL_DOMAINS = 'crmonce.com';
process.env.AZURE_CLIENT_ID = process.env.AZURE_CLIENT_ID || 'test-client';
process.env.AZURE_CLIENT_SECRET = process.env.AZURE_CLIENT_SECRET || 'test-secret';
process.env.AZURE_TENANT_ID = process.env.AZURE_TENANT_ID || 'test-tenant';

const { test, afterEach, beforeEach } = require('node:test');
const assert = require('node:assert');

const notif = require('../src/services/notification.service');
const T = require('../src/services/email/templates');
const activity = require('../src/services/activity.service');
const d365 = require('../src/services/d365.service');
const goalNotify = require('../src/services/goal-notify.service');

// ── Stub every D365 call the notify path makes ──────────────────────────────
const EMP = 'emp-guid-1';
let updates = [];
function stubD365({ employee } = {}) {
  updates = [];
  d365.getById = async (entity, id, opts) => {
    // employee lookup (TO + manager) and manager lookup
    if (id === EMP) return employee ?? { hr_hremployee1: 'Vishwesh Boina', hr_email: 'vishwesh@crmonce.com', _hr_manager_value: 'mgr-guid-1' };
    if (id === 'mgr-guid-1') return { hr_email: 'manager@crmonce.com' };
    return {};
  };
  d365.update = async (entity, id, body) => { updates.push({ id, body }); return { hr_hrgoalid: id, ...body }; };
}

const GOAL = {
  hr_hrgoalid: 'goal-1', hr_hrgoal1: 'Improve Attendance Compliance',
  hr_description: 'Maintain attendance above 98%.', hr_quarter: 'Q2',
  hr_financialyear: '2026-27', hr_priority: 'high', hr_weightage: 25,
  hr_duedate: '2026-12-31', hr_employeename: 'Vishwesh Boina',
  hr_assigneddate: '2026-08-04',
};
const ASSIGNER = { name: 'Uma Mahesh', email: 'umamahesh@crmonce.com' };

beforeEach(() => { goalNotify._emailedGoals.clear(); });
afterEach(() => { notif.resetTransport(); notif.clearOutbox(); });

// ── Template ────────────────────────────────────────────────────────────────
test('template: goalAssigned subject + all goal fields present', () => {
  const { subject, html } = T.goalAssigned({
    employeeName: 'Vishwesh Boina', goalTitle: 'Improve Attendance Compliance',
    description: 'Maintain attendance above 98%.', quarter: 'Q2', financialYear: '2026-27',
    priority: 'High', weightage: 25, dueDate: '31-Dec-2026', assignedBy: 'Uma Mahesh',
    assignedOn: '04-Aug-2026', viewUrl: 'https://hr.crmonce.com/goals',
  });
  assert.strictEqual(subject, 'New Performance Goal Assigned');
  assert.match(html, /Hello Vishwesh Boina/);
  assert.match(html, /Improve Attendance Compliance/);
  assert.match(html, /Maintain attendance above 98%/);
  assert.match(html, /Q2/);
  assert.match(html, /2026-27/);
  assert.match(html, /25%/);
  assert.match(html, /31-Dec-2026/);
  assert.match(html, /Uma Mahesh/);
  assert.match(html, /View Goal/);
});

// ── Email TO/CC/FROM ──────────────────────────────────────────────────────────
test('email: TO employee, CC manager, FROM assigner mailbox', async () => {
  stubD365();
  const captured = [];
  notif.setTransport((req) => captured.push(req));

  const audit = await goalNotify.notifyGoalAssigned({ goal: GOAL, assigner: ASSIGNER, employeeId: EMP });

  assert.strictEqual(captured.length, 1);
  const msg = captured[0].body.message;
  assert.strictEqual(captured[0].sender, 'umamahesh@crmonce.com');               // FROM = assigner
  assert.deepStrictEqual(msg.toRecipients, [{ emailAddress: { address: 'vishwesh@crmonce.com' } }]);
  assert.deepStrictEqual(msg.ccRecipients, [{ emailAddress: { address: 'manager@crmonce.com' } }]);
  assert.strictEqual(msg.subject, 'New Performance Goal Assigned');
  assert.strictEqual(audit.emailSent, true);
  assert.ok(audit.emailSentTime);
});

test('email: FROM falls back to info@crmonce.com when assigner mailbox is external', async () => {
  stubD365();
  const captured = [];
  notif.setTransport((req) => captured.push(req));
  await goalNotify.notifyGoalAssigned({ goal: GOAL, assigner: { name: 'Ext', email: 'ext@gmail.com' }, employeeId: EMP });
  assert.strictEqual(captured[0].sender, notif.GRAPH_SENDER);   // info@crmonce.com
});

// ── In-app notification + activity ────────────────────────────────────────────
test('notification: creates in-app notification + records activity feed entry', async () => {
  stubD365();
  notif.setTransport(() => {});
  const before = activity.runtime().length;

  const audit = await goalNotify.notifyGoalAssigned({ goal: GOAL, assigner: ASSIGNER, employeeId: EMP });

  // In-app notification created (goal:assigned emitted to the employee's socket).
  assert.strictEqual(audit.notificationCreated, true);

  // Activity feed updated: "Uma Mahesh assigned a new goal to Vishwesh Boina".
  const feed = activity.runtime();
  assert.strictEqual(feed.length, before + 1);
  assert.strictEqual(feed[0].type, 'goal_assigned');
  assert.strictEqual(feed[0].title, 'Goal Assigned');
  assert.match(feed[0].meta, /Uma Mahesh assigned a new goal to Vishwesh Boina/);
});

// ── Audit write-back ──────────────────────────────────────────────────────────
test('audit: writes Email Sent / time / Notification Created onto the goal', async () => {
  stubD365();
  notif.setTransport(() => {});
  await goalNotify.notifyGoalAssigned({ goal: GOAL, assigner: ASSIGNER, employeeId: EMP });
  const u = updates.find(x => x.id === 'goal-1');
  assert.ok(u, 'goal audit updated');
  assert.strictEqual(u.body.hr_emailsent, 'sent');
  assert.strictEqual(u.body.hr_notificationcreated, 'true');
  assert.ok(u.body.hr_emailsenttime);
});

// ── No duplicate emails ───────────────────────────────────────────────────────
test('no-duplicate: same goal only emails once across two calls', async () => {
  stubD365();
  const captured = [];
  notif.setTransport((req) => captured.push(req));
  await goalNotify.notifyGoalAssigned({ goal: GOAL, assigner: ASSIGNER, employeeId: EMP });
  await goalNotify.notifyGoalAssigned({ goal: GOAL, assigner: ASSIGNER, employeeId: EMP });
  assert.strictEqual(captured.length, 1);   // second call skips the send
});

// ── Retry on transient Graph failure ──────────────────────────────────────────
test('retry: a transient send failure is retried, then succeeds', async () => {
  stubD365();
  let calls = 0;
  // Fail the first attempt, succeed the second (transport throws → sendEmail returns failure).
  notif.setTransport(() => { calls++; if (calls === 1) throw new Error('Graph 503 temporarily unavailable'); });
  const audit = await goalNotify.notifyGoalAssigned({ goal: GOAL, assigner: ASSIGNER, employeeId: EMP });
  assert.ok(calls >= 2, 'retried after transient failure');
  assert.strictEqual(audit.emailSent, true);
});

// ── Missing employee email → skip email, keep notification/activity ───────────
test('no email: employee without a mailbox still gets in-app notification', async () => {
  stubD365({ employee: { hr_hremployee1: 'No Email', hr_email: '', _hr_manager_value: null } });
  const captured = [];
  notif.setTransport((req) => captured.push(req));
  const audit = await goalNotify.notifyGoalAssigned({ goal: GOAL, assigner: ASSIGNER, employeeId: EMP });
  assert.strictEqual(captured.length, 0);         // no email sent
  assert.strictEqual(audit.emailSent, false);
  assert.strictEqual(audit.notificationCreated, true);   // but still notified in-app
});
