/**
 * Celebrations service — pure date-matching + template logic (no network).
 */
process.env.NODE_ENV = 'test';
process.env.AZURE_CLIENT_ID = process.env.AZURE_CLIENT_ID || 'test-client';
process.env.AZURE_CLIENT_SECRET = process.env.AZURE_CLIENT_SECRET || 'test-secret';
process.env.AZURE_TENANT_ID = process.env.AZURE_TENANT_ID || 'test-tenant';

const { test } = require('node:test');
const assert = require('node:assert');
const svc = require('../src/services/celebrations.service');
const notifSvc = require('../src/services/notification.service');
let activitySvc; try { activitySvc = require('../src/services/activity.service'); } catch { activitySvc = null; }

test('mmdd: parses YYYY-MM-DD and ISO timestamps', () => {
  assert.strictEqual(svc.mmdd('1990-12-25'), '12-25');
  assert.strictEqual(svc.mmdd('2020-05-01T00:00:00Z'), '05-01');
  assert.strictEqual(svc.mmdd(''), '');
  assert.strictEqual(svc.mmdd(null), '');
});

test('yearOf: extracts the year from a date value', () => {
  assert.strictEqual(svc.yearOf('2018-03-10'), 2018);
  assert.strictEqual(svc.yearOf('2015-01-01T00:00:00Z'), 2015);
  assert.strictEqual(svc.yearOf(''), null);
});

test('firstNameOf: first token of the full name', () => {
  assert.strictEqual(svc.firstNameOf('Vishwesh Kumar Reddy'), 'Vishwesh');
  assert.strictEqual(svc.firstNameOf('  Priya  '), 'Priya');
  assert.strictEqual(svc.firstNameOf(''), 'there');
});

test('fill: replaces placeholders, blanks unknown keys', () => {
  assert.strictEqual(svc.fill('Happy Birthday {firstName}!', { firstName: 'Vishwesh' }), 'Happy Birthday Vishwesh!');
  assert.strictEqual(svc.fill('{years} year(s) at {company}', { years: 5, company: 'CRMONCE' }), '5 year(s) at CRMONCE');
  assert.strictEqual(svc.fill('Hi {missing}', {}), 'Hi ');
});

test('matchesToday: exact month/day match (year-independent)', () => {
  assert.strictEqual(svc.matchesToday('1988-05-01', '2026-05-01'), true);
  assert.strictEqual(svc.matchesToday('1988-05-02', '2026-05-01'), false);
});

test('matchesToday: Feb-29 is observed on Feb-28 in non-leap years only', () => {
  assert.strictEqual(svc.matchesToday('1992-02-29', '2025-02-28'), true);   // 2025 non-leap → observe
  assert.strictEqual(svc.matchesToday('1992-02-29', '2024-02-28'), false);  // 2024 leap → wait for the 29th
  assert.strictEqual(svc.matchesToday('1992-02-29', '2024-02-29'), true);   // leap → exact
});

test('matchesToday: empty / unparseable date never matches', () => {
  assert.strictEqual(svc.matchesToday('', '2026-05-01'), false);
  assert.strictEqual(svc.matchesToday('not-a-date', '2026-05-01'), false);
});

test('EVENTS registry: the three shipped event types are present', () => {
  assert.ok(svc.EVENTS.birthday);
  assert.ok(svc.EVENTS.marriage_anniversary);
  assert.ok(svc.EVENTS.work_anniversary);
});

// ── settings merge precedence (the persistence-bug fix) ───────────────────────
// The read is I/O (can't be unit-tested from here) but merge() is the pure core
// that decides column-vs-default precedence. These prove a saved DB value ALWAYS
// wins over the default, and that an empty read falls back to defaults.

test('merge: an empty row returns the DEFAULTS (unprovisioned table safety net)', () => {
  const m = svc.merge({});
  assert.strictEqual(m.hr_birthdayenabled, svc.DEFAULTS.hr_birthdayenabled);
  assert.strictEqual(m.hr_sendtime, '09:00');
});

