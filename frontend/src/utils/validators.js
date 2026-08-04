/**
 * Client-side identity/bank validation rules for react-hook-form (inline UX).
 * The backend (services/validators.js) is the authority — it re-validates and,
 * for Aadhaar, also enforces the Verhoeff checksum. These give instant feedback.
 */
export const BLOOD_GROUPS = ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'];

// Uppercase-on-blur helper for PAN/IFSC inputs.
export const upper = (e) => { e.target.value = e.target.value.toUpperCase(); };

export const panRule = {
  pattern: { value: /^[A-Za-z]{5}[0-9]{4}[A-Za-z]$/, message: 'Format: ABCDE1234F (5 letters, 4 digits, 1 letter)' },
};
export const aadhaarRule = {
  pattern: { value: /^[2-9][0-9]{11}$/, message: 'Aadhaar must be 12 digits and not start with 0 or 1' },
};
export const ifscRule = {
  pattern: { value: /^[A-Za-z]{4}0[A-Za-z0-9]{6}$/, message: 'Format: SBIN0001234 (4 letters, 0, 6 chars)' },
};
export const accountRule = {
  pattern: { value: /^[0-9]{9,18}$/, message: 'Account number must be 9-18 digits' },
};
export const uanRule = {
  pattern: { value: /^[0-9]{12}$/, message: 'UAN must be 12 digits' },
};
export const esicRule = {
  pattern: { value: /^[0-9]{10}([0-9]{7})?$/, message: 'ESIC must be 10 or 17 digits' },
};
export const phoneRule = {
  pattern: { value: /^(\+91|0)?[6-9][0-9]{9}$/, message: 'Enter a valid 10-digit Indian mobile number' },
};
