const express = require('express');
const router = express.Router();
const d365 = require('../../services/d365.service');
const authService = require('../../services/auth.service');
const { requireRole, requirePermission } = require('../../middleware/auth.middleware');
const { toValue, labelsForList, labelsForEntity } = require('../../services/picklist');
const { validateCompanyEmail } = require('../../services/email/sender');
const { validateEmployeeIdentity } = require('../../services/validators');
const profile = require('../../services/profile.service');

const ENTITY = d365.constructor.entities.employee;

// ESS columns (provisioned by provision-employee-columns.js). Selected as OPTIONAL
// so the module keeps working before the columns exist.
const IDENTITY_FIELDS = 'hr_aadhaar,hr_pan,hr_passport,hr_drivinglicence,hr_uan,hr_esic,hr_pfnumber,hr_bloodgroup';
const PERSONAL_FIELDS = 'hr_altphone,hr_personalemail,hr_dob,hr_gender,hr_maritalstatus,hr_nationality,hr_photourl';
const ADDRESS_FIELDS = 'hr_permaddress,hr_city,hr_state,hr_country,hr_pincode';
const EMERGENCY_FIELDS = 'hr_emergencyphone,hr_emergencyrelation';
const VERIFY_FIELDS = 'hr_verifystatus,hr_verifiedby,hr_verifieddate,hr_verifynote';
const BANK_FIELDS = 'hr_bankname,hr_accountholder,hr_accountnumber,hr_ifsc,hr_branch,hr_chequeurl';
const ESS_OPTIONAL_SELECT = [IDENTITY_FIELDS, PERSONAL_FIELDS, ADDRESS_FIELDS, EMERGENCY_FIELDS, VERIFY_FIELDS, BANK_FIELDS].join(',');
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

// create/update that retry WITHOUT the optional columns (shift + identity + bank)
// if Dataverse rejects them as unknown — so a not-yet-provisioned field never
// blocks create/edit.
const stripOptional = (data) => {
  const rest = { ...data };
  for (const f of OPTIONAL_WRITE_FIELDS) delete rest[f];
  return rest;
};
async function createStrippingOptionalShift(entity, data) {
  try { return await d365.create(entity, data); }
  catch (err) {
    if (!d365._isMissingProperty(err)) throw err;
    return d365.create(entity, stripOptional(data));
  }
}
async function updateStrippingOptionalShift(entity, id, data) {
  try { return await d365.update(entity, id, data); }
  catch (err) {
    if (!d365._isMissingProperty(err)) throw err;
    return d365.update(entity, id, stripOptional(data));
  }
}

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
      optionalSelect: 'hr_shiftname,hr_shiftstarttime,hr_shiftendtime',
      filter: filters.join(' and ') || undefined,
      orderby: 'hr_hremployee1 asc',
      top: pageNum * lim,
    });
    const pageData = (result.data || []).slice((pageNum - 1) * lim);
    pageData.forEach(withShiftDefaults);
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
    out._completion = profile.computeCompletion(out);          // { percent, missing, … }
    out._verifystatus = out.hr_verifystatus || 'verified';     // default (no pending changes)
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

// POST /api/employees
router.post('/', requireRole('super_admin', 'hr_manager'), async (req, res, next) => {
  try {
    const { password, ...raw } = req.body;
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

    const { password, ...raw } = req.body;

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
    let name = 'Employee';
    try { const e = await d365.getById(ENTITY, req.params.id, { select: 'hr_hremployee1' }); name = e.hr_hremployee1 || name; } catch {}
    profile.writeAudit({ employeeId: req.params.id, employeeName: name, changes: [{ field: 'hr_verifystatus', label: 'Verification', oldValue: 'pending', newValue: status }], updatedBy: req.user.name || req.user.email, action: action === 'approve' ? 'approved' : action === 'reject' ? 'rejected' : 'changes_requested', approvedBy: req.user.name || req.user.email, note }).catch(() => {});
    profile.notifyUser(req.params.id, 'profile:verified', { status, note: note || '' });
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

module.exports = router;
