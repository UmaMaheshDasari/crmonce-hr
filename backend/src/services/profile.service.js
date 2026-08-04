/**
 * Employee Self-Service profile domain logic — the single source of truth for:
 *   - which fields an employee may edit on their OWN record (SELF_EDITABLE)
 *   - which changes require HR re-verification (VERIFY_TRIGGER)
 *   - profile completion % + the grouped "missing" list
 *   - writing the audit trail and firing notifications
 *
 * Security note: SELF_EDITABLE is the backend whitelist. Even a hand-crafted API
 * request cannot set a restricted field (ID, code, email, department, designation,
 * manager, salary, role, shift, employment type, joining date, status) — the route
 * strips everything not in this set for non-HR callers.
 */
const d365 = require('./d365.service');
const { notifyUser, broadcast } = require('./notification.service');
const { toValue } = require('./picklist');
const { ENTITY_SET: AUDIT_SET } = require('./provision-profile-audit');

const EMP = d365.constructor.entities.employee;

// Fields an employee may edit on their own profile (personal / identity / address /
// emergency / bank + photo). NOTHING else is writable by a non-HR user.
const SELF_EDITABLE = new Set([
  // Personal
  'hr_phone', 'hr_altphone', 'hr_personalemail', 'hr_dob', 'hr_gender', 'hr_maritalstatus', 'hr_nationality', 'hr_bloodgroup', 'hr_photourl',
  // Identity
  'hr_aadhaar', 'hr_pan', 'hr_passport', 'hr_drivinglicence', 'hr_uan', 'hr_pfnumber', 'hr_esic',
  // Address
  'hr_address', 'hr_permaddress', 'hr_city', 'hr_state', 'hr_country', 'hr_pincode',
  // Emergency
  'hr_emergencycontact', 'hr_emergencyrelation', 'hr_emergencyphone',
  // Bank
  'hr_bankname', 'hr_accountholder', 'hr_accountnumber', 'hr_ifsc', 'hr_branch', 'hr_chequeurl',
]);

// Changing any of these requires HR re-verification → status becomes 'pending'.
const VERIFY_TRIGGER = new Set([
  'hr_pan', 'hr_aadhaar',
  'hr_bankname', 'hr_accountholder', 'hr_accountnumber', 'hr_ifsc', 'hr_branch',
  'hr_address', 'hr_permaddress', 'hr_city', 'hr_state', 'hr_country', 'hr_pincode',
]);

// Human labels for audit rows / notifications.
const FIELD_LABELS = {
  hr_phone: 'Mobile Number', hr_altphone: 'Alternate Mobile', hr_personalemail: 'Personal Email',
  hr_dob: 'Date of Birth', hr_gender: 'Gender', hr_maritalstatus: 'Marital Status', hr_nationality: 'Nationality',
  hr_bloodgroup: 'Blood Group', hr_photourl: 'Photo',
  hr_aadhaar: 'Aadhaar', hr_pan: 'PAN', hr_passport: 'Passport', hr_drivinglicence: 'Driving Licence',
  hr_uan: 'UAN', hr_pfnumber: 'PF Number', hr_esic: 'ESIC',
  hr_address: 'Current Address', hr_permaddress: 'Permanent Address', hr_city: 'City', hr_state: 'State', hr_country: 'Country', hr_pincode: 'PIN Code',
  hr_emergencycontact: 'Emergency Contact', hr_emergencyrelation: 'Emergency Relationship', hr_emergencyphone: 'Emergency Phone',
  hr_bankname: 'Bank Name', hr_accountholder: 'Account Holder', hr_accountnumber: 'Account Number', hr_ifsc: 'IFSC', hr_branch: 'Branch', hr_chequeurl: 'Cancelled Cheque',
};

