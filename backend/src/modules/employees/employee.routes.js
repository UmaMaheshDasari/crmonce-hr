const express = require('express');
const router = express.Router();
const d365 = require('../../services/d365.service');
const authService = require('../../services/auth.service');
const { requireRole, requirePermission } = require('../../middleware/auth.middleware');
const { toValue, labelsForList, labelsForEntity } = require('../../services/picklist');
const { validateCompanyEmail } = require('../../services/email/sender');
const { validateEmployeeIdentity } = require('../../services/validators');
const profile = require('../../services/profile.service');
const { sendEmail } = require('../../services/notification.service');
const T = require('../../services/email/templates');

const ENTITY = d365.constructor.entities.employee;

// ESS columns (provisioned by provision-employee-columns.js). Selected as OPTIONAL
// so the module keeps working before the columns exist.
const IDENTITY_FIELDS = 'hr_aadhaar,hr_pan,hr_passport,hr_drivinglicence,hr_uan,hr_esic,hr_pfnumber,hr_bloodgroup';
const PERSONAL_FIELDS = 'hr_altphone,hr_personalemail,hr_dob,hr_gender,hr_maritalstatus,hr_nationality,hr_photourl';
const ADDRESS_FIELDS = 'hr_permaddress,hr_city,hr_state,hr_country,hr_pincode';
const EMERGENCY_FIELDS = 'hr_emergencyphone,hr_emergencyrelation';
const VERIFY_FIELDS = 'hr_verifystatus,hr_verifiedby,hr_verifieddate,hr_verifynote';
const BANK_FIELDS = 'hr_bankname,hr_accountholder,hr_accountnumber,hr_ifsc,hr_branch,hr_chequeurl';
// Employee-master fields (HR-managed): code + employment metadata.
const MASTER_FIELDS = 'hr_employeecode,hr_confirmationdate,hr_relievingdate,hr_employmenttype,hr_worklocation';
const ESS_OPTIONAL_SELECT = [MASTER_FIELDS, IDENTITY_FIELDS, PERSONAL_FIELDS, ADDRESS_FIELDS, EMERGENCY_FIELDS, VERIFY_FIELDS, BANK_FIELDS].join(',');
// Every optional column that may not exist yet — stripped on a missing-property
// error so a not-yet-provisioned field never blocks create/edit.
const OPTIONAL_WRITE_FIELDS = [
  'hr_shiftname', 'hr_shiftstarttime', 'hr_shiftendtime',
  ...ESS_OPTIONAL_SELECT.split(','),
];

// Apply default shift when the (optional) columns are absent or empty, so the
// Employee module works before the Dataverse columns exist / migration runs.
function withShiftDefaults(e) {
  if (e && typeof e === 'object') {
    if (!e.hr_shiftname) e.hr_shiftname = 'General Shift';
    if (!e.hr_shiftstarttime) e.hr_shiftstarttime = '09:00';
    if (!e.hr_shiftendtime) e.hr_shiftendtime = '18:00';
  }
  return e;
}

const { ensureEmployeeColumns } = require('../../services/provision-employee-columns');

// Robust write: if Dataverse rejects a not-yet-provisioned column, PROVISION the
// employee columns once and retry the FULL payload; if a column still can't be
// created (e.g. app lacks customization rights), strip ONLY that named column and
// retry — so existing columns always persist and we never silently drop everything.
async function robustWrite(op, entity, id, data) {
  let payload = { ...data };
  let provisioned = false, strippedBind = false;
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      return op === 'create' ? await d365.create(entity, payload) : await d365.update(entity, id, payload);
    } catch (err) {
      // (a) unknown column → provision once, then strip only the named column.
      if (d365._isMissingProperty(err)) {
        if (!provisioned) {
          provisioned = true;
          try { await ensureEmployeeColumns(global.logger || console); continue; } catch { /* fall through */ }
        }
        const prop = d365._missingPropertyName(err);
        if (prop && Object.prototype.hasOwnProperty.call(payload, prop)) {
          global.logger?.warn?.(`[employee] column '${prop}' unavailable — saved without it`);
          delete payload[prop];
          if (Object.keys(payload).length) continue;
          return op === 'create' ? {} : d365.getById(entity, id);
        }
        throw err;
      }
      // (b) a lookup bind (@odata.bind) the tenant doesn't expose under this nav
      //     name → strip the bind(s) once and save the rest (never block the save).
      const bindKeys = Object.keys(payload).filter(k => k.endsWith('@odata.bind'));
      if (bindKeys.length && !strippedBind) {
        strippedBind = true;
        for (const k of bindKeys) delete payload[k];
        global.logger?.warn?.('[employee] lookup bind rejected — saved without the reporting-manager link');
        continue;
      }
      throw err;
    }
  }
  throw new Error('employee write failed after retries');
}
const createStrippingOptionalShift = (entity, data) => robustWrite('create', entity, null, data);
const updateStrippingOptionalShift = (entity, id, data) => robustWrite('update', entity, id, data);

