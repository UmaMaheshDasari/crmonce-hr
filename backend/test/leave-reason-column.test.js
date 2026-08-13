/**
 * Leave Reason — the Dataverse column-length self-heal path.
 *
 * When Dataverse rejects a create because hr_reason is still capped at 100
 * (0x80044331), the create flow must detect it, WIDEN the column to 4000, and retry —
 * never truncating the user's text. These tests cover the detection helpers (the
 * novel, reusable logic) without any network.
 */
process.env.NODE_ENV = 'test';
process.env.AZURE_CLIENT_ID = process.env.AZURE_CLIENT_ID || 'test-client';
process.env.AZURE_CLIENT_SECRET = process.env.AZURE_CLIENT_SECRET || 'test-secret';
process.env.AZURE_TENANT_ID = process.env.AZURE_TENANT_ID || 'test-tenant';

const { test } = require('node:test');
const assert = require('node:assert');
const d365 = require('../src/services/d365.service');
const { validateLeaveReason, LEAVE_REASON_MAX } = require('../src/services/leave-reason.util');

// The exact Dataverse error the user reported.
const lengthErr = (attr = 'hr_reason', max = 100) => ({
  response: {
    status: 400,
    data: { error: { code: '0x80044331', message: `The length of the '${attr}' attribute of the 'hr_hrleave' entity exceeded the maximum allowed length of '${max}'.` } },
  },
});

test('detects the column-length error (0x80044331) by code and by message', () => {
  assert.strictEqual(d365._isColumnLengthError(lengthErr()), true);
  // message-only (no code) still detected
  assert.strictEqual(d365._isColumnLengthError({ response: { status: 400, data: { error: { message: 'exceeded the maximum allowed length of 100' } } } }), true);
});

test('extracts the offending column name from the error', () => {
  assert.strictEqual(d365._columnLengthName(lengthErr('hr_reason')), 'hr_reason');
  assert.strictEqual(d365._columnLengthName(lengthErr('hr_remarks')), 'hr_remarks');
});

test('does NOT misclassify unrelated Dataverse errors as length errors', () => {
  assert.strictEqual(d365._isColumnLengthError({ response: { status: 400, data: { error: { code: '0x0', message: "Could not find a property named 'hr_foo'" } } } }), false);
  assert.strictEqual(d365._isColumnLengthError({ response: { status: 404, data: { error: { message: 'Resource not found' } } } }), false);
  assert.strictEqual(d365._isColumnLengthError(new Error('network')), false);
});

// The self-heal only triggers for hr_reason; a length error on a different column is
// re-thrown untouched (guarded by the column-name check in the create flow).
test('self-heal targets hr_reason specifically (name guard)', () => {
  const err = lengthErr('hr_someothercol');
  assert.strictEqual(d365._isColumnLengthError(err), true);
  assert.notStrictEqual(d365._columnLengthName(err), 'hr_reason');
});

// The length policy stays 4000 and never truncates (the self-heal preserves the text).
test('reason policy is 4000 and accepts the tested lengths (100/1000/4000), rejects 4001', () => {
  assert.strictEqual(LEAVE_REASON_MAX, 4000);
  for (const n of [5, 100, 1000, 4000]) assert.strictEqual(validateLeaveReason('x'.repeat(n)).ok, true, `${n} accepted`);
  assert.strictEqual(validateLeaveReason('x'.repeat(4001)).ok, false);
});
