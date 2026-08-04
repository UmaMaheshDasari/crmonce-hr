/**
 * Indian identity / bank field validators — pure, no I/O, unit-testable.
 *
 * Each validator returns { ok:true, value } (normalised, e.g. upper-cased) or
 * { ok:false, reason }. Empty input is treated as "not provided" → ok (these
 * fields are optional); callers enforce required-ness separately.
 */

const empty = (v) => v === undefined || v === null || String(v).trim() === '';

// ── PAN: 5 letters, 4 digits, 1 letter (e.g. ABCDE1234F) ──
// 4th char is the holder type, 5th is the surname initial. Upper-cased.
const PAN_RE = /^[A-Z]{5}[0-9]{4}[A-Z]$/;
function validatePAN(v) {
  if (empty(v)) return { ok: true, value: '' };
  const s = String(v).trim().toUpperCase();
  if (!PAN_RE.test(s)) return { ok: false, reason: 'PAN must be 5 letters, 4 digits, 1 letter (e.g. ABCDE1234F).' };
  return { ok: true, value: s };
}

// ── Aadhaar: 12 digits, first digit 2-9, Verhoeff checksum valid ──
// The Verhoeff algorithm is the official Aadhaar check-digit scheme.
const D = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], [1, 2, 3, 4, 0, 6, 7, 8, 9, 5], [2, 3, 4, 0, 1, 7, 8, 9, 5, 6],
  [3, 4, 0, 1, 2, 8, 9, 5, 6, 7], [4, 0, 1, 2, 3, 9, 5, 6, 7, 8], [5, 9, 8, 7, 6, 0, 4, 3, 2, 1],
  [6, 5, 9, 8, 7, 1, 0, 4, 3, 2], [7, 6, 5, 9, 8, 2, 1, 0, 4, 3], [8, 7, 6, 5, 9, 3, 2, 1, 0, 4],
  [9, 8, 7, 6, 5, 4, 3, 2, 1, 0],
];
const P = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], [1, 5, 7, 6, 2, 8, 3, 0, 9, 4], [5, 8, 0, 3, 7, 9, 6, 1, 4, 2],
  [8, 9, 1, 6, 0, 4, 3, 5, 2, 7], [9, 4, 5, 3, 1, 2, 6, 8, 7, 0], [4, 2, 8, 6, 5, 7, 3, 9, 0, 1],
  [2, 7, 9, 3, 8, 0, 6, 4, 1, 5], [7, 0, 4, 6, 9, 1, 3, 2, 5, 8],
];
function verhoeffValid(num) {
  let c = 0;
  const digits = String(num).split('').reverse().map(Number);
  for (let i = 0; i < digits.length; i++) c = D[c][P[i % 8][digits[i]]];
  return c === 0;
}
function validateAadhaar(v) {
  if (empty(v)) return { ok: true, value: '' };
  const s = String(v).replace(/\s|-/g, '');
  // Per spec: exactly 12 digits.
  if (!/^[0-9]{12}$/.test(s)) return { ok: false, reason: 'Aadhaar must be exactly 12 digits.' };
  return { ok: true, value: s };
}

// ── IFSC: 4 letters + 0 + 6 alphanumeric (e.g. SBIN0001234) ──
const IFSC_RE = /^[A-Z]{4}0[A-Z0-9]{6}$/;
function validateIFSC(v) {
  if (empty(v)) return { ok: true, value: '' };
  const s = String(v).trim().toUpperCase();
  if (!IFSC_RE.test(s)) return { ok: false, reason: 'IFSC must be 4 letters, 0, then 6 characters (e.g. SBIN0001234).' };
  return { ok: true, value: s };
}

// ── Bank account number: 9-18 digits ──
function validateAccountNumber(v) {
  if (empty(v)) return { ok: true, value: '' };
  const s = String(v).replace(/\s/g, '');
  if (!/^[0-9]{9,18}$/.test(s)) return { ok: false, reason: 'Account number must be 9 to 18 digits.' };
  return { ok: true, value: s };
}