// GET /api/employees
router.get('/', requirePermission('employee:read'), async (req, res, next) => {
  try {
    const { search, department, status, page = 1, limit = 20 } = req.query;
    const filters = [];
    // A plain employee may only ever see their own record (employee:read:self).
    if (req.user.role === 'employee') filters.push(`hr_hremployeeid eq ${req.user.id}`);
    if (search) filters.push(`contains(hr_hremployee1,'${search}') or contains(hr_email,'${search}')`);
    if (department) filters.push(`hr_department eq '${department}'`);
    if (status) filters.push(`hr_status eq ${toValue('hr_employee_status', status)}`);

    // Pagination: Dataverse ignores $skip, so fetch the first (page*limit) rows
    // with $top and slice the requested page server-side. @odata.count still
    // returns the TOTAL matched count for the page controls.
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const lim = Math.max(1, parseInt(limit, 10) || 20);

    // Shift columns are OPTIONAL: if the Dataverse columns don't exist
    // yet, the query degrades to the base columns instead of failing (which would
    // empty the whole list). Defaults are then applied below.
    const result = await d365.getListOptional(ENTITY, {
      select: 'hr_hremployeeid,hr_hremployee1,hr_email,hr_phone,hr_department,hr_designation,hr_status,hr_joiningdate,hr_role,_hr_manager_value',
      optionalSelect: 'hr_shiftname,hr_shiftstarttime,hr_shiftendtime,hr_employeecode,hr_etimecode',
      filter: filters.join(' and ') || undefined,
      orderby: 'hr_hremployee1 asc',
      top: pageNum * lim,
    });
    const pageData = (result.data || []).slice((pageNum - 1) * lim);
    pageData.forEach(withShiftDefaults);
    pageData.forEach(e => { e._employeeid = e.hr_employeecode || e.hr_etimecode || ''; });
    res.json(labelsForList(ENTITY, { data: pageData, count: result.count }));
  } catch (err) { next(err); }
});

// GET /api/employees/:id
router.get('/:id', requirePermission('employee:read'), async (req, res, next) => {
  try {
    // Employees can only see their own record
    if (req.user.role === 'employee' && req.params.id !== req.user.id) {
      return res.status(403).json({ error: 'Access denied' });
    }
    const emp = await d365.getByIdOptional(ENTITY, req.params.id, {
      select: 'hr_hremployeeid,hr_hremployee1,hr_email,hr_phone,hr_department,hr_designation,hr_status,hr_joiningdate,hr_address,hr_emergencycontact,hr_role,hr_salary,hr_allowances,hr_deductions,hr_etimecode,_hr_manager_value',
      optionalSelect: `hr_shiftname,hr_shiftstarttime,hr_shiftendtime,${ESS_OPTIONAL_SELECT}`,
    });
    const out = labelsForEntity(ENTITY, withShiftDefaults(emp));
    // Completion includes uploaded documents — never 100% while a required doc is missing.
    let documents = [];
    try {
      const dres = await d365.getList(d365.constructor.entities.document, { select: 'hr_name', filter: `_hr_hremployee_value eq '${req.params.id}'`, top: 100 });
      documents = (dres.data || []).map(d => d.hr_name);
    } catch { /* documents optional */ }
    out._completion = profile.computeCompletion(out, { documents });
    out._verifystatus = out.hr_verifystatus || 'verified';     // default (no pending changes)
    out._employeeid = out.hr_employeecode || out.hr_etimecode || '';   // human Employee ID (never GUID)
    res.json(out);
  } catch (err) { next(err); }
});

// Normalise an employee payload before writing to D365:
//  - drop empty/nullish values ('' is rejected by typed columns: Money/DateTime/Picklist)
//  - convert picklists (role/status) from label → numeric option-set value
//  - coerce money fields to numbers
function sanitizeEmployee(input) {
  const data = { ...input };
  for (const k of Object.keys(data)) {
    if (data[k] === '' || data[k] === null || data[k] === undefined) delete data[k];
  }
  if (data.hr_role !== undefined) data.hr_role = toValue('hr_role', data.hr_role);
  if (data.hr_status !== undefined) data.hr_status = toValue('hr_employee_status', data.hr_status);
  for (const f of ['hr_salary', 'hr_allowances', 'hr_deductions']) {
    if (data[f] !== undefined) data[f] = Number(data[f]) || 0;
  }
  return data;
}

