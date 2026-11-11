const express = require('express');
const router = express.Router();
const d365 = require('../../services/d365.service');
const { requireRole, requireAnyPermission } = require('../../middleware/auth.middleware');
const { resolvePhoto } = require('../../services/employee-photo.util');
const svc = require('../../services/salary-structure.service');
const { ensureSalaryStructureTable, addMissingColumn } = require('../../services/provision-salary-structure');

const ENTITY = d365.constructor.entities.salaryStructure;   // 'hr_salarystructures'
const EMP = d365.constructor.entities.employee;
const HR_ROLES = ['super_admin', 'hr_manager'];

// Salary Structure is an HR/Admin module — it is NOT available to normal employees
// (they see their pay via My Payslips). Block the employee role outright on every
// read; the write routes are already requireRole(HR). Returns 403 Forbidden.
function blockEmployees(req, res, next) {
  if (req.user?.role === 'employee') {
    return res.status(403).json({ error: 'Salary Structure is not available for employees. Please use My Payslips.' });
  }
  next();
}

const tableMissing = (err) =>
  d365._isBadSegment?.(err) ||
  /Resource not found for the segment|Could not find a property|does not exist|was not found|404/i.test(err?.message || '');

// Create/update that self-heals a partially-provisioned table: provisions the
// table (or a missing column) then retries once. WE own every column, so this
// only fires on a first run before provisioning has finished.
async function writeWithRepair(fn) {
  try { return await fn(); }
  catch (err) {
    if (tableMissing(err)) { await ensureSalaryStructureTable(global.logger || console).catch(() => {}); return await fn(); }
    if (d365._isMissingProperty?.(err) && d365._missingPropertyName) {
      const col = d365._missingPropertyName(err);
      if (col) { await addMissingColumn(col, global.logger || console).catch(() => {}); return await fn(); }
    }
    throw err;
  }
}

// Join hr_employeeid → Employee master for Name / Employee ID (EMP1039) / Dept /
// Designation / Photo (same enrichment the Goals module uses).
async function enrich(rows) {
  const ids = [...new Set((rows || []).map(r => r.employeeId).filter(Boolean))];
  if (!ids.length) return rows;
  let map = new Map();
  try {
    const { data } = await d365.getListOptional(EMP, {
      select: 'hr_hremployeeid,hr_hremployee1,hr_department,hr_designation',
      optionalSelect: 'hr_employeeid,hr_employeecode,hr_etimecode,hr_photourl,hr_personalphotourl,hr_photoremoved,hr_designation', top: 5000,
    });
    map = new Map((data || []).map(e => [e.hr_hremployeeid, e]));
  } catch { /* enrichment is best-effort */ }
  for (const r of rows) {
    const e = map.get(r.employeeId);
    r._employee = {
      name: e?.hr_hremployee1 || r.employeeName || '',
      employeeId: e?.hr_employeeid || e?.hr_etimecode || e?.hr_employeecode || '',
      department: e?.hr_department || '',
      designation: e?.hr_designation || '',
      photo: resolvePhoto(e),
    };
  }
  return rows;
}

// Load every revision for an employee, newest effective date first.
async function loadHistory(employeeId) {
  const q = `'${String(employeeId).replace(/'/g, "''")}'`;
  const { data } = await d365.getListOptional(ENTITY, {
    select: svc.SELECT, filter: `hr_employeeid eq ${q}`, orderby: 'hr_effectivefrom desc,createdon desc',
  });
  return (data || []).map(svc.shape);
}

// Status by effective date: ONLY the latest revision (newest Effective From) is 'active';
// every older revision is 'superseded'. A 'disabled' revision is left untouched and is NEVER
// auto-promoted — so disabling the latest revision leaves the employee with NO active structure
// (excluded from payroll) until it is Enabled again or a newer revision is added. There is
// deliberately no fall-back to an older revision, which would silently pay a stale amount.
// History is always preserved.
async function resequence(employeeId, log) {
  const rows = await loadHistory(employeeId);   // already newest-first
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (row.status === 'disabled') continue;     // disabled stays disabled — never promoted
    const want = i === 0 ? 'active' : 'superseded';   // only the newest revision is active
    if (row.status !== want) {
      try { await d365.update(ENTITY, row.id, { hr_status: want }); }
      catch (e) { (log || console).warn?.(`[salary] resequence ${row.id}: ${e.message}`); }
    }
  }
}

