const express = require('express');
const router = express.Router();
const d365 = require('../../services/d365.service');
const authService = require('../../services/auth.service');
const { requireRole, requirePermission } = require('../../middleware/auth.middleware');
const { toValue, labelsForList, labelsForEntity } = require('../../services/picklist');
const { validateCompanyEmail } = require('../../services/email/sender');

const ENTITY = d365.constructor.entities.employee;

// Apply default shift when the (optional) columns are absent or empty, so the
// Employee module works before the Dataverse columns exist / migration runs.
function withShiftDefaults(e) {
  if (e && typeof e === 'object') {
    if (!e.hr_shift) e.hr_shift = 'General Shift';
    if (!e.hr_shiftstart) e.hr_shiftstart = '09:00';
  }
  return e;
}

// create/update that retry WITHOUT the shift columns if Dataverse rejects them
// as unknown — so a not-yet-created field never blocks create/edit.
async function createStrippingOptionalShift(entity, data) {
  try { return await d365.create(entity, data); }
  catch (err) {
    if (!d365._isMissingProperty(err)) throw err;
    const { hr_shift, hr_shiftstart, ...rest } = data;
    return d365.create(entity, rest);
  }
}
async function updateStrippingOptionalShift(entity, id, data) {
  try { return await d365.update(entity, id, data); }
  catch (err) {
    if (!d365._isMissingProperty(err)) throw err;
    const { hr_shift, hr_shiftstart, ...rest } = data;
    return d365.update(entity, id, rest);
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

    // hr_shift/hr_shiftstart are OPTIONAL: if the Dataverse columns don't exist
    // yet, the query degrades to the base columns instead of failing (which would
    // empty the whole list). Defaults are then applied below.
    const result = await d365.getListOptional(ENTITY, {
      select: 'hr_hremployeeid,hr_hremployee1,hr_email,hr_phone,hr_department,hr_designation,hr_status,hr_joiningdate,hr_role,_hr_manager_value',
      optionalSelect: 'hr_shift,hr_shiftstart',
      filter: filters.join(' and ') || undefined,
      orderby: 'hr_hremployee1 asc',
      top: limit,
      skip: (page - 1) * limit,
    });
    (result.data || []).forEach(withShiftDefaults);
    res.json(labelsForList(ENTITY, result));
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
      optionalSelect: 'hr_shift,hr_shiftstart',
    });
    res.json(labelsForEntity(ENTITY, withShiftDefaults(emp)));
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
    const employeeData = sanitizeEmployee(raw);
    if (password) employeeData.hr_password = await authService.hashPassword(password);
    if (employeeData.hr_status === undefined) employeeData.hr_status = toValue('hr_employee_status', 'active');
    // Default shift so attendance math always has a start time (same as migration).
    if (!employeeData.hr_shift) employeeData.hr_shift = 'General Shift';
    if (!employeeData.hr_shiftstart) employeeData.hr_shiftstart = '09:00';
    const emp = await createStrippingOptionalShift(ENTITY, employeeData);
    res.status(201).json(emp);
  } catch (err) { next(err); }
});

// PATCH /api/employees/:id
router.patch('/:id', requirePermission('employee:write'), async (req, res, next) => {
  try {
    const { password, ...raw } = req.body;
    // If the email is being changed, it must remain a valid company mailbox.
    if (raw.hr_email !== undefined) {
      const ev = validateCompanyEmail(raw.hr_email, 'Employee');
      if (!ev.ok) return res.status(400).json({ error: ev.reason });
    }
    const updateData = sanitizeEmployee(raw);
    if (password) updateData.hr_password = await authService.hashPassword(password);
    const emp = await updateStrippingOptionalShift(ENTITY, req.params.id, updateData);
    res.json(emp);
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
