/**
 * Identity / bank validators — PAN, Aadhaar (Verhoeff), IFSC, account number,
 * UAN, ESIC, blood group, phone. Pure functions, no I/O.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const v = require('../src/services/validators');

// A Verhoeff-valid 12-digit Aadhaar (2-9 start). 234123412346 has checksum digit 6.
const VALID_AADHAAR = '234123412346';

test('PAN: valid is upper-cased; invalid rejected', () => {
  assert.deepStrictEqual(v.validatePAN('abcde1234f'), { ok: true, value: 'ABCDE1234F' });
  assert.strictEqual(v.validatePAN('ABCD1234F').ok, false);      // only 4 leading letters
  assert.strictEqual(v.validatePAN('ABCDE12345').ok, false);     // last must be a letter
  assert.deepStrictEqual(v.validatePAN(''), { ok: true, value: '' });  // optional
});

test('Aadhaar: Verhoeff checksum enforced', () => {
  assert.strictEqual(v.verhoeffValid(VALID_AADHAAR), true);
  assert.strictEqual(v.validateAadhaar(VALID_AADHAAR).ok, true);
  assert.strictEqual(v.validateAadhaar('234123412345').ok, false);  // wrong check digit
  assert.strictEqual(v.validateAadhaar('123456789012').ok, false);  // starts with 1
  assert.strictEqual(v.validateAadhaar('12345').ok, false);         // too short
});

test('IFSC: 4 letters + 0 + 6 alnum, upper-cased', () => {
  assert.deepStrictEqual(v.validateIFSC('sbin0001234'), { ok: true, value: 'SBIN0001234' });
  assert.strictEqual(v.validateIFSC('SBIN1001234').ok, false);   // 5th char must be 0
  assert.strictEqual(v.validateIFSC('SBI0001234').ok, false);    // needs 4 letters
});

test('Account number: 9-18 digits', () => {
  assert.strictEqual(v.validateAccountNumber('123456789').ok, true);
  assert.strictEqual(v.validateAccountNumber('12345678').ok, false);  // 8 digits
  assert.strictEqual(v.validateAccountNumber('12345678901234567890').ok, false);  // 20 digits
  assert.strictEqual(v.validateAccountNumber('12345abc9').ok, false);
});

test('UAN: 12 digits; ESIC: 10 or 17', () => {
  assert.strictEqual(v.validateUAN('123456789012').ok, true);
  assert.strictEqual(v.validateUAN('12345').ok, false);
  assert.strictEqual(v.validateESIC('1234567890').ok, true);
  assert.strictEqual(v.validateESIC('12345678901234567').ok, true);
  assert.strictEqual(v.validateESIC('123').ok, false);
});

test('Blood group: only the 8 ABO/Rh groups', () => {
  assert.deepStrictEqual(v.validateBloodGroup('o+'), { ok: true, value: 'O+' });
  assert.strictEqual(v.validateBloodGroup('C+').ok, false);
});

test('Phone: 10-digit Indian mobile, strips +91/0', () => {
  assert.deepStrictEqual(v.validatePhone('+91 9876543210'), { ok: true, value: '9876543210' });
  assert.deepStrictEqual(v.validatePhone('09876543210'), { ok: true, value: '9876543210' });
  assert.strictEqual(v.validatePhone('1234567890').ok, false);   // starts with 1
});

test('validateEmployeeIdentity: aggregates errors + normalised values', () => {
  const r = v.validateEmployeeIdentity({ hr_pan: 'abcde1234f', hr_ifsc: 'sbin0001234', hr_aadhaar: 'bad' });
  assert.strictEqual(r.ok, false);
  assert.ok(r.errors.hr_aadhaar);
  assert.strictEqual(r.values.hr_pan, 'ABCDE1234F');
  assert.strictEqual(r.values.hr_ifsc, 'SBIN0001234');

  const good = v.validateEmployeeIdentity({ hr_pan: 'abcde1234f' });
  assert.strictEqual(good.ok, true);
  assert.strictEqual(good.values.hr_pan, 'ABCDE1234F');
});