const labelFor = (name, date) => `${name || 'Employee'} · ${date || ''}`.trim();

// ── GET /  — list latest/active revisions (HR/Admin only; employees are blocked) ──
router.get('/', blockEmployees, async (req, res, next) => {
  try {
    const isHR = HR_ROLES.includes(req.user.role);
    const targetId = isHR ? (req.query.employeeId || null) : req.user.id;
    const filters = [];
    if (targetId) filters.push(`hr_employeeid eq '${String(targetId).replace(/'/g, "''")}'`);
    if (req.query.status) filters.push(`hr_status eq '${String(req.query.status).replace(/'/g, "''")}'`);

    const result = await d365.getListOptional(ENTITY, {
      select: svc.SELECT, filter: filters.join(' and ') || undefined, orderby: 'hr_effectivefrom desc,createdon desc',
    });
    const rows = await enrich((result.data || []).map(svc.shape));
    res.json({ data: rows, count: rows.length });
  } catch (err) {
    if (tableMissing(err)) { await ensureSalaryStructureTable(global.logger || console).catch(() => {}); return res.json({ data: [], count: 0 }); }
    next(err);
  }
});

// ── GET /employee/:employeeId  — full salary history timeline for one employee ──
router.get('/employee/:employeeId', blockEmployees, async (req, res, next) => {
  try {
    const isHR = HR_ROLES.includes(req.user.role);
    if (!isHR && req.params.employeeId !== req.user.id) return res.status(403).json({ error: 'Access denied' });
    const rows = await enrich(await loadHistory(req.params.employeeId));
    res.json({ data: rows, count: rows.length });
  } catch (err) {
    if (tableMissing(err)) return res.json({ data: [], count: 0 });
    next(err);
  }
});

// ── GET /:id  — a single revision ──
router.get('/:id', blockEmployees, async (req, res, next) => {
  try {
    const row = await d365.getByIdOptional(ENTITY, req.params.id, { select: svc.SELECT });
    const shaped = svc.shape(row);
    if (!HR_ROLES.includes(req.user.role) && shaped.employeeId !== req.user.id) return res.status(403).json({ error: 'Access denied' });
    await enrich([shaped]);
    res.json(shaped);
  } catch (err) { next(err); }
});

// ── POST /  — create a new salary revision (HR / Super Admin). Never overwrites. ──
router.post('/', requireAnyPermission('salary.edit'), async (req, res, next) => {
  try {
    const { ok, errors, value } = svc.validate(req.body, { requireEmployee: true });
    if (!ok) return res.status(400).json({ error: errors[0], errors });

    // Resolve the employee name (denormalised for display/history).
    let empName = req.body.employeeName || '';
    try { const emp = await d365.getById(EMP, value.employeeId, { select: 'hr_hremployee1' }); empName = emp?.hr_hremployee1 || empName; }
    catch { /* name is optional */ }
    value.employeeName = empName;
    value.createdBy = req.user?.name || req.user?.email || 'HR';

    // Block an exact-duplicate effective date for the same employee (ambiguous "active").
    const existing = await loadHistory(value.employeeId).catch(() => []);
    if (existing.some(r => r.effectiveFrom === value.effectiveFrom)) {
      return res.status(409).json({ error: `A salary structure already exists for this employee effective ${value.effectiveFrom}. Edit it or pick another date.` });
    }

    const body = { ...svc.toDataverse(value), hr_name: labelFor(empName, value.effectiveFrom) };
    const created = await writeWithRepair(() => d365.create(ENTITY, body));
    await resequence(value.employeeId, global.logger);   // newest date becomes active
    const shaped = svc.shape(created);
    await enrich([shaped]);
    res.status(201).json(shaped);
  } catch (err) {
    console.error('[salary/create] FAILED:', err.message);
    res.status(err.status || 400).json({ error: err.message || 'Failed to create salary structure' });
  }
});