// The independent Employee ID is an EMP#### code (e.g. EMP1020) — NEVER the
// Dataverse GUID. Existing employees already carry these in the eTime code, so we
// derive the next number from the MAX of both hr_employeecode and hr_etimecode,
// continuing the sequence (e.g. EMP1043 → EMP1044) instead of colliding at EMP0001.
const EMP_CODE_RE = /EMP0*(\d+)/i;
async function maxEmployeeCodeNumber() {
  let max = 0;
  try {
    const { data } = await d365.getListOptional(ENTITY, { select: 'hr_hremployeeid,hr_etimecode', optionalSelect: 'hr_employeecode', top: 5000 });
    for (const e of data || []) {
      for (const v of [e.hr_employeecode, e.hr_etimecode]) {
        const m = EMP_CODE_RE.exec(v || '');
        if (m) max = Math.max(max, parseInt(m[1], 10));
      }
    }
  } catch { /* columns may not exist yet → start at 1 */ }
  return max;
}
async function nextEmployeeCode() {
  return 'EMP' + String((await maxEmployeeCodeNumber()) + 1).padStart(4, '0');
}

// Bind the Reporting Manager lookup (best-effort — robustWrite strips it if the
// tenant exposes the nav property under a different name).
const GUID_RE = /^[0-9a-fA-F-]{36}$/;
const bindManager = (data, managerId) => {
  if (managerId && GUID_RE.test(String(managerId))) data['hr_Manager@odata.bind'] = `/hr_hremployees(${managerId})`;
  return data;
};

// POST /api/employees
router.post('/', requireRole('super_admin', 'hr_manager'), async (req, res, next) => {
  try {
    const { password, managerId, ...raw } = req.body;
    // Employee email must be a valid company mailbox — it is the sender of their
    // own leave requests (external providers like gmail are rejected).
    const ev = validateCompanyEmail(raw.hr_email, 'Employee');
    if (!ev.ok) return res.status(400).json({ error: ev.reason });
    // Validate + normalise identity/bank fields (PAN, Aadhaar, IFSC, account, …).
    const idv = validateEmployeeIdentity(raw);
    if (!idv.ok) return res.status(400).json({ error: Object.values(idv.errors)[0], fields: idv.errors });
    Object.assign(raw, idv.values);   // upper-cased PAN/IFSC, stripped Aadhaar, etc.
    // PAN & Aadhaar are MANDATORY.
    if (!String(raw.hr_pan || '').trim()) return res.status(400).json({ error: 'PAN Number is required.' });
    if (!String(raw.hr_aadhaar || '').trim()) return res.status(400).json({ error: 'Aadhaar Number is required.' });
    const employeeData = sanitizeEmployee(raw);
    if (password) employeeData.hr_password = await authService.hashPassword(password);
    if (employeeData.hr_status === undefined) employeeData.hr_status = toValue('hr_employee_status', 'active');
    // Auto-assign an independent Employee Code (EMP0001) unless one was provided.
    if (!employeeData.hr_employeecode) employeeData.hr_employeecode = await nextEmployeeCode();
    bindManager(employeeData, managerId);
    // Default shift so attendance math always has a start time (same as migration).
    if (!employeeData.hr_shiftname) employeeData.hr_shiftname = 'General Shift';
    if (!employeeData.hr_shiftstarttime) employeeData.hr_shiftstarttime = '09:00';
    if (!employeeData.hr_shiftendtime) employeeData.hr_shiftendtime = '18:00';
    const emp = await createStrippingOptionalShift(ENTITY, employeeData);
    res.status(201).json(emp);
  } catch (err) { next(err); }
});

