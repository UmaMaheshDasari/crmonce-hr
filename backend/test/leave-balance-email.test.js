const test = require('node:test');
const assert = require('node:assert');
const T = require('../src/services/email/templates');

const DETAILED = {
  entitlement: 18, taken: 5, balance: 13,
  casual: { entitled: 12, used: 3, remaining: 9 },
  sick: { entitled: 6, used: 2, remaining: 4 },
  compOff: { earned: 2, used: 1, balance: 1 },
  total: { entitled: 18, used: 5, remaining: 13 },
};

// Ordinary leave: only TOTAL paid leaves + this request; NO casual/sick, NO comp-off.
test('decision email: shows only Total Paid Leave + this request (no casual/sick/comp-off)', () => {
  const { subject, html } = T.decision({
    moduleTitle: 'Leave', employeeName: 'V', approverName: 'Uma', date: '2026-07-06',
    remarks: 'ok', decision: 'approved', balance: DETAILED, requestDays: 2,
  });
  assert.strictEqual(subject, 'Leave Approved');
  assert.ok(html.includes('Total Paid Leave'));
  assert.ok(html.includes('13 / 18 days remaining'));
  assert.ok(html.includes('Days Taken in This Request'));
  assert.ok(html.includes('2 days'));
  assert.ok(!html.includes('Casual Leave'));      // removed
  assert.ok(!html.includes('Sick Leave'));        // removed
  assert.ok(!html.includes('Comp Off Balance'));  // not a comp-off request
});

// Comp-off request: show the Comp Off balance ONLY when useCompOff is set.
test('decision email: comp-off balance shown only when the request uses comp-off', () => {
  const { html } = T.decision({
    moduleTitle: 'Leave', employeeName: 'V', approverName: 'Uma', date: '2026-07-06',
    remarks: 'ok', decision: 'approved', balance: DETAILED, requestDays: 1, useCompOff: true,
  });
  assert.ok(html.includes('Comp Off Balance'));
  assert.ok(html.includes('1 day available'));
  assert.ok(html.includes('Total Paid Leave'));
});

// Legacy flat balance shape must keep rendering exactly as before (backward compatible).
test('decision email: legacy flat balance still renders "X / Y days remaining"', () => {
  const { html } = T.decision({
    moduleTitle: 'Leave', employeeName: 'V', approverName: 'U', date: 'd',
    remarks: '-', decision: 'approved', balance: { entitlement: 18, taken: 4, balance: 14 },
  });
  assert.ok(html.includes('14 / 18 days remaining'));
  assert.ok(!html.includes('Total Paid Leave'));   // flat shape uses the simple block
});
