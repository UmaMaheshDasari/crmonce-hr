const express = require('express');
const router = express.Router();
const d365 = require('../../services/d365.service');
const { requireRole, requirePermission } = require('../../middleware/auth.middleware');
const { notifyLeaveApproval, broadcast } = require('../../services/notification.service');
const { toValue, toLabel, labelsForList, labelsForEntity } = require('../../services/picklist');
const requestNotify = require('../../services/request-notify.service');
const { verifyApprovalToken } = require('../../services/approval-token');

const ENTITY = d365.constructor.entities.leave;
const EMP_ENTITY = d365.constructor.entities.employee;

/**
 * Two-level leave approval flow:
 *
 * Employee applies → status = pending
 *   ↓
 * L1 (Direct Manager) approves/rejects → hr_l1status = approved/rejected
 *   ↓ (if L1 approved)
 * L2 (Manager's Manager) approves/rejects → hr_l2status = approved/rejected
 *   ↓ (if L2 approved)
 * Final status = approved
 *
 * If either L1 or L2 rejects → final status = rejected
 */

// Helper: get employee's manager chain
async function getManagerChain(employeeId) {
  const emp = await d365.getById(EMP_ENTITY, employeeId, {
    select: 'hr_hremployeeid,hr_hremployee1,_hr_manager_value',
  });

  const result = { employee: emp, l1Manager: null, l2Manager: null };

  if (emp._hr_manager_value) {
    const l1 = await d365.getById(EMP_ENTITY, emp._hr_manager_value, {
      select: 'hr_hremployeeid,hr_hremployee1,_hr_manager_value',
    });
    result.l1Manager = l1;

    if (l1._hr_manager_value) {
      const l2 = await d365.getById(EMP_ENTITY, l1._hr_manager_value, {
        select: 'hr_hremployeeid,hr_hremployee1',
      });
      result.l2Manager = l2;
    }
  }

  return result;
}

// GET /api/attendance/leave
router.get('/', async (req, res, next) => {
  try {
    const { status, employeeId, pending_for } = req.query;
    const filters = [];

    if (req.user.role === 'employee') {
      // Employees see: their own leaves + leaves pending their approval (as manager)
      if (pending_for === 'me') {
        // Show leaves where I am the L1 or L2 approver
        filters.push(`(hr_l1status eq 'pending' or hr_l2status eq 'pending_l2')`);
      } else {
        filters.push(`_hr_hremployee_value eq '${req.user.id}'`);
      }
    } else {
      if (employeeId) filters.push(`_hr_hremployee_value eq '${employeeId}'`);
    }

    if (status) filters.push(`hr_status eq ${toValue('hr_leave_status', status)}`);

    const result = await d365.getList(ENTITY, {
      select: 'hr_hrleaveid,hr_leavetype,hr_fromdate,hr_todate,hr_days,hr_reason,hr_status,hr_remarks,_hr_hremployee_value,hr_l1status,hr_l1remarks,hr_l1approvedby,hr_l1date,hr_l2status,hr_l2remarks,hr_l2approvedby,hr_l2date',
      filter: filters.join(' and ') || undefined,
      orderby: 'createdon desc',
    });

    // For managers: filter to show only their reportees' leaves
    let data = result;
    if (req.user.role === 'employee' && pending_for === 'me') {
      // Filter: only leaves from my direct reports or their reports
      const { data: reportees } = await d365.getList(EMP_ENTITY, {
        filter: `_hr_manager_value eq '${req.user.id}'`,
        select: 'hr_hremployeeid',
      });
      const reporteeIds = new Set(reportees.map(r => r.hr_hremployeeid));

      // Also get skip-level reports (reportees' reportees)
      for (const r of reportees) {
        const { data: subReportees } = await d365.getList(EMP_ENTITY, {
          filter: `_hr_manager_value eq '${r.hr_hremployeeid}'`,
          select: 'hr_hremployeeid',
        });
        subReportees.forEach(sr => reporteeIds.add(sr.hr_hremployeeid));
      }

      data.data = data.data.filter(l => reporteeIds.has(l._hr_hremployee_value));
      data.count = data.data.length;
    }

    res.json(labelsForList('hr_hrleaves', data));
  } catch (err) { next(err); }
});