// ── UAN (PF universal account number): 12 digits ──
function validateUAN(v) {
  if (empty(v)) return { ok: true, value: '' };
  const s = String(v).replace(/\s/g, '');
  if (!/^[0-9]{12}$/.test(s)) return { ok: false, reason: 'UAN must be 12 digits.' };
  return { ok: true, value: s };
}

// ── ESIC insurance number: 10 or 17 digits ──
function validateESIC(v) {
  if (empty(v)) return { ok: true, value: '' };
  const s = String(v).replace(/\s/g, '');
  if (!/^[0-9]{10}([0-9]{7})?$/.test(s)) return { ok: false, reason: 'ESIC number must be 10 or 17 digits.' };
  return { ok: true, value: s };
}

// ── Blood group: one of the 8 ABO/Rh groups ──
const BLOOD_GROUPS = ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'];
function validateBloodGroup(v) {
  if (empty(v)) return { ok: true, value: '' };
  const s = String(v).trim().toUpperCase();
  if (!BLOOD_GROUPS.includes(s)) return { ok: false, reason: `Blood group must be one of: ${BLOOD_GROUPS.join(', ')}.` };
  return { ok: true, value: s };
}

// ── Indian mobile: 10 digits starting 6-9 (optional +91 / 0 prefix) ──
function validatePhone(v) {
  if (empty(v)) return { ok: true, value: '' };
  const s = String(v).replace(/[\s-]/g, '').replace(/^(\+91|0)/, '');
  if (!/^[6-9][0-9]{9}$/.test(s)) return { ok: false, reason: 'Phone must be a valid 10-digit Indian mobile number.' };
  return { ok: true, value: s };
}

/**
 * Validate a bag of identity/bank fields at once (used by the employee create/
 * update route). Returns { ok, errors:{field:reason}, values:{field:normalised} }.
 * Only validates the fields that are present; unknown keys are ignored.
 */
// ── Simple email (personal email — any provider allowed, unlike work email) ──
function validateEmail(v) {
  if (empty(v)) return { ok: true, value: '' };
  const s = String(v).trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) return { ok: false, reason: 'Enter a valid email address.' };
  return { ok: true, value: s.toLowerCase() };
}

// ── Enum helpers (Gender, Marital Status) ──
const GENDERS = ['Male', 'Female'];
const MARITAL = ['Single', 'Married'];
const enumValidator = (allowed, label) => (v) => {
  if (empty(v)) return { ok: true, value: '' };
  const s = String(v).trim();
  const hit = allowed.find((a) => a.toLowerCase() === s.toLowerCase());
  return hit ? { ok: true, value: hit } : { ok: false, reason: `${label} must be one of: ${allowed.join(', ')}.` };
};
const validateGender = enumValidator(GENDERS, 'Gender');
const validateMarital = enumValidator(MARITAL, 'Marital status');

const FIELD_VALIDATORS = {
  hr_pan: validatePAN,
  hr_aadhaar: validateAadhaar,
  hr_ifsc: validateIFSC,
  hr_accountnumber: validateAccountNumber,
  hr_uan: validateUAN,
  hr_esic: validateESIC,
  hr_bloodgroup: validateBloodGroup,
  hr_emergencyphone: validatePhone,
  hr_phone: validatePhone,
  hr_altphone: validatePhone,
  hr_personalemail: validateEmail,
  hr_gender: validateGender,
  hr_maritalstatus: validateMarital,
};
function validateEmployeeIdentity(body) {
  const errors = {};
  const values = {};
  for (const [field, fn] of Object.entries(FIELD_VALIDATORS)) {
    if (body[field] === undefined) continue;
    const r = fn(body[field]);
    if (!r.ok) errors[field] = r.reason;
    else if (r.value !== undefined) values[field] = r.value;
  }
  return { ok: Object.keys(errors).length === 0, errors, values };
}

module.exports = {
  validatePAN, validateAadhaar, validateIFSC, validateAccountNumber,
  validateUAN, validateESIC, validateBloodGroup, validatePhone,
  validateEmail, validateGender, validateMarital,
  verhoeffValid, validateEmployeeIdentity, BLOOD_GROUPS, GENDERS, MARITAL,
};