// Completion checklist (equal weight) + grouped missing labels.
const COMPLETION_FIELDS = [
  'hr_phone', 'hr_dob', 'hr_gender', 'hr_bloodgroup',
  'hr_pan', 'hr_aadhaar',
  'hr_address', 'hr_city', 'hr_state', 'hr_pincode',
  'hr_emergencycontact', 'hr_emergencyphone',
  'hr_bankname', 'hr_accountnumber', 'hr_ifsc',
];
const MISSING_GROUPS = [
  { label: 'PAN', fields: ['hr_pan'] },
  { label: 'Aadhaar', fields: ['hr_aadhaar'] },
  { label: 'Personal Info', fields: ['hr_phone', 'hr_dob', 'hr_gender'] },
  { label: 'Address', fields: ['hr_address', 'hr_city', 'hr_state', 'hr_pincode'] },
  { label: 'Emergency Contact', fields: ['hr_emergencycontact', 'hr_emergencyphone'] },
  { label: 'Bank Details', fields: ['hr_bankname', 'hr_accountnumber', 'hr_ifsc'] },
];

const filled = (v) => v !== undefined && v !== null && String(v).trim() !== '';

/** { percent, filled, total, missing:[labels] } */
function computeCompletion(emp = {}) {
  const total = COMPLETION_FIELDS.length;
  const done = COMPLETION_FIELDS.filter((f) => filled(emp[f])).length;
  const percent = Math.round((done / total) * 100);
  const missing = MISSING_GROUPS.filter((g) => g.fields.some((f) => !filled(emp[f]))).map((g) => g.label);
  return { percent, filled: done, total, missing };
}

/** Which whitelisted fields actually changed vs the current record. */
function diffChanges(current = {}, incoming = {}) {
  const changes = [];
  for (const f of Object.keys(incoming)) {
    if (!SELF_EDITABLE.has(f)) continue;
    const oldV = current[f] == null ? '' : String(current[f]);
    const newV = incoming[f] == null ? '' : String(incoming[f]);
    if (oldV !== newV) changes.push({ field: f, label: FIELD_LABELS[f] || f, oldValue: oldV, newValue: newV });
  }
  return changes;
}

const requiresVerification = (changes) => changes.some((c) => VERIFY_TRIGGER.has(c.field));

/** Write one audit row per changed field. Best-effort — never throws. */
async function writeAudit({ employeeId, employeeName, changes, updatedBy, action = 'updated', approvedBy = '', note = '' }) {
  const now = new Date().toISOString();
  for (const c of (changes || [])) {
    try {
      await d365.create(AUDIT_SET, {
        hr_name: `${employeeName} · ${c.label}`,
        hr_employeeid: employeeId, hr_employeename: employeeName,
        hr_field: c.label, hr_oldvalue: c.oldValue || '', hr_newvalue: c.newValue || '',
        hr_action: action, hr_updatedby: updatedBy || '', hr_updatedon: now,
        hr_approvedby: approvedBy || '', hr_note: note || '',
      });
    } catch (e) { global.logger?.warn?.(`[profile] audit write skipped (${c.field}): ${e.message}`); }
  }
}

async function readAudit(employeeId, top = 100) {
  try {
    const { data } = await d365.getList(AUDIT_SET, {
      select: 'hr_profileauditid,hr_field,hr_oldvalue,hr_newvalue,hr_action,hr_updatedby,hr_updatedon,hr_approvedby,hr_note,createdon',
      filter: `hr_employeeid eq '${employeeId}'`, orderby: 'createdon desc', top,
    });
    return data || [];
  } catch (e) { global.logger?.warn?.(`[profile] audit read failed: ${e.message}`); return []; }
}

/** Notify active HR / Super Admins that a profile needs verification. */
async function notifyHRVerification(employee) {
  try {
    const { data } = await d365.getList(EMP, {
      select: 'hr_hremployeeid',
      filter: `(hr_role eq ${toValue('hr_role', 'super_admin')} or hr_role eq ${toValue('hr_role', 'hr_manager')}) and hr_status eq ${toValue('hr_employee_status', 'active')}`,
    });
    for (const hr of data || []) notifyUser(hr.hr_hremployeeid, 'profile:verification', { employeeId: employee.id, employeeName: employee.name });
    broadcast('profile:verification', { employeeName: employee.name });
  } catch (e) { global.logger?.warn?.(`[profile] HR verify notify failed: ${e.message}`); }
}

module.exports = {
  SELF_EDITABLE, VERIFY_TRIGGER, FIELD_LABELS, COMPLETION_FIELDS,
  computeCompletion, diffChanges, requiresVerification, writeAudit, readAudit, notifyHRVerification,
  notifyUser,
};
