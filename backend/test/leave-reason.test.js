/**
 * Leave Reason length policy — no artificial 100-char limit; enterprise-length text
 * up to the Dataverse column max (4000). Never truncates; a clear error beyond max.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const { LEAVE_REASON_MAX, validateLeaveReason } = require('../src/services/leave-reason.util');

const str = (n) => 'x'.repeat(n);

test('the limit is 4000, not 100', () => {
  assert.strictEqual(LEAVE_REASON_MAX, 4000);
});

test('every length from 0 up to the max is accepted (100, 101, 250, 500, 1000, 2000, 4000)', () => {
  for (const n of [0, 100, 101, 250, 500, 1000, 2000, 4000]) {
    const r = validateLeaveReason(str(n));
    assert.strictEqual(r.ok, true, `${n} chars should be accepted`);
  }
});

test('a realistic long enterprise reason (>100 chars) is accepted', () => {
  const reason = 'I am requesting leave because I need to travel to my hometown for a family function. I will complete all pending work before my leave and have already informed my reporting manager about the planned absence.';
  assert.ok(reason.length > 100, 'sample is >100 chars');
  assert.strictEqual(validateLeaveReason(reason).ok, true);
});

test('beyond the max → clear error, and the text is NOT truncated', () => {
  const r = validateLeaveReason(str(4001));
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /4001 characters/);
  assert.match(r.error, /within 4000/);
});

test('null / undefined / empty are allowed (reason is optional length-wise)', () => {
  assert.strictEqual(validateLeaveReason(undefined).ok, true);
  assert.strictEqual(validateLeaveReason(null).ok, true);
  assert.strictEqual(validateLeaveReason('').ok, true);
});
