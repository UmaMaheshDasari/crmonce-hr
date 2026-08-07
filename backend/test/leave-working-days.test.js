/**
 * approvedLeaveWorkingDays — the shared working-day leave counter that the
 * dashboard, monthly summary, /stats and /absentees all rely on so Absent matches
 * everywhere. Pure, no network.
 */
process.env.NODE_ENV = 'test';
process.env.AZURE_CLIENT_ID = process.env.AZURE_CLIENT_ID || 'test-client';
process.env.AZURE_CLIENT_SECRET = process.env.AZURE_CLIENT_SECRET || 'test-secret';
process.env.AZURE_TENANT_ID = process.env.AZURE_TENANT_ID || 'test-tenant';
process.env.D365_BASE_URL = process.env.D365_BASE_URL || 'https://example.crm.dynamics.com';

const { test } = require('node:test');
const assert = require('node:assert');
const { approvedLeaveWorkingDays } = require('../src/services/attendance-summary.util');

// Aug 2026: 03 Mon, 04 Tue, 05 Wed, 06 Thu, 07 Fri, 08 Sat, 09 Sun, 10 Mon.
const OPTS = { weekOffDays: [0, 6], holidays: [] };

test('weekend-spanning leave counts WORKING days only (Fri–Mon = 2, not 4)', () => {
  const n = approvedLeaveWorkingDays([{ hr_fromdate: '2026-08-07', hr_todate: '2026-08-10' }], '2026-08-01', '2026-08-31', OPTS);
  assert.strictEqual(n, 2);
});

test('future days beyond the cap (to) are excluded', () => {
  // Leave 04–08 but count only up to 06 → 04,05,06 = 3 working days.
  const n = approvedLeaveWorkingDays([{ hr_fromdate: '2026-08-04', hr_todate: '2026-08-08' }], '2026-08-01', '2026-08-06', OPTS);
  assert.strictEqual(n, 3);
});

test('holidays inside a leave are not counted', () => {
  const n = approvedLeaveWorkingDays([{ hr_fromdate: '2026-08-03', hr_todate: '2026-08-07' }], '2026-08-01', '2026-08-31', { weekOffDays: [0, 6], holidays: ['2026-08-05'] });
  assert.strictEqual(n, 4);   // 03,04,06,07 (05 holiday excluded)
});

test('overlapping leaves are de-duplicated (same day counted once)', () => {
  const n = approvedLeaveWorkingDays([
    { hr_fromdate: '2026-08-03', hr_todate: '2026-08-04' },
    { hr_fromdate: '2026-08-04', hr_todate: '2026-08-04' },
  ], '2026-08-01', '2026-08-31', OPTS);
  assert.strictEqual(n, 2);
});

test('leave entirely on a weekend counts 0', () => {
  const n = approvedLeaveWorkingDays([{ hr_fromdate: '2026-08-08', hr_todate: '2026-08-09' }], '2026-08-01', '2026-08-31', OPTS);
  assert.strictEqual(n, 0);
});

test('empty / missing input is 0', () => {
  assert.strictEqual(approvedLeaveWorkingDays([], '2026-08-01', '2026-08-31', OPTS), 0);
  assert.strictEqual(approvedLeaveWorkingDays(null, '2026-08-01', '2026-08-31', OPTS), 0);
});