test('merge: a saved DB column ALWAYS overrides the default (never reverts)', () => {
  const m = svc.merge({
    hr_celebrationsettingid: 'row-123',
    hr_sendtime: '18:30',
    hr_birthdaysubject: 'Custom Subject',
  });
  assert.strictEqual(m.hr_sendtime, '18:30');               // saved value wins
  assert.strictEqual(m.hr_birthdaysubject, 'Custom Subject');
  assert.strictEqual(m.hr_celebrationsettingid, 'row-123'); // id preserved → save UPDATES (no duplicate row)
  // untouched fields still fall back to defaults
  assert.strictEqual(m.hr_marriagesubject, svc.DEFAULTS.hr_marriagesubject);
});

test('merge: a saved "false" toggle is preserved (not shadowed by the true default)', () => {
  const m = svc.merge({ hr_birthdayenabled: 'false' });
  assert.strictEqual(m.hr_birthdayenabled, 'false');
});

test('merge: empty-string / null columns fall back to default (present-check, not truthy)', () => {
  const m = svc.merge({ hr_sendtime: '', hr_birthdaysubject: null });
  assert.strictEqual(m.hr_sendtime, svc.DEFAULTS.hr_sendtime);          // '' is absent → default
  assert.strictEqual(m.hr_birthdaysubject, svc.DEFAULTS.hr_birthdaysubject); // null is absent → default
});

// ── completed-years wording (marriage anniversary) ────────────────────────────
test('togethernessLine: 1 year is singular, 2+ are "wonderful years", 0/invalid → none', () => {
  assert.strictEqual(svc.togethernessLine(1), 'Celebrating 1 year of togetherness');
  assert.strictEqual(svc.togethernessLine(2), 'Celebrating 2 wonderful years of togetherness');
  assert.strictEqual(svc.togethernessLine(3), 'Celebrating 3 wonderful years of togetherness');
  assert.strictEqual(svc.togethernessLine(5), 'Celebrating 5 wonderful years of togetherness');
  assert.strictEqual(svc.togethernessLine('7'), 'Celebrating 7 wonderful years of togetherness');
  assert.strictEqual(svc.togethernessLine(0), '');
  assert.strictEqual(svc.togethernessLine(null), '');
  assert.strictEqual(svc.togethernessLine(undefined), '');
});

// ── CC (information recipients) parsing ───────────────────────────────────────
test('parseCcList: valid + de-duped, drops junk/placeholders, never the employee', () => {
  const cc = svc.parseCcList('hr@crmonce.com, HR@crmonce.com , notanemail, foo@example.com, vishwesh@crmonce.com', 'vishwesh@crmonce.com');
  assert.deepStrictEqual(cc, ['hr@crmonce.com']); // dup folded, junk + example.com placeholder dropped, self excluded
});
test('parseCcList: blank / null input → no CC', () => {
  assert.deepStrictEqual(svc.parseCcList('', 'a@crmonce.com'), []);
  assert.deepStrictEqual(svc.parseCcList('   ', 'a@crmonce.com'), []);
  assert.deepStrictEqual(svc.parseCcList(null, ''), []);
});

