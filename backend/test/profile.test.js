/**
 * Employee Self-Service profile logic — completion %, change diff, and the
 * verification-trigger + security whitelist. Pure functions; dummy Azure creds so
 * the MSAL client can construct (no network is touched).
 */
process.env.NODE_ENV = 'test';
process.env.AZURE_CLIENT_ID = process.env.AZURE_CLIENT_ID || 'test-client';
process.env.AZURE_CLIENT_SECRET = process.env.AZURE_CLIENT_SECRET || 'test-secret';
process.env.AZURE_TENANT_ID = process.env.AZURE_TENANT_ID || 'test-tenant';

const { test } = require('node:test');
const assert = require('node:assert');
const profile = require('../src/services/profile.service');

const REQ = ['Aadhaar Card', 'PAN Card', 'Cancelled Cheque', 'Photo'];
const ALL_DOCS_VERIFIED = REQ.map((t) => ({ type: t, status: 'verified' }));
const FULL_FIELDS = {
  hr_phone: '9876543210', hr_dob: '1990-01-01', hr_gender: 'Male', hr_bloodgroup: 'O+',
  hr_pan: 'ABCDE1234F', hr_aadhaar: '234123412346',
  hr_address: 'Line 1', hr_city: 'Nellore', hr_state: 'AP', hr_pincode: '524314',
  hr_emergencycontact: 'Ravi', hr_emergencyphone: '9876500000',
  hr_bankname: 'SBI', hr_accountnumber: '123456789012', hr_ifsc: 'SBIN0001234',
};

test('computeCompletion: empty profile → 0% and all groups + required docs missing', () => {
  const c = profile.computeCompletion({}, { requiredDocs: REQ });
  assert.strictEqual(c.percent, 0);
  assert.strictEqual(c.total, 19);   // 15 fields + 4 required docs
  assert.deepStrictEqual(c.missing, ['PAN', 'Aadhaar', 'Personal Info', 'Address', 'Emergency Contact', 'Bank Details', ...REQ]);
});

test('computeCompletion: all fields but docs only UPLOADED (not verified) → not 100%', () => {
  const uploaded = REQ.map((t) => ({ type: t, status: 'pending' }));
  const c = profile.computeCompletion(FULL_FIELDS, { requiredDocs: REQ, documents: uploaded });
  assert.strictEqual(c.percent, 79);   // 15/19 — pending docs don't count
  assert.deepStrictEqual(c.missing, REQ);
});

test('computeCompletion: all fields AND all docs VERIFIED → 100%, nothing missing', () => {
  const c = profile.computeCompletion(FULL_FIELDS, { requiredDocs: REQ, documents: ALL_DOCS_VERIFIED });
  assert.strictEqual(c.percent, 100);
  assert.deepStrictEqual(c.missing, []);
});

test('computeCompletion: partial → rounded % over 19 items, missing lists each doc', () => {
  const c = profile.computeCompletion({ hr_pan: 'ABCDE1234F', hr_phone: '9876543210' }, { requiredDocs: REQ });
  assert.strictEqual(c.filled, 2);
  assert.strictEqual(c.total, 19);
  assert.strictEqual(c.percent, 11);
  assert.ok(c.missing.includes('Aadhaar'));
  assert.ok(c.missing.includes('Photo'));
  assert.ok(!c.missing.includes('PAN'));   // PAN field is filled
});

test('diffChanges: only whitelisted, actually-changed fields are returned', () => {
  const current = { hr_pan: 'ABCDE1234F', hr_phone: '111', hr_salary: 50000 };
  const incoming = { hr_pan: 'ABCDE1234F', hr_phone: '999', hr_salary: 99999, hr_role: 'super_admin' };
  const changes = profile.diffChanges(current, incoming);
  assert.strictEqual(changes.length, 1);            // only hr_phone changed & is editable
  assert.strictEqual(changes[0].field, 'hr_phone');
  assert.strictEqual(changes[0].oldValue, '111');
  assert.strictEqual(changes[0].newValue, '999');
  // hr_salary/hr_role are NOT self-editable → never in the diff.
});

test('requiresVerification: PAN/Aadhaar/Bank/Address trigger it; others do not', () => {
  assert.strictEqual(profile.requiresVerification([{ field: 'hr_pan' }]), true);
  assert.strictEqual(profile.requiresVerification([{ field: 'hr_accountnumber' }]), true);
  assert.strictEqual(profile.requiresVerification([{ field: 'hr_city' }]), true);
  assert.strictEqual(profile.requiresVerification([{ field: 'hr_phone' }]), false);
  assert.strictEqual(profile.requiresVerification([{ field: 'hr_bloodgroup' }]), false);
});

test('security: restricted fields are NOT in the self-editable whitelist', () => {
  for (const f of ['hr_email', 'hr_department', 'hr_designation', '_hr_manager_value', 'hr_salary', 'hr_role', 'hr_status', 'hr_shiftname', 'hr_joiningdate', 'hr_etimecode']) {
    assert.strictEqual(profile.SELF_EDITABLE.has(f), false, `${f} must not be self-editable`);
  }
});
