const test = require('node:test');
const assert = require('node:assert');
const T = require('../src/services/email/templates');

const DETAILED = {
  entitlement: 18, taken: 5, balance: 13,
  casual: { entitled: 12, used: 3, remaining: 9 },
  sick: { entitled: 6, used: 2, remaining: 4 },
  compOff: { earned: 2, used: 1, balance: 1 },   // 1 comp-off available
  total: { entitled: 18, used: 5, remaining: 13 },
};

// Ordinary leave: Casual Leave + Sick Leave shown as SEPARATE rows (replacing the
// former combined "Total Paid Leave"); this request's type in brackets; Comp Off row
// shown because comp-off IS available (>0).
test('decision email: separate Casual + Sick rows + type in brackets + Comp Off when available', () => {
  const { subject, html } = T.decision({
    moduleTitle: 'Leave', employeeName: 'V', approverName: 'Uma', date: '2026-07-06',
    remarks: 'ok', decision: 'approved', balance: DETAILED, requestDays: 1, leaveType: 'Sick Leave',
  });
  assert.strictEqual(subject, 'Leave Approved');
  assert.ok(!html.includes('Total Paid Leave'), 'combined label removed');
  assert.ok(html.includes('>Casual Leave</th>'), 'Casual Leave row present');
  assert.ok(html.includes('9 / 12 days remaining'), 'casual remaining / entitled');
  assert.ok(html.includes('>Sick Leave</th>'), 'Sick Leave row present');
  assert.ok(html.includes('4 / 6 days remaining'), 'sick remaining / entitled');
  assert.ok(html.includes('Days Taken in This Request'));
  assert.ok(html.includes('1 day (Sick Leave)'));   // type shown in brackets after the day count
  assert.ok(html.includes('Comp Off'));             // separate comp-off row
  assert.ok(html.includes('1 / 2 days remaining')); // remaining / earned (same shape)
});

// No comp-off available and not a comp-off request → NO Comp Off row; Casual/Sick still shown.
test('decision email: no Comp Off row when balance is 0 and request is not comp-off', () => {
  const { html } = T.decision({
    moduleTitle: 'Leave', employeeName: 'V', approverName: 'Uma', date: '2026-07-06',
    remarks: 'ok', decision: 'approved', requestDays: 1, leaveType: 'Casual Leave',
    balance: { ...DETAILED, compOff: { earned: 0, used: 0, balance: 0 } },
  });
  assert.ok(!html.includes('Total Paid Leave'));
  assert.ok(html.includes('>Casual Leave</th>'));
  assert.ok(html.includes('>Sick Leave</th>'));
  assert.ok(html.includes('1 day (Casual Leave)'));
  assert.ok(!html.includes('Comp Off'));
});

// Comp-off request: label is "Comp Off", and the post-approval decrement is shown
// even when it drops to 0. Casual/Sick rows still present.
test('decision email: comp-off request shows (Comp Off) and 0 available after last one', () => {
  const { html } = T.decision({
    moduleTitle: 'Leave', employeeName: 'V', approverName: 'Uma', date: '2026-07-06',
    remarks: 'ok', decision: 'approved', requestDays: 1, useCompOff: true, leaveType: 'Earned Leave',
    balance: { ...DETAILED, compOff: { earned: 1, used: 1, balance: 0 } },
  });
  assert.ok(html.includes('1 day (Comp Off)'));   // comp-off label, not the raw "Earned Leave"
  assert.ok(html.includes('Comp Off'));
  assert.ok(html.includes('0 / 1 days remaining')); // decrement visible even at 0
  assert.ok(html.includes('>Casual Leave</th>'));
  assert.ok(html.includes('>Sick Leave</th>'));
  assert.ok(!html.includes('Total Paid Leave'));
});

// LOP request: Casual + Sick stay ORIGINAL (unchanged by LOP) and a separate LOP row
// shows the LOP days; the type appears in brackets after the day count.
test('decision email: LOP keeps original Casual/Sick + shows LOP days', () => {
  const { html } = T.decision({
    moduleTitle: 'Leave', employeeName: 'V', approverName: 'Uma', date: '2026-07-06',
    remarks: 'ok', decision: 'approved', requestDays: 2, leaveType: 'LOP',
    balance: { ...DETAILED, lop: { fromLeave: 2 } },
  });
  assert.ok(!html.includes('Total Paid Leave'));
  assert.ok(html.includes('9 / 12 days remaining')); // casual untouched by LOP
  assert.ok(html.includes('4 / 6 days remaining'));   // sick untouched by LOP
  assert.ok(html.includes('>LOP<'));                  // separate LOP row label
  assert.ok(html.includes('2 days (LOP)'));           // type in brackets after day count
});

// Zero balance in a category still renders dynamically (never hidden, never fabricated).
test('decision email: zero remaining in a category shows "0 / Y days remaining"', () => {
  const { html } = T.decision({
    moduleTitle: 'Leave', employeeName: 'V', approverName: 'U', date: 'd', remarks: '-', decision: 'approved',
    requestDays: 1, leaveType: 'Casual Leave',
    balance: { casual: { entitled: 12, used: 12, remaining: 0 }, sick: { entitled: 6, used: 0, remaining: 6 } },
  });
  assert.ok(html.includes('>Casual Leave</th>'));
  assert.ok(html.includes('0 / 12 days remaining'), 'exhausted casual shows 0 / 12');
  assert.ok(html.includes('6 / 6 days remaining'), 'full sick shows 6 / 6');
});

// Backward compatibility: a DETAILED payload that carries only `total` (no casual/sick
// breakdown) falls back to the combined "Total Paid Leave" row.
test('decision email: legacy detailed payload without casual/sick falls back to Total Paid Leave', () => {
  const { html } = T.decision({
    moduleTitle: 'Leave', employeeName: 'V', approverName: 'U', date: 'd', remarks: '-', decision: 'approved',
    balance: { total: { entitled: 18, used: 5, remaining: 13 } },
  });
  assert.ok(html.includes('Total Paid Leave'));
  assert.ok(html.includes('13 / 18 days remaining'));
  assert.ok(!html.includes('>Casual Leave</th>'));
});

// Legacy FLAT balance shape must keep rendering exactly as before (backward compatible).
test('decision email: legacy flat balance still renders "X / Y days remaining"', () => {
  const { html } = T.decision({
    moduleTitle: 'Leave', employeeName: 'V', approverName: 'U', date: 'd',
    remarks: '-', decision: 'approved', balance: { entitlement: 18, taken: 4, balance: 14 },
  });
  assert.ok(html.includes('14 / 18 days remaining'));
  assert.ok(!html.includes('Total Paid Leave'));   // flat shape uses the simple block
  assert.ok(!html.includes('>Casual Leave</th>'));
});
