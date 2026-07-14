/**
 * Email generation tests (no network / no D365 / no secrets).
 * Run: node --test   (or: npm test)
 */
const { test } = require('node:test');
const assert = require('node:assert');
const T = require('../src/services/email/templates');
const { buildLeaveICS, icsAttachment } = require('../src/services/email/ics');

test('approver email: correct subject + both action buttons + no "Hello Super Admin"', () => {
  const { subject, html } = T.newRequestApprover({
    moduleTitle: 'Leave',
    employee: { name: 'Vishwesh Boina', id: 'E1', department: 'Engineering', email: 'v@crmonce.com' },
    rows: [['Leave Type', 'Casual Leave'], ['From Date', '2026-07-10']],
    applyTime: '2026-07-06T10:00:00Z',
    approverName: 'Uma Mahesh',
    approveUrl: 'https://hr.crmonce.com/approve?action=approved',
    rejectUrl: 'https://hr.crmonce.com/approve?action=rejected',
  });
  assert.strictEqual(subject, 'Leave Request - Vishwesh Boina');
  assert.ok(html.includes('Dear Uma Mahesh,'));
  assert.ok(html.includes('action=approved'));
  assert.ok(html.includes('action=rejected'));
  assert.ok(!/Hello Super Admin/.test(html));
});

test('acknowledgement: subject + greeting', () => {
  const { subject, html } = T.acknowledgement({ moduleTitle: 'Leave', employeeName: 'V', approverName: 'Uma' });
  assert.strictEqual(subject, 'Leave Request Submitted');
  assert.ok(html.includes('Dear V,'));
});

test('decision approved: subject + configurable balance', () => {
  const { subject, html } = T.decision({
    moduleTitle: 'Leave', employeeName: 'V', approverName: 'Uma', date: '2026-07-06',
    remarks: 'ok', decision: 'approved', balance: { entitlement: 24, taken: 4, balance: 20 },
  });
  assert.strictEqual(subject, 'Leave Approved');
  assert.ok(html.includes('20 / 24'));
});

test('templates escape HTML (XSS-safe)', () => {
  const { html } = T.acknowledgement({ moduleTitle: 'Leave', employeeName: '<script>x</script>', approverName: 'a' });
  assert.ok(!html.includes('<script>x</script>'));
  assert.ok(html.includes('&lt;script&gt;'));
});

test('layout is dark-mode + responsive aware', () => {
  const { html } = T.decision({ moduleTitle: 'Leave', employeeName: 'V', approverName: 'U', date: 'd', remarks: '-', decision: 'rejected' });
  assert.ok(html.includes('prefers-color-scheme: dark'));
  assert.ok(html.includes('max-width:620px'));
});

test('ics: all-day event with exclusive DTEND (+1 day) + valid attachment', () => {
  const ics = buildLeaveICS({ uid: 'u1', employeeName: 'V', leaveType: 'Casual Leave', from: '2026-07-10', to: '2026-07-11' });
  assert.ok(ics.includes('BEGIN:VCALENDAR'));
  assert.ok(ics.includes('DTSTART;VALUE=DATE:20260710'));
  assert.ok(ics.includes('DTEND;VALUE=DATE:20260712'));
  const att = icsAttachment(ics);
  assert.strictEqual(att.contentType, 'text/calendar; method=PUBLISH');
  assert.ok(att.contentBytes.length > 0);
  assert.strictEqual(Buffer.from(att.contentBytes, 'base64').toString('utf8'), ics);
});