// ── professional email HTML (Outlook-safe, TO vs CC framing) ──────────────────
test('buildEmailHtml: birthday — name + title + greeting, no external assets, no CC strip', () => {
  const html = svc.buildEmailHtml('birthday', { name: 'Vishwesh Boina', company: 'CRMONCE' }, 'Dear Vishwesh,\n\nHappy Birthday!', 0);
  assert.match(html, /Vishwesh Boina/);
  assert.match(html, /Happy Birthday/);
  assert.doesNotMatch(html, /src=|http:\/\/|https:\/\//);  // nothing Outlook would block
  assert.doesNotMatch(html, /For Information/);            // no CC → no info strip
});
test('buildEmailHtml: with CC → "For Information" strip is added, greeting still to employee', () => {
  const html = svc.buildEmailHtml('birthday', { name: 'Vishwesh Boina' }, 'Dear Vishwesh, On behalf of HR...', 2);
  assert.match(html, /For Information/);
  assert.match(html, /birthday is today/);
  assert.match(html, /information only/);
  assert.match(html, /On behalf of HR/);
});
test('buildEmailHtml: marriage anniversary shows the correct completed-years line', () => {
  assert.match(svc.buildEmailHtml('marriage_anniversary', { name: 'A B', years: 1 }, 'x', 0), /Celebrating 1 year of togetherness/);
  assert.match(svc.buildEmailHtml('marriage_anniversary', { name: 'A B', years: 5 }, 'x', 0), /Celebrating 5 wonderful years of togetherness/);
});
test('buildEmailHtml: dynamic values are escaped (no HTML injection via the name)', () => {
  const html = svc.buildEmailHtml('birthday', { name: '<script>x</script>' }, 'hi', 0);
  assert.doesNotMatch(html, /<script>x<\/script>/);
  assert.match(html, /&lt;script&gt;/);
});

// ── sendOne: ONE email, TO = employee, CC = information recipients ─────────────
function settingsFixture(cc = '') {
  return {
    ccRecipients: cc,
    templates: {
      birthday: { subject: 'Happy Birthday - {name}', body: 'Dear {firstName},\n\nOn behalf of HR, we wish you a very Happy Birthday!\n\nRegards,\nHR Team', notif: 'Hi {firstName}' },
      marriage_anniversary: { subject: 'Happy Marriage Anniversary - {name}', body: 'Dear {firstName},\n\nHappy Anniversary!\n\nRegards,\nHR Team', notif: 'Hi {firstName}' },
      work_anniversary: { subject: 'Work - {name}', body: 'Hi {firstName}, {years} years', notif: 'Hi' },
    },
  };
}
async function withCapturedEmail(fn) {
  const origSend = notifSvc.sendEmail, origNotify = notifSvc.notifyUser, origAct = activitySvc && activitySvc.record;
  let captured = null;
  notifSvc.sendEmail = async (to, subject, html, opts) => { captured = { to, subject, html, opts }; return { success: true }; };
  notifSvc.notifyUser = () => {};
  if (activitySvc) activitySvc.record = () => {};
  try { const res = await fn(); return { captured, res }; }
  finally { notifSvc.sendEmail = origSend; notifSvc.notifyUser = origNotify; if (activitySvc) activitySvc.record = origAct; }
}

test('sendOne birthday: TO = employee, CC = cleaned info list, subject has the name', async () => {
  const emp = { id: 'e1', name: 'Vishwesh Boina', firstName: 'Vishwesh', email: 'vishwesh@crmonce.com', department: 'Sales', designation: 'Executive' };
  const { captured, res } = await withCapturedEmail(() =>
    svc.sendOne('birthday', emp, settingsFixture('hr@crmonce.com, vishwesh@crmonce.com, hr@crmonce.com')));
  assert.strictEqual(res.emailStatus, 'sent');
  assert.strictEqual(captured.to, 'vishwesh@crmonce.com');       // TO = the employee
  assert.deepStrictEqual(captured.opts.cc, ['hr@crmonce.com']);  // employee excluded + dup folded
  assert.match(captured.subject, /Happy Birthday/);
  assert.match(captured.subject, /Vishwesh Boina/);
  assert.match(captured.html, /On behalf of HR/);               // congratulations addressed to employee
  assert.match(captured.html, /For Information/);               // CC info strip present
});
test('sendOne birthday: no CC configured → single TO email, no info strip', async () => {
  const emp = { id: 'e1', name: 'A B', firstName: 'A', email: 'a@crmonce.com' };
  const { captured } = await withCapturedEmail(() => svc.sendOne('birthday', emp, settingsFixture('')));
  assert.strictEqual(captured.opts.cc, undefined);
  assert.doesNotMatch(captured.html, /For Information/);
});
test('sendOne marriage: correct completed-years line; CC excludes the employee', async () => {
  const emp = { id: 'e2', name: 'Priya Sharma', firstName: 'Priya', email: 'priya@crmonce.com', years: 5 };
  const { captured } = await withCapturedEmail(() =>
    svc.sendOne('marriage_anniversary', emp, settingsFixture('priya@crmonce.com, hr@crmonce.com')));
  assert.deepStrictEqual(captured.opts.cc, ['hr@crmonce.com']);
  assert.match(captured.html, /Celebrating 5 wonderful years of togetherness/);
});
test('sendOne: employee without an email → email skipped, sendEmail never called', async () => {
  const emp = { id: 'e3', name: 'No Email', firstName: 'No', email: '' };
  const { captured, res } = await withCapturedEmail(() => svc.sendOne('birthday', emp, settingsFixture('hr@crmonce.com')));
  assert.strictEqual(res.emailStatus, 'skipped');
  assert.strictEqual(captured, null);
});
