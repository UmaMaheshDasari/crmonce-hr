/**
 * OData filter sanitisers — the injection guards for interpolated $filter values.
 */
process.env.NODE_ENV = 'test';

const { test } = require('node:test');
const assert = require('node:assert');
const { odStr, odInt, odGuid } = require('../src/services/odata.util');

test('odStr doubles single quotes (prevents literal break-out)', () => {
  assert.strictEqual(odStr("o'brien"), "o''brien");
  assert.strictEqual(odStr("x' or hr_year eq 2025 or ''='"), "x'' or hr_year eq 2025 or ''''=''");
  assert.strictEqual(odStr(null), '');
  assert.strictEqual(odStr(undefined), '');
});

test('odInt returns the integer or null for anything non-integer', () => {
  assert.strictEqual(odInt('8'), 8);
  assert.strictEqual(odInt(8), 8);
  assert.strictEqual(odInt('1 or hr_year eq 2025'), null);   // the C1 payroll payload
  assert.strictEqual(odInt('8.5'), null);
  assert.strictEqual(odInt(''), null);
  assert.strictEqual(odInt(undefined), null);
  assert.strictEqual(odInt('abc'), null);
});

test('odGuid passes a GUID through and rejects anything else', () => {
  assert.strictEqual(odGuid('12345678-1234-1234-1234-123456789abc'), '12345678-1234-1234-1234-123456789abc');
  assert.strictEqual(odGuid("id' or ''='"), '');
  assert.strictEqual(odGuid('not-a-guid'), '');
  assert.strictEqual(odGuid(undefined), '');
});