// ── PATCH /:id/disable  — exclude a revision from payroll (reversible). Payroll generation
//    skips any employee whose EFFECTIVE structure for the period is disabled (no stale fall-back
//    to an older revision). If the disabled revision is the latest, the employee has no active
//    structure until it is Enabled again or a newer revision is added. ──
router.patch('/:id/disable', requireAnyPermission('salary.edit'), async (req, res, next) => {
  try {
    const current = svc.shape(await d365.getByIdOptional(ENTITY, req.params.id, { select: svc.SELECT }));
    if (!current.id) return res.status(404).json({ error: 'Salary structure not found.' });
    const patch = { hr_status: 'disabled' };
    if (req.body?.remarks != null) patch.hr_remarks = String(req.body.remarks);
    await writeWithRepair(() => d365.update(ENTITY, req.params.id, patch));
    await resequence(current.employeeId, global.logger);
    const shaped = svc.shape(await d365.getByIdOptional(ENTITY, req.params.id, { select: svc.SELECT }));
    await enrich([shaped]);
    res.json(shaped);
  } catch (err) {
    console.error('[salary/disable] FAILED:', err.message);
    res.status(err.status || 400).json({ error: err.message || 'Failed to disable salary structure' });
  }
});

// ── PATCH /:id/enable  — re-include a disabled revision in payroll. Resequence restores the
//    correct active/superseded flags by effective date. ──
router.patch('/:id/enable', requireAnyPermission('salary.edit'), async (req, res, next) => {
  try {
    const current = svc.shape(await d365.getByIdOptional(ENTITY, req.params.id, { select: svc.SELECT }));
    if (!current.id) return res.status(404).json({ error: 'Salary structure not found.' });
    // Neutral non-disabled status first; resequence then assigns active/superseded by date.
    await writeWithRepair(() => d365.update(ENTITY, req.params.id, { hr_status: 'superseded' }));
    await resequence(current.employeeId, global.logger);
    const shaped = svc.shape(await d365.getByIdOptional(ENTITY, req.params.id, { select: svc.SELECT }));
    await enrich([shaped]);
    res.json(shaped);
  } catch (err) {
    console.error('[salary/enable] FAILED:', err.message);
    res.status(err.status || 400).json({ error: err.message || 'Failed to enable salary structure' });
  }
});

// ── PATCH /:id  — correct an existing revision (HR / Super Admin). Recomputes Gross. ──
router.patch('/:id', requireAnyPermission('salary.edit'), async (req, res, next) => {
  try {
    const current = svc.shape(await d365.getByIdOptional(ENTITY, req.params.id, { select: svc.SELECT }));
    // Merge the patch over the current revision, then validate the whole thing.
    const merged = { ...current, ...req.body, employeeId: current.employeeId };
    const { ok, errors, value } = svc.validate(merged, { requireEmployee: false });
    if (!ok) return res.status(400).json({ error: errors[0], errors });

    // Duplicate-date guard (ignore this same row).
    if (value.effectiveFrom !== current.effectiveFrom) {
      const hist = await loadHistory(current.employeeId).catch(() => []);
      if (hist.some(r => r.id !== req.params.id && r.effectiveFrom === value.effectiveFrom)) {
        return res.status(409).json({ error: `Another revision already uses effective date ${value.effectiveFrom}.` });
      }
    }

    value.employeeName = current.employeeName;
    const body = { ...svc.toDataverse(value), hr_name: labelFor(current.employeeName, value.effectiveFrom) };
    delete body.hr_employeeid;   // never move a revision to another employee
    const updated = await writeWithRepair(() => d365.update(ENTITY, req.params.id, body));
    await resequence(current.employeeId, global.logger);
    const shaped = svc.shape(updated || (await d365.getByIdOptional(ENTITY, req.params.id, { select: svc.SELECT })));
    await enrich([shaped]);
    res.json(shaped);
  } catch (err) {
    console.error('[salary/update] FAILED:', err.message);
    res.status(err.status || 400).json({ error: err.message || 'Failed to update salary structure' });
  }
});

// ── DELETE /:id  — remove a revision (Super Admin only). Re-activates latest remaining. ──
router.delete('/:id', requireRole('super_admin'), async (req, res, next) => {
  try {
    const current = svc.shape(await d365.getByIdOptional(ENTITY, req.params.id, { select: svc.SELECT }));
    await d365.delete(ENTITY, req.params.id);
    if (current.employeeId) await resequence(current.employeeId, global.logger);
    res.json({ message: 'Salary revision deleted' });
  } catch (err) {
    console.error('[salary/delete] FAILED:', err.message);
    res.status(err.status || 400).json({ error: err.message || 'Failed to delete salary structure' });
  }
});

module.exports = router;
module.exports.blockEmployees = blockEmployees;   // exposed for access-control tests
