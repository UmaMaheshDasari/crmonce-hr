/**
 * _missingPropertyName parses the exact column Dataverse reports as missing, so a
 * write strips ONLY that column and retries — the fix for "profile saves silently
 * drop fields when a column isn't provisioned yet".
 */
process.env.NODE_ENV = 'test';
process.env.AZURE_CLIENT_ID = process.env.AZURE_CLIENT_ID || 'test-client';
process.env.AZURE_CLIENT_SECRET = process.env.AZURE_CLIENT_SECRET || 'test-secret';
process.env.AZURE_TENANT_ID = process.env.AZURE_TENANT_ID || 'test-tenant';

const { test } = require('node:test');
const assert = require('node:assert');
const d365 = require('../src/services/d365.service');

const errWith = (message) => ({ response: { status: 400, data: { error: { message } } } });

test('_missingPropertyName: extracts the column from common Dataverse messages', () => {
  assert.strictEqual(d365._missingPropertyName(errWith("Could not find a property named 'hr_dob' on type 'Microsoft.Dynamics.CRM.hr_hremployee'.")), 'hr_dob');
  assert.strictEqual(d365._missingPropertyName(errWith("The property 'hr_gender' does not exist on type 'x'.")), 'hr_gender');
  assert.strictEqual(d365._missingPropertyName(errWith("'hr_city' does not exist")), 'hr_city');
});

test('_isMissingProperty vs _missingPropertyName agree', () => {
  const e = errWith("Could not find a property named 'hr_pincode'.");
  assert.strictEqual(d365._isMissingProperty(e), true);
  assert.strictEqual(d365._missingPropertyName(e), 'hr_pincode');
});

test('_missingPropertyName: null when the error is unrelated', () => {
  assert.strictEqual(d365._missingPropertyName(errWith('Some other Dataverse error')), null);
  assert.strictEqual(d365._missingPropertyName({}), null);
});