// Shared HR/Super-Admin override decision — used by BOTH the PATCH /:id route
// (UI override) and the POST /:id/email-action route (email button). Keeps a
// single source of truth for the override logic (no duplication).
//   enforcePending=true  → refuse if the request is already finalised
//                          (prevents duplicate approvals / replay via email links).
async function applyHrOverride(user, id, status, remarks, { enforcePending = false } = {}) {
  const current = await d365.getById(ENTITY, id, {
    select: 'hr_hrleaveid,_hr_hremployee_value,hr_status,hr_fromdate,hr_todate',
  });

  if (enforcePending) {
    const label = toLabel('hr_leave_status', current.hr_status);
    if (['approved', 'rejected', 'cancelled'].includes(label)) {
      const e = new Error(`This request is already ${label}`);
      e.status = 409;
      throw e;
    }
  }

  const now = new Date().toISOString().split('T')[0];
  const leave = await d365.update(ENTITY, id, {
    hr_status: toValue('hr_leave_status', status),
    hr_remarks: remarks || `${status} by ${user.name} (HR Override)`,
    hr_l1status: status === 'approved' ? 'approved' : 'rejected',
    hr_l1approvedby: user.name,
    hr_l1date: now,
    hr_l2status: 'not_required',
  });

  const employeeId = leave._hr_hremployee_value || current._hr_hremployee_value;
  if (employeeId) {
    // In-app notification (existing) + employee decision email (shared service).
    await notifyLeaveApproval(employeeId, status, { from: current.hr_fromdate, to: current.hr_todate });
    requestNotify.emailDecisionToEmployee({
      type: 'leave', employeeId, decision: status, approverName: user.name,
      remarks: remarks || '', status,
    });
  }

  broadcast('leave:updated', { leaveId: id, action: status, level: 'HR' });
  return leave;
}

// POST /api/attendance/leave — Employee applies for leave
router.post('/', async (req, res, next) => {
  try {
    const body = { ...req.body };
    if (body.hr_leavetype) body.hr_leavetype = toValue('hr_leave_type', body.hr_leavetype);

    // Set initial approval status
    body.hr_status = toValue('hr_leave_status', 'pending');
    body.hr_l1status = 'pending';
    body.hr_l2status = '';

    // Employee lookup is owned solely by the backend — always bind to the
    // authenticated user; never trust a client-supplied lookup.
    body['hr_hremployee@odata.bind'] = `/hr_hremployees(${req.user.id})`;

    const leave = await d365.create(ENTITY, body);

    // Notify Super Admin (in-app + email w/ Approve/Reject buttons). Only reached
    // after a successful create; fire-and-forget so mail/socket issues never block
    // or fail Leave Apply.
    requestNotify.notifyNewRequest({
      type: 'leave',
      recordId: leave.hr_hrleaveid,
      actor: req.user,
      details: [
        ['Leave Type', toLabel('hr_leave_type', req.body.hr_leavetype)],
        ['From Date', req.body.hr_fromdate],
        ['To Date', req.body.hr_todate],
        ['Number of Days', req.body.hr_days],
        ['Reason', req.body.hr_reason],
      ],
      applyTime: new Date().toISOString(),
    });

    // Notify L1 manager
    try {
      const chain = await getManagerChain(req.user.id);
      if (chain.l1Manager) {
        broadcast('leave:pending', {
          leaveId: leave.hr_hrleaveid,
          employeeName: req.user.name,
          type: req.body.hr_leavetype,
          from: req.body.hr_fromdate,
          to: req.body.hr_todate,
          approverName: chain.l1Manager.hr_hremployee1,
          level: 'L1',
        });
      }
    } catch (_) {}

    res.status(201).json(labelsForEntity('hr_hrleaves', leave));
  } catch (err) { next(err); }
});

