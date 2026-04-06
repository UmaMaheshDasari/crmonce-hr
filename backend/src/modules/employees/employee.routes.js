const express = require('express');
const router = express.Router();
const d365 = require('../../services/d365.service');
const authService = require('../../services/auth.service');
const { requireRole, requirePermission } = require('../../middleware/auth.middleware');
const { toValue, labelsForList, labelsForEntity } = require('../../services/picklist');

const ENTITY = d365.constructor.entities.employee;

// GET /api/employees
router.get('/', requirePermission('employee:read'), async (req, res, next) => {
  try {
    const { search, department, status, page = 1, limit = 20 } = req.query;
    const filters = [];
    if (search) filters.push(`contains(hr_hremployee1,'${search}') or contains(hr_email,'${search}')`);
    if (department) filters.push(`hr_department eq '${department}'`);
    if (status) filters.push(`hr_status eq ${toValue('hr_employee_status', status)}`);

    const result = await d365.getList(ENTITY, {
      select: 'hr_hremployeeid,hr_hremployee1,hr_email,hr_phone,hr_department,hr_designation,hr_status,hr_joiningdate,hr_role,_hr_manager_value',
      filter: filters.join(' and ') || undefined,
      orderby: 'hr_hremployee1 asc',
      top: limit,
      skip: (page - 1) * limit,
    });
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
    const emp = await d365.getById(ENTITY, req.params.id, {
      select: 'hr_hremployeeid,hr_hremployee1,hr_email,hr_phone,hr_department,hr_designation,hr_status,hr_joiningdate,hr_address,hr_emergencycontact,hr_role,hr_salary,hr_allowances,hr_deductions,hr_etimecode,_hr_manager_value',
    });
    res.json(labelsForEntity(ENTITY, emp));
  } catch (err) { next(err); }
});

// POST /api/employees
router.post('/', requireRole('super_admin', 'hr_manager'), async (req, res, next) => {
  try {
    const { password, ...employeeData } = req.body;
    if (password) employeeData.hr_password = await authService.hashPassword(password);
    employeeData.hr_status = toValue('hr_employee_status', employeeData.hr_status || 'active');
    const emp = await d365.create(ENTITY, employeeData);
    res.status(201).json(emp);
  } catch (err) { next(err); }
});

// PATCH /api/employees/:id
router.patch('/:id', requirePermission('employee:write'), async (req, res, next) => {
  try {
    const { password, ...updateData } = req.body;
    if (password) updateData.hr_password = await authService.hashPassword(password);
    const emp = await d365.update(ENTITY, req.params.id, updateData);
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
