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

test('leave reason: full text, XSS-escaped, line breaks preserved (not truncated)', () => {
  const longReason = 'I need leave because my passport verification is scheduled.\n\n- Bank work for education loan\n- Multiple   spaces kept\n<script>alert(1)</script>';
  const { html } = T.newRequestApprover({
    moduleTitle: 'Leave',
    employee: { name: 'Vishwesh Boina', id: 'E1', department: 'Engineering', email: 'v@crmonce.com' },
    rows: [['Leave Type', 'Casual Leave'], ['Reason', longReason]],
    applyTime: '2026-07-06T10:00:00Z',
    approverName: 'Uma Mahesh',
    approveUrl: 'x', rejectUrl: 'y',
  });
  assert.ok(html.includes('passport verification'));                 // full reason present
  assert.ok(html.includes('education loan'));                        // not truncated
  assert.ok(html.includes('white-space:pre-wrap'));                  // line breaks/spaces preserved
  assert.ok(html.includes('&lt;script&gt;'));                        // escaped
  assert.ok(!html.includes('<script>alert(1)</script>'));            // XSS neutralized
});

test('longText escapes and preserves formatting', () => {
  const out = T._longText('a & b\n<c>');
  assert.ok(out.includes('a &amp; b'));
  assert.ok(out.includes('&lt;c&gt;'));
  assert.ok(out.includes('white-space:pre-wrap'));
});

test('acknowledgement: subject + greeting', () => {
  const { subject, html } = T.acknowledgement({ moduleTitle: 'Leave', employeeName: 'V', approverName: 'Uma' });
  assert.strictEqual(subject, 'Leave Request Submitted');
  assert.ok(html.includes('Dear V,'));
});

test('decision approved: subject + prominent balance + Days Taken in This Request', () => {
  const { subject, html } = T.decision({
    moduleTitle: 'Leave', employeeName: 'V', approverName: 'Uma', date: '2026-07-06',
    remarks: 'ok', decision: 'approved', balance: { entitlement: 6, taken: 2, balance: 4 }, requestDays: 2,
  });
  assert.strictEqual(subject, 'Leave Approved');
  assert.ok(html.includes('4 / 6 days remaining'));            // prominent Leave Balance
  assert.ok(html.includes('Leave Balance'));                   // label
  assert.ok(html.includes('Days Taken in This Request'));      // second stat label
  assert.ok(html.includes('2 days'));                          // this request's day count
});

test('decision: singular day; missing requestDays hides the second stat (no crash)', () => {
  assert.ok(T.decision({ moduleTitle: 'Leave', employeeName: 'V', approverName: 'U', date: 'd', remarks: '-', decision: 'approved', balance: { entitlement: 6, taken: 5, balance: 1 }, requestDays: 1 }).html.includes('1 day'));
  const noReq = T.decision({ moduleTitle: 'Leave', employeeName: 'V', approverName: 'U', date: 'd', remarks: '-', decision: 'approved', balance: { entitlement: 6, taken: 2, balance: 4 } }).html;
  assert.ok(noReq.includes('4 / 6 days remaining'));           // balance still shown
  assert.ok(!noReq.includes('Days Taken in This Request'));    // second stat omitted when absent
});

test('decision: 20 / 24 balance format preserved (backward compatible)', () => {
  const { html } = T.decision({ moduleTitle: 'Leave', employeeName: 'V', approverName: 'Uma', date: 'd', remarks: 'ok', decision: 'approved', balance: { entitlement: 24, taken: 4, balance: 20 } });
  assert.ok(html.includes('20 / 24'));
});

test('templates escape HTML (XSS-safe)', () => {
  const { html } = T.acknowledgement({ moduleTitle: 'Leave', employeeName: '<script>x</script>', approverName: 'a' });
  assert.ok(!html.includes('<script>x</script>'));
  assert.ok(html.includes('&lt;script&gt;'));
});

test('layout is Outlook-theme-safe: explicit colors, no theme dependence, responsive', () => {
  const { html } = T.decision({ moduleTitle: 'Leave', employeeName: 'V', approverName: 'U', date: 'd', remarks: '-', decision: 'rejected' });
  // Does NOT depend on the recipient's Outlook/OS theme.
  assert.ok(!html.includes('prefers-color-scheme'));           // removed — it darkened text on white cards
  assert.ok(html.includes('color-scheme'));                    // meta signals light-designed mail
  // Explicit background + text colors on the important containers (bgcolor attr + inline).
  assert.ok(html.includes('bgcolor="#ffffff"'));               // body/card background
  assert.ok(html.includes('background-color:#f8fafc'));        // footer background
  assert.ok(html.includes('color:#1f2937'));                   // explicit body text
  assert.ok(!/linear-gradient/.test(html));                    // no gradients (Outlook drops them)
  assert.ok(html.includes('max-width:620px'));                 // still responsive for mobile
});

test('header/footer/status stay high-contrast (white-on-navy header, dark-on-light status)', () => {
  const { html } = T.decision({ moduleTitle: 'Leave', employeeName: 'V', approverName: 'U', date: 'd', remarks: '-', decision: 'approved', balance: { entitlement: 6, taken: 2, balance: 4 }, requestDays: 2 });
  assert.ok(/bgcolor="#1B4F72"/.test(html));                   // solid navy header (brand navy)
  assert.ok(html.includes('color:#ffffff'));                  // white header text
  assert.ok(html.includes('#065f46'));                        // dark-green "Approved" status text
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