// PATCH /api/attendance/leave/:id/l1 — L1 (Manager) approval
router.patch('/:id/l1', async (req, res, next) => {
  try {
    const { action, remarks } = req.body; // action: 'approved' or 'rejected'
    const leaveRecord = await d365.getById(ENTITY, req.params.id, {
      select: 'hr_hrleaveid,_hr_hremployee_value,hr_l1status,hr_l2status,hr_fromdate,hr_todate',
    });

    // Verify this user is the L1 manager of the leave employee
    const chain = await getManagerChain(leaveRecord._hr_hremployee_value);
    const isL1 = chain.l1Manager && chain.l1Manager.hr_hremployeeid === req.user.id;
    const isSuperAdmin = req.user.role === 'super_admin';
    const isHR = req.user.role === 'hr_manager';

    if (!isL1 && !isSuperAdmin && !isHR) {
      return res.status(403).json({ error: 'You are not the reporting manager for this employee' });
    }

    const now = new Date().toISOString().split('T')[0];
    const updatePayload = {
      hr_l1status: action,
      hr_l1remarks: remarks || '',
      hr_l1approvedby: req.user.name,
      hr_l1date: now,
    };

    if (action === 'rejected') {
      // L1 rejected → final status = rejected
      updatePayload.hr_status = toValue('hr_leave_status', 'rejected');
      updatePayload.hr_remarks = `Rejected by ${req.user.name} (Manager)`;
    } else if (action === 'approved') {
      // Check if L2 is needed
      if (chain.l2Manager) {
        updatePayload.hr_l2status = 'pending_l2';
        // Notify L2 manager
        broadcast('leave:pending', {
          leaveId: leaveRecord.hr_hrleaveid,
          employeeName: chain.employee.hr_hremployee1,
          approverName: chain.l2Manager.hr_hremployee1,
          level: 'L2',
        });
      } else {
        // No L2 manager → final approval
        updatePayload.hr_status = toValue('hr_leave_status', 'approved');
        updatePayload.hr_l2status = 'not_required';
        updatePayload.hr_remarks = `Approved by ${req.user.name} (Manager)`;
      }
    }

    const leave = await d365.update(ENTITY, req.params.id, updatePayload);

    // Notify employee (only when L1 produced a FINAL decision)
    if (action === 'rejected' || (!chain.l2Manager && action === 'approved')) {
      const finalStatus = action === 'approved' ? 'approved' : 'rejected';
      await notifyLeaveApproval(leaveRecord._hr_hremployee_value, finalStatus, {
        from: leaveRecord.hr_fromdate,
        to: leaveRecord.hr_todate,
      });
      requestNotify.emailDecisionToEmployee({
        type: 'leave', employeeId: leaveRecord._hr_hremployee_value,
        decision: finalStatus, approverName: req.user.name,
        remarks: updatePayload.hr_remarks, status: finalStatus,
      });
    }

    broadcast('leave:updated', { leaveId: req.params.id, action, level: 'L1' });
    res.json(labelsForEntity('hr_hrleaves', leave));
  } catch (err) { next(err); }
});

// PATCH /api/attendance/leave/:id/l2 — L2 (Manager's Manager) approval
router.patch('/:id/l2', async (req, res, next) => {
  try {
    const { action, remarks } = req.body;
    const leaveRecord = await d365.getById(ENTITY, req.params.id, {
      select: 'hr_hrleaveid,_hr_hremployee_value,hr_l1status,hr_l2status,hr_fromdate,hr_todate',
    });

    if (leaveRecord.hr_l1status !== 'approved') {
      return res.status(400).json({ error: 'L1 approval is required before L2' });
    }

    // Verify this user is the L2 manager
    const chain = await getManagerChain(leaveRecord._hr_hremployee_value);
    const isL2 = chain.l2Manager && chain.l2Manager.hr_hremployeeid === req.user.id;
    const isSuperAdmin = req.user.role === 'super_admin';
    const isHR = req.user.role === 'hr_manager';

    if (!isL2 && !isSuperAdmin && !isHR) {
      return res.status(403).json({ error: 'You are not the skip-level manager for this employee' });
    }

    const now = new Date().toISOString().split('T')[0];
    const updatePayload = {
      hr_l2status: action,
      hr_l2remarks: remarks || '',
      hr_l2approvedby: req.user.name,
      hr_l2date: now,
    };

    if (action === 'approved') {
      updatePayload.hr_status = toValue('hr_leave_status', 'approved');
      updatePayload.hr_remarks = `Approved by ${req.user.name} (L2 Manager)`;
    } else {
      updatePayload.hr_status = toValue('hr_leave_status', 'rejected');
      updatePayload.hr_remarks = `Rejected by ${req.user.name} (L2 Manager)`;
    }

    const leave = await d365.update(ENTITY, req.params.id, updatePayload);

    // Notify employee of final decision (in-app + email)
    const l2Final = action === 'approved' ? 'approved' : 'rejected';
    await notifyLeaveApproval(leaveRecord._hr_hremployee_value, l2Final, {
      from: leaveRecord.hr_fromdate,
      to: leaveRecord.hr_todate,
    });
    requestNotify.emailDecisionToEmployee({
      type: 'leave', employeeId: leaveRecord._hr_hremployee_value,
      decision: l2Final, approverName: req.user.name,
      remarks: updatePayload.hr_remarks, status: l2Final,
    });

    broadcast('leave:updated', { leaveId: req.params.id, action, level: 'L2' });
    res.json(labelsForEntity('hr_hrleaves', leave));
  } catch (err) { next(err); }
});