// PATCH /api/employees/:id — HR edits anyone; an employee may edit ONLY their OWN
// personal/identity/address/emergency/bank details (ESS self-service). The backend
// whitelist (profile.SELF_EDITABLE) is the security boundary — a hand-crafted
// request cannot touch restricted fields (ID/code/email/dept/designation/manager/
// salary/role/shift/employment-type/joining-date/status).
router.patch('/:id', async (req, res, next) => {
  try {
    const isHRWrite = ['super_admin', 'hr_manager'].includes(req.user.role);
    const isSelf = req.user.id === req.params.id;
    if (!isHRWrite && !isSelf) return res.status(403).json({ error: 'Access denied' });

    const { password, managerId, ...raw } = req.body;

    // Employees editing themselves: keep ONLY the whitelisted fields.
    if (!isHRWrite) {
      Object.keys(raw).forEach(k => { if (!profile.SELF_EDITABLE.has(k)) delete raw[k]; });
    }

    // If HR is changing the WORK email, it must remain a valid company mailbox.
    if (isHRWrite && raw.hr_email !== undefined) {
      const ev = validateCompanyEmail(raw.hr_email, 'Employee');
      if (!ev.ok) return res.status(400).json({ error: ev.reason });
    }
    const idv = validateEmployeeIdentity(raw);
    if (!idv.ok) return res.status(400).json({ error: Object.values(idv.errors)[0], fields: idv.errors });
    Object.assign(raw, idv.values);

    // Diff against the current record (for audit + verification decisions).
    let current = {};
    try { current = await d365.getByIdOptional(ENTITY, req.params.id, { select: 'hr_hremployee1', optionalSelect: ESS_OPTIONAL_SELECT }); } catch { /* best-effort */ }
    const changes = profile.diffChanges(current, raw);

    // A self-service change to PAN / Aadhaar / Bank / Address requires HR re-verification.
    const needsVerify = !isHRWrite && profile.requiresVerification(changes);
    if (needsVerify) {
      raw.hr_verifystatus = 'pending';
      raw.hr_verifynote = '';
    }

    const updateData = sanitizeEmployee(raw);
    if (password && isHRWrite) updateData.hr_password = await authService.hashPassword(password);
    if (isHRWrite) bindManager(updateData, managerId);   // only HR can set Reporting Manager
    const emp = await updateStrippingOptionalShift(ENTITY, req.params.id, updateData);

    // Audit every changed field + notify (best-effort; never fails the save).
    const empName = current.hr_hremployee1 || req.user.name || 'Employee';
    if (changes.length) {
      profile.writeAudit({ employeeId: req.params.id, employeeName: empName, changes, updatedBy: req.user.name || req.user.email, action: 'updated' }).catch(() => {});
    }
    profile.notifyUser(req.params.id, 'profile:updated', { verification: needsVerify });
    if (needsVerify) profile.notifyHRVerification({ id: req.params.id, name: empName }).catch(() => {});

    res.json({ ...emp, _verifystatus: needsVerify ? 'pending' : (raw.hr_verifystatus || current.hr_verifystatus || 'verified'), _pendingVerification: needsVerify });
  } catch (err) { next(err); }
});

// PATCH /api/employees/:id/verify — HR approves / rejects / requests changes.
router.patch('/:id/verify', requireRole('super_admin', 'hr_manager'), async (req, res, next) => {
  try {
    const { action, note } = req.body;   // approve | reject | request_changes
    const map = { approve: 'verified', reject: 'rejected', request_changes: 'changes' };
    const status = map[action];
    if (!status) return res.status(400).json({ error: 'action must be approve, reject or request_changes.' });

    const emp = await updateStrippingOptionalShift(ENTITY, req.params.id, {
      hr_verifystatus: status,
      hr_verifiedby: req.user.name || req.user.email || 'HR',
      hr_verifieddate: new Date().toISOString(),
      hr_verifynote: note || '',
    });
    let name = 'Employee', email = '';
    try { const e = await d365.getById(ENTITY, req.params.id, { select: 'hr_hremployee1,hr_email' }); name = e.hr_hremployee1 || name; email = e.hr_email || ''; } catch {}
    profile.writeAudit({ employeeId: req.params.id, employeeName: name, changes: [{ field: 'hr_verifystatus', label: 'Verification', oldValue: 'pending', newValue: status }], updatedBy: req.user.name || req.user.email, action: action === 'approve' ? 'approved' : action === 'reject' ? 'rejected' : 'changes_requested', approvedBy: req.user.name || req.user.email, note }).catch(() => {});
    profile.notifyUser(req.params.id, 'profile:verified', { status, note: note || '' });
    // On reject / request-changes, email the employee the reason (best-effort).
    if ((action === 'reject' || action === 'request_changes') && email) {
      const label = action === 'reject' ? 'Rejected' : 'Changes Requested';
      const content =
        `<p style="margin:0 0 12px;font-size:15px;color:#111827;">Dear ${T._esc(name)},</p>` +
        `<p style="margin:0 0 4px;color:#374151;">Your recent profile update has been <strong>${label.toLowerCase()}</strong> by HR.</p>` +
        T.summaryCard('Details', [['Decision', T._esc(label)], ['Reason', T._esc(note || '—')]]) +
        T.banner('Please review the note, update your profile in the HR Portal and resubmit.');
      sendEmail(email, `Profile Update ${label} — Action Needed`, T.layout({ title: 'Profile Update', preheader: `Your profile update was ${label.toLowerCase()}`, content }), { meta: { type: 'profile_decision' } })
        .catch((e) => global.logger?.warn?.(`[profile] reject email failed: ${e.message}`));
    }
    res.json({ ...emp, _verifystatus: status });
  } catch (err) {
    console.error('[profile/verify] FAILED:', err.message);
    res.status(err.status || 400).json({ error: err.message || 'Failed to update verification' });
  }
});

