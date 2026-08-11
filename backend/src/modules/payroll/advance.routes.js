const express = require('express');
const router = express.Router();
const d365 = require('../../services/d365.service');
const { requireRole } = require('../../middleware/auth.middleware');
const { resolvePhoto } = require('../../services/employee-photo.util');
const advance = require('../../services/advance.service');
const { ensureAdvanceTable, addMissingColumn } = require('../../services/provision-advance');
const notify = require('../../services/advance-notify.service');

const ENTITY = advance.ENTITY;
const EMP = d365.constructor.entities.employee;
const HR_ROLES = ['super_admin', 'hr_manager'];
const pad2 = (n) => String(n).padStart(2, '0');

const tableMissing = (err) =>
  d365._isBadSegment?.(err) ||
  /Resource not found for the segment|Could not find a property|does not exist|was not found|404/i.test(err?.message || '');

async function writeWithRepair(fn) {
  try { return await fn(); }
  catch (err) {
    if (tableMissing(err)) { await ensureAdvanceTable(global.logger || console).catch(() => {}); return await fn(); }
    if (d365._isMissingProperty?.(err) && d365._missingPropertyName) {
      const col = d365._missingPropertyName(err);
      if (col) { await addMissingColumn(col, global.logger || console).catch(() => {}); return await fn(); }
    }
    throw err;
  }
}

// Join hr_employeeid → Employee master (name / EMP id / dept / designation / photo).
async function enrich(rows) {
  const ids = [...new Set((rows || []).map(r => r.employeeId).filter(Boolean))];
  if (!ids.length) return rows;
  let map = new Map();
  try {
    const { data } = await d365.getListOptional(EMP, {
      select: 'hr_hremployeeid,hr_hremployee1,hr_department,hr_designation',
      optionalSelect: 'hr_employeeid,hr_employeecode,hr_etimecode,hr_photourl,hr_personalphotourl,hr_photoremoved', top: 5000,
    });
    map = new Map((data || []).map(e => [e.hr_hremployeeid, e]));
  } catch {}
  for (const r of rows) {
    const e = map.get(r.employeeId);
    r._employee = {
      name: e?.hr_hremployee1 || r.employeeName || '',
      employeeId: e?.hr_employeeid || e?.hr_etimecode || e?.hr_employeecode || '',
      department: e?.hr_department || '', designation: e?.hr_designation || '', photo: resolvePhoto(e),
    };
  }
  return rows;
}

const nextMonthPeriod = () => {
  const d = new Date();
  const y = d.getMonth() === 11 ? d.getFullYear() + 1 : d.getFullYear();
  const m = d.getMonth() === 11 ? 1 : d.getMonth() + 2;
  return `${y}-${pad2(m)}`;
};

// ── GET /  — list advances (HR: all or ?employeeId; employee: own) ──
router.get('/', async (req, res, next) => {
  try {
    const isHR = HR_ROLES.includes(req.user.role);
    const targetId = isHR ? (req.query.employeeId || null) : req.user.id;
    const filters = [];
    if (targetId) filters.push(`hr_employeeid eq '${String(targetId).replace(/'/g, "''")}'`);
    if (req.query.status) filters.push(`hr_status eq '${String(req.query.status).replace(/'/g, "''")}'`);
    const { data } = await d365.getList(ENTITY, { select: advance.SELECT, filter: filters.join(' and ') || undefined, orderby: 'createdon desc' });
    const rows = await enrich((data || []).map(advance.shape));
    res.json({ data: rows, count: rows.length });
  } catch (err) {
    if (tableMissing(err)) { await ensureAdvanceTable(global.logger || console).catch(() => {}); return res.json({ data: [], count: 0 }); }
    next(err);
  }
});

// ── GET /pending  — HR approval queue ──
router.get('/pending', requireRole('super_admin', 'hr_manager'), async (req, res, next) => {
  try {
    const { data } = await d365.getList(ENTITY, { select: advance.SELECT, filter: `hr_status eq 'pending'`, orderby: 'createdon asc' });
    const rows = await enrich((data || []).map(advance.shape));
    res.json({ data: rows, count: rows.length });
  } catch (err) {
    if (tableMissing(err)) return res.json({ data: [], count: 0 });
    next(err);
  }
});

