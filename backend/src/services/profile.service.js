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
  'hr_aadhaar', 'hr_pan', 'hr_passport', 'hr_uan', 'hr_pfnumber',
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
  hr_aadhaar: 'Aadhaar', hr_pan: 'PAN', hr_passport: 'Passport',
  hr_uan: 'UAN', hr_pfnumber: 'PF Number',
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

// Field → section (used to label "Changed Section" in HR Verification).
const SECTION_OF = {
  hr_phone: 'Personal', hr_altphone: 'Personal', hr_personalemail: 'Personal', hr_dob: 'Personal',
  hr_gender: 'Personal', hr_maritalstatus: 'Personal', hr_nationality: 'Personal', hr_bloodgroup: 'Personal', hr_photourl: 'Personal',
  hr_aadhaar: 'Identity', hr_pan: 'Identity', hr_passport: 'Identity', hr_uan: 'Identity', hr_pfnumber: 'Identity',
  hr_address: 'Address', hr_permaddress: 'Address', hr_city: 'Address', hr_state: 'Address', hr_country: 'Address', hr_pincode: 'Address',
  hr_emergencycontact: 'Emergency', hr_emergencyrelation: 'Emergency', hr_emergencyphone: 'Emergency',
  hr_bankname: 'Bank', hr_accountholder: 'Bank', hr_accountnumber: 'Bank', hr_ifsc: 'Bank', hr_branch: 'Bank', hr_chequeurl: 'Bank',
};
// Mask sensitive values for display (account number, Aadhaar → last 4 digits).
function maskValue(field, v) {
  const s = v == null ? '' : String(v);
  if (!s) return '';
  if (field === 'hr_accountnumber' || field === 'hr_aadhaar') {
    const digits = s.replace(/\s/g, '');
    return digits.length > 4 ? `${'X'.repeat(digits.length - 4)}${digits.slice(-4)}` : s;
  }
  return s;
}

const filled = (v) => v !== undefined && v !== null && String(v).trim() !== '';

// Documents that count toward completion — profile is NEVER 100% while any is missing.
const REQUIRED_DOCS = ['Aadhaar Card', 'PAN Card', 'Cancelled Cheque', 'Photo'];

/**
 * { percent, filled, total, missing:[labels] } across Personal / Identity / Address /
 * Bank / Emergency AND the company's Required Documents (which must be VERIFIED).
 * @param {object} emp    employee record
 * @param {object} [opts] { documents: [{type,name,status}], requiredDocs: string[] }
 */
function computeCompletion(emp = {}, opts = {}) {
  const requiredDocs = (opts.requiredDocs && opts.requiredDocs.length) ? opts.requiredDocs : REQUIRED_DOCS;
  // A required doc counts only when an uploaded doc of that type/name is VERIFIED.
  const verified = new Set();
  for (const d of opts.documents || []) {
    if (String(d.status || '').toLowerCase() !== 'verified') continue;
    if (d.type) verified.add(String(d.type).toLowerCase());
    if (d.name) verified.add(String(d.name).toLowerCase());
  }
  const missingDocs = requiredDocs.filter((r) => !verified.has(String(r).toLowerCase()));

  const fieldTotal = COMPLETION_FIELDS.length;
  const total = fieldTotal + requiredDocs.length;
  const doneFields = COMPLETION_FIELDS.filter((f) => filled(emp[f])).length;
  const doneDocs = requiredDocs.length - missingDocs.length;
  const percent = total ? Math.round(((doneFields + doneDocs) / total) * 100) : 0;

  const missing = MISSING_GROUPS.filter((g) => g.fields.some((f) => !filled(emp[f]))).map((g) => g.label);
  for (const md of missingDocs) missing.push(md);   // list each missing required doc
  return { percent, filled: doneFields + doneDocs, total, missing };
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

// Field-label → logical field name (reverse of FIELD_LABELS) so audit rows (which
// store the human label) can be mapped back to a section + masked.
const LABEL_TO_FIELD = Object.fromEntries(Object.entries(FIELD_LABELS).map(([k, v]) => [v, k]));

/**
 * The changes an employee made SINCE their last HR decision (approve/reject/
 * request_changes) — i.e. what's actually pending. Returns grouped sections +
 * masked old→new pairs.
 */
async function readPendingChanges(employeeId) {
  const rows = await readAudit(employeeId, 200);   // newest first
  const changes = [];
  for (const r of rows) {
    if (r.hr_action && r.hr_action !== 'updated') break;   // reached the last decision boundary
    const field = LABEL_TO_FIELD[r.hr_field] || r.hr_field;
    changes.push({
      field, label: r.hr_field, section: SECTION_OF[field] || 'Personal',
      oldValue: maskValue(field, r.hr_oldvalue), newValue: maskValue(field, r.hr_newvalue),
      updatedOn: r.hr_updatedon || r.createdon,
    });
  }
  const sections = [...new Set(changes.map((c) => c.section))];
  const submittedOn = changes[0]?.updatedOn || null;
  return { changes, sections, submittedOn };
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
  SELF_EDITABLE, VERIFY_TRIGGER, FIELD_LABELS, COMPLETION_FIELDS, SECTION_OF, REQUIRED_DOCS,
  computeCompletion, diffChanges, requiresVerification, writeAudit, readAudit, readPendingChanges,
  maskValue, notifyHRVerification, notifyUser,
};