// GET /api/employees/:id/profile-audit — change history (self or HR)
router.get('/:id/profile-audit', async (req, res, next) => {
  try {
    const isHR = ['super_admin', 'hr_manager'].includes(req.user.role);
    if (!isHR && req.user.id !== req.params.id) return res.status(403).json({ error: 'Access denied' });
    res.json({ data: await profile.readAudit(req.params.id) });
  } catch (err) { next(err); }
});

// DELETE /api/employees/:id (soft delete)
router.delete('/:id', requireRole('super_admin'), async (req, res, next) => {
  try {
    await d365.update(ENTITY, req.params.id, { hr_status: toValue('hr_employee_status', 'inactive') });
    res.json({ message: 'Employee deactivated' });
  } catch (err) { next(err); }
});

// GET /api/employees/meta/departments
router.get('/meta/departments', async (req, res, next) => {
  try {
    const result = await d365.getList(d365.constructor.entities.department, {
      select: 'hr_hrdepartmentid,hr_hrdepartment1',
      orderby: 'hr_hrdepartment1 asc',
    });
    res.json(result);
  } catch (err) { next(err); }
});

// GET /api/employees/verifications/pending — HR queue of profiles awaiting review.
router.get('/verifications/pending', requireRole('super_admin', 'hr_manager'), async (req, res, next) => {
  try {
    const { data } = await d365.getListOptional(ENTITY, {
      select: 'hr_hremployeeid,hr_hremployee1,hr_department,hr_etimecode',
      optionalSelect: `${MASTER_FIELDS},${VERIFY_FIELDS}`,
      top: 5000,
    });
    const pending = (data || []).filter(e => e.hr_verifystatus === 'pending');
    const rows = await Promise.all(pending.map(async (e) => {
      const pc = await profile.readPendingChanges(e.hr_hremployeeid);
      return {
        id: e.hr_hremployeeid, code: e.hr_employeecode || e.hr_etimecode || '', name: e.hr_hremployee1,
        department: e.hr_department || '', status: 'pending',
        sections: pc.sections, changes: pc.changes, submittedOn: pc.submittedOn,
      };
    }));
    res.json({ data: rows, count: rows.length });
  } catch (err) { next(err); }
});

// POST /api/employees/meta/backfill-codes — set Employee ID for employees missing
// one. Reuses their existing eTime EMP code when present (so EMP1020 stays EMP1020);
// otherwise assigns the next number in the sequence.
router.post('/meta/backfill-codes', requireRole('super_admin', 'hr_manager'), async (req, res, next) => {
  try {
    const { data } = await d365.getListOptional(ENTITY, { select: 'hr_hremployeeid,hr_etimecode,createdon', optionalSelect: 'hr_employeecode', top: 5000, orderby: 'createdon asc' });
    let max = 0;
    for (const e of data || []) { for (const v of [e.hr_employeecode, e.hr_etimecode]) { const m = EMP_CODE_RE.exec(v || ''); if (m) max = Math.max(max, parseInt(m[1], 10)); } }
    let assigned = 0;
    for (const e of data || []) {
      if (e.hr_employeecode) continue;
      let code;
      const et = String(e.hr_etimecode || '').trim();
      if (/^EMP\d+$/i.test(et)) code = et.toUpperCase();     // reuse existing eTime EMP code
      else { max += 1; code = 'EMP' + String(max).padStart(4, '0'); }
      await updateStrippingOptionalShift(ENTITY, e.hr_hremployeeid, { hr_employeecode: code });
      assigned += 1;
    }
    res.json({ message: `Assigned ${assigned} employee code(s)`, assigned });
  } catch (err) { next(err); }
});

module.exports = router;