// ── GET /balance  — total / recovered / remaining across an employee's advances ──
router.get('/balance', async (req, res, next) => {
  try {
    const isHR = HR_ROLES.includes(req.user.role);
    const employeeId = isHR ? (req.query.employeeId || req.user.id) : req.user.id;
    const { data } = await d365.getList(ENTITY, { select: advance.SELECT, filter: `hr_employeeid eq '${String(employeeId).replace(/'/g, "''")}'` });
    const rows = (data || []).map(advance.shape);
    const approved = rows.filter(r => r.status === 'approved' || r.status === 'completed');
    const totalAdvance = approved.reduce((s, r) => s + r.amount, 0);
    const recovered = approved.reduce((s, r) => s + r.recovered, 0);
    res.json({ employeeId, totalAdvance, recovered, remaining: Math.max(0, totalAdvance - recovered), activeCount: rows.filter(r => r.status === 'approved').length, count: rows.length });
  } catch (err) {
    if (tableMissing(err)) return res.json({ employeeId: req.user.id, totalAdvance: 0, recovered: 0, remaining: 0, activeCount: 0, count: 0 });
    next(err);
  }
});

// ── POST /  — employee applies for an advance ──
router.post('/', async (req, res, next) => {
  try {
    const amount = Math.round(Number(req.body.amount) || 0);
    if (!(amount > 0)) return res.status(400).json({ error: 'Advance amount must be greater than 0.' });
    if (!String(req.body.reason || '').trim()) return res.status(400).json({ error: 'Please provide a reason.' });

    // Employees apply for themselves; HR may raise on behalf of an employee.
    const isHR = HR_ROLES.includes(req.user.role);
    const employeeId = isHR && req.body.employeeId ? req.body.employeeId : req.user.id;

    let employeeName = req.user.name || '';
    try { const emp = await d365.getById(EMP, employeeId, { select: 'hr_hremployee1' }); employeeName = emp?.hr_hremployee1 || employeeName; } catch {}

    const requestedDate = String(req.body.requestedDate || new Date().toISOString().slice(0, 10)).slice(0, 10);
    const emi = Math.max(0, Math.round(Number(req.body.emi) || 0));   // employee may propose an EMI; HR finalises on approval
    const body = {
      hr_name: `${employeeName} · Advance ${requestedDate}`.slice(0, 250),
      hr_employeeid: employeeId, hr_employeename: employeeName,
      hr_amount: amount, hr_reason: String(req.body.reason).trim(),
      hr_requesteddate: requestedDate, hr_emi: emi,
      hr_recovered: 0, hr_recoveryschedule: '[]', hr_status: 'pending',
      hr_createdby: req.user.name || req.user.email || '',
    };
    const created = await writeWithRepair(() => d365.create(ENTITY, body));
    const shaped = advance.shape(created);
    notify.notifyRequested({ advance: shaped, applicant: { name: employeeName, email: req.user.email } }).catch(() => {});
    await enrich([shaped]);
    res.status(201).json(shaped);
  } catch (err) {
    console.error('[advance/create] FAILED:', err.message);
    res.status(err.status || 400).json({ error: err.message || 'Failed to submit advance request' });
  }
});

// ── PATCH /:id/approve  — HR approves + sets EMI / recover-from ──
router.patch('/:id/approve', requireRole('super_admin', 'hr_manager'), async (req, res, next) => {
  try {
    const current = advance.shape(await d365.getByIdOptional(ENTITY, req.params.id, { select: advance.SELECT }));
    if (current.status !== 'pending') return res.status(409).json({ error: `This request is already ${current.status}.` });

    const emi = Math.max(0, Math.round(Number(req.body.emi) || current.emi || 0));   // 0 → recover in one payroll
    const recoverFrom = /^\d{4}-\d{2}$/.test(req.body.recoverFrom) ? req.body.recoverFrom : nextMonthPeriod();
    const updated = advance.shape(await d365.update(ENTITY, req.params.id, {
      hr_status: 'approved', hr_emi: emi, hr_recoverfrom: recoverFrom,
      hr_approvedby: req.user.name || req.user.email || 'HR',
      hr_approveddate: new Date().toISOString(),
      hr_remarks: req.body.remarks || '',
    }));
    notify.notifyDecision({ advance: updated, decision: 'approved', approver: { name: req.user.name, email: req.user.email } }).catch(() => {});
    await enrich([updated]);
    res.json(updated);
  } catch (err) {
    console.error('[advance/approve] FAILED:', err.message);
    res.status(err.status || 400).json({ error: err.message || 'Failed to approve advance' });
  }
});