// PATCH /api/attendance/leave/:id — Single-step approval (HR / Super-Admin override, from the UI)
router.patch('/:id', requireRole('super_admin', 'hr_manager'), async (req, res, next) => {
  try {
    const { status, remarks } = req.body;
    // UI override keeps existing behaviour (no pending-only guard).
    const leave = await applyHrOverride(req.user, req.params.id, status, remarks);
    res.json(labelsForEntity('hr_hrleaves', leave));
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

// POST /api/attendance/leave/:id/email-action — Approve/Reject from an email button.
// Security (backend is the only source of truth — frontend permission never trusted):
//   1. authenticateToken (mounted globally) → valid login JWT + logged-in user
//   2. requireRole → only Super Admin / HR may act on the emailed link
//   3. verifyApprovalToken → link is authentic and NOT expired
//   4. token {type,id} must match the URL → no tampering
//   5. enforcePending inside applyHrOverride → blocks duplicate approvals / replay
//      / already-finalised requests
router.post('/:id/email-action', requireRole('super_admin', 'hr_manager'), async (req, res, next) => {
  try {
    const { action, token, remarks } = req.body;
    if (!token) return res.status(400).json({ error: 'Approval token required' });

    let claim;
    try { claim = verifyApprovalToken(token); }
    catch (_) { return res.status(401).json({ error: 'Approval link is invalid or has expired' }); }

    if (claim.type !== 'leave' || claim.id !== req.params.id) {
      return res.status(400).json({ error: 'Approval link does not match this request' });
    }

    const decision = action || claim.action;
    if (!['approved', 'rejected'].includes(decision)) {
      return res.status(400).json({ error: 'Invalid action' });
    }

    const leave = await applyHrOverride(req.user, req.params.id, decision, remarks, { enforcePending: true });
    res.json(labelsForEntity('hr_hrleaves', leave));
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

// GET /api/attendance/leave/pending-approvals — Leaves pending my approval
router.get('/pending-approvals', async (req, res, next) => {
  try {
    // Get my direct reports
    const { data: reportees } = await d365.getList(EMP_ENTITY, {
      filter: `_hr_manager_value eq '${req.user.id}'`,
      select: 'hr_hremployeeid',
    });
    const reporteeIds = reportees.map(r => r.hr_hremployeeid);

    if (reporteeIds.length === 0) {
      return res.json({ data: [], count: 0 });
    }

    // Get all pending leaves for my reportees
    const orFilter = reporteeIds.map(id => `_hr_hremployee_value eq '${id}'`).join(' or ');
    const result = await d365.getList(ENTITY, {
      select: 'hr_hrleaveid,hr_leavetype,hr_fromdate,hr_todate,hr_days,hr_reason,hr_status,hr_remarks,_hr_hremployee_value,hr_l1status,hr_l1remarks,hr_l1approvedby,hr_l1date,hr_l2status,hr_l2remarks,hr_l2approvedby,hr_l2date',
      filter: `(${orFilter}) and hr_l1status eq 'pending'`,
      orderby: 'createdon desc',
    });

    // Also check if I'm L2 for any leaves (my reportees' reportees)
    const { data: subReportees } = await d365.getList(EMP_ENTITY, {
      filter: reporteeIds.map(id => `_hr_manager_value eq '${id}'`).join(' or '),
      select: 'hr_hremployeeid',
    });
    const subIds = subReportees.map(r => r.hr_hremployeeid);

    if (subIds.length > 0) {
      const subFilter = subIds.map(id => `_hr_hremployee_value eq '${id}'`).join(' or ');
      const l2Result = await d365.getList(ENTITY, {
        select: 'hr_hrleaveid,hr_leavetype,hr_fromdate,hr_todate,hr_days,hr_reason,hr_status,hr_remarks,_hr_hremployee_value,hr_l1status,hr_l1remarks,hr_l1approvedby,hr_l1date,hr_l2status,hr_l2remarks,hr_l2approvedby,hr_l2date',
        filter: `(${subFilter}) and hr_l2status eq 'pending_l2'`,
        orderby: 'createdon desc',
      });
      result.data = [...result.data, ...l2Result.data];
      result.count = result.data.length;
    }

    res.json(labelsForList('hr_hrleaves', result));
  } catch (err) { next(err); }
});

module.exports = router;