// ── PATCH /:id/reject  — HR rejects ──
router.patch('/:id/reject', requireRole('super_admin', 'hr_manager'), async (req, res, next) => {
  try {
    const current = advance.shape(await d365.getByIdOptional(ENTITY, req.params.id, { select: advance.SELECT }));
    if (current.status !== 'pending') return res.status(409).json({ error: `This request is already ${current.status}.` });
    const updated = advance.shape(await d365.update(ENTITY, req.params.id, {
      hr_status: 'rejected', hr_approvedby: req.user.name || req.user.email || 'HR',
      hr_approveddate: new Date().toISOString(), hr_remarks: req.body.remarks || '',
    }));
    notify.notifyDecision({ advance: updated, decision: 'rejected', approver: { name: req.user.name, email: req.user.email } }).catch(() => {});
    await enrich([updated]);
    res.json(updated);
  } catch (err) {
    console.error('[advance/reject] FAILED:', err.message);
    res.status(err.status || 400).json({ error: err.message || 'Failed to reject advance' });
  }
});

// ── PATCH /:id  — employee edits their OWN PENDING request (amount / reason / EMI) ──
// Owner-only; never editable once it has left 'pending'. Status is never employee-editable.
router.patch('/:id', async (req, res, next) => {
  try {
    const current = advance.shape(await d365.getByIdOptional(ENTITY, req.params.id, { select: advance.SELECT }));
    const isSuperAdmin = req.user.role === 'super_admin';
    if (!isSuperAdmin && current.employeeId !== req.user.id) return res.status(403).json({ error: 'You can only modify your own request.' });
    if (current.status !== 'pending') return res.status(409).json({ error: 'This request can no longer be modified.' });
    const body = {};
    if (req.body.amount !== undefined) { const amt = Math.round(Number(req.body.amount) || 0); if (!(amt > 0)) return res.status(400).json({ error: 'Advance amount must be greater than 0.' }); body.hr_amount = amt; }
    if (req.body.reason !== undefined) { const r = String(req.body.reason).trim(); if (!r) return res.status(400).json({ error: 'Please provide a reason.' }); body.hr_reason = r; }
    if (req.body.emi !== undefined) body.hr_emi = Math.max(0, Math.round(Number(req.body.emi) || 0));
    if (!Object.keys(body).length) return res.json(current);
    const updated = advance.shape(await d365.update(ENTITY, req.params.id, body));
    await enrich([updated]);
    res.json(updated);
  } catch (err) {
    console.error('[advance/edit] FAILED:', err.message);
    res.status(err.status || 400).json({ error: err.message || 'Failed to update advance' });
  }
});

// ── DELETE /:id  — remove a PENDING/REJECTED request (owner or Super Admin) ──
// An advance that has begun/finished salary recovery (any amount recovered, or status
// approved/completed) is a committed financial record and can NEVER be deleted — not
// even by a super admin. Only pending or rejected requests (no money moved) are removable.
router.delete('/:id', async (req, res, next) => {
  try {
    const current = advance.shape(await d365.getByIdOptional(ENTITY, req.params.id, { select: advance.SELECT }));
    const isSuperAdmin = req.user.role === 'super_admin';
    if (!isSuperAdmin && current.employeeId !== req.user.id) return res.status(403).json({ error: 'You can only modify your own request.' });
    if ((current.recovered || 0) > 0) return res.status(409).json({ error: 'This request can no longer be deleted — salary recovery has already begun.' });
    if (!['pending', 'rejected'].includes(current.status)) return res.status(409).json({ error: 'This request can no longer be deleted.' });
    await d365.delete(ENTITY, req.params.id);
    res.json({ message: 'Advance request removed' });
  } catch (err) {
    console.error('[advance/delete] FAILED:', err.message);
    res.status(err.status || 400).json({ error: err.message || 'Failed to remove advance' });
  }
});

module.exports = router;
