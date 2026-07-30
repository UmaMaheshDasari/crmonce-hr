/**
 * Missing Punch / Attendance-correction request workflow.
 *
 * Employees can NEVER edit attendance directly — they submit a request. HR / Super
 * Admin approve or reject. On approval the missing punch is inserted into the day's
 * ordered punches and computeSession recalculates Worked / Break / Effective /
 * Late / Early / Overtime / Status automatically. Original + corrected punches are
 * preserved on the request as an audit trail (history is never overwritten blindly).
 *
 * Requires the Dataverse table `hr_attendancerequests` (see
 * scripts/create-attendance-request-entity.js for the schema). Until it exists the
 * endpoints degrade gracefully (empty list / clear 501) instead of crashing.
 */
const express = require('express');
const router = express.Router();
const d365 = require('../../services/d365.service');
const { requireRole, requirePermission } = require('../../middleware/auth.middleware');
const { toValue } = require('../../services/picklist');
const { computeSession, punchesFromRecord } = require('../../services/attendance.util');
const { insertPunchTime, detectMissingPunches, PUNCH_TYPES } = require('../../services/missing-punch.util');
const attnCfg = require('../../services/attendance.config');
const time = require('../../services/time.util');
const activity = require('../../services/activity.service');
const requestNotify = require('../../services/request-notify.service');
const { verifyApprovalToken } = require('../../services/approval-token');
const { ensureAttendanceRequestTable } = require('../../services/provision-attendance-request');

const REQ = d365.constructor.entities.attendanceRequest;
const ATT = d365.constructor.entities.attendance;
const EMP = d365.constructor.entities.employee;
const PUNCH_SELECT = 'hr_hrattendanceid,hr_date,hr_intime,hr_outtime,hr_allpunches,hr_punchcount,_hr_hremployee_value';

const notConfigured = (err) => /Could not find|does not exist|Resource not found|400|404/i.test(err?.message || '');

async function shiftFor(empId) {
  try {
    const e = await d365.getByIdOptional(EMP, empId, { select: 'hr_hremployeeid', optionalSelect: 'hr_shiftname,hr_shiftstarttime,hr_shiftendtime' });
    return attnCfg.resolveEmployeeShift(e?.hr_shiftname, e?.hr_shiftstarttime, e?.hr_shiftendtime);
  } catch (_) { return attnCfg.resolveShift(); }
}
async function findAttendanceRecord(empId, date) {
  const { data } = await d365.getList(ATT, {
    select: PUNCH_SELECT, filter: `_hr_hremployee_value eq '${empId}' and hr_date eq ${date}`, top: 1,
  });
  return (data && data[0]) || null;
}
// Recomputed session → the attendance record's stored columns (recalculation).
const punchPayload = (c) => ({
  hr_intime: c.firstPunch || '',
  hr_outtime: c.state === 'out' ? c.lastPunch : '',
  hr_workedhours: c.totalSpanHours,
  hr_overtime: c.overtimeHours,
  hr_breakduration: c.breakHours,
  hr_effectivehours: c.effectiveHours,
  hr_punchcount: c.count,
  hr_allpunches: JSON.stringify(c.punches.map(p => p.t)),
  hr_status: toValue('hr_attendance_status', c.status),
});
const view = (r) => ({
  id: r.hr_attendancerequestid,
  employeeId: r.hr_employeeid, employeeName: r.hr_employeename, employeeEmail: r.hr_employeeemail,
  date: r.hr_attendancedate, punchType: r.hr_punchtype, punchTypeLabel: PUNCH_TYPES[r.hr_punchtype] || r.hr_punchtype,
  requestedTime: r.hr_requestedtime, reason: r.hr_reason, remarks: r.hr_remarks,
  attachmentUrl: r.hr_attachmenturl, status: r.hr_status,
  originalPunches: safeJson(r.hr_originalpunches), correctedPunches: safeJson(r.hr_correctedpunches),
  approvedBy: r.hr_approvedby, approvedDate: r.hr_approveddate, approverComment: r.hr_approvercomment,
  createdon: r.createdon,
});
const safeJson = (s) => { try { return JSON.parse(s || '[]'); } catch { return []; } };

// POST /api/attendance-requests/setup — create the Dataverse table on demand
// (Super Admin). Returns { status: 'exists' | 'created' | 'unavailable', reason? }
// so provisioning can be triggered + diagnosed without SSH/log access.
router.post('/setup', requireRole('super_admin'), async (req, res, next) => {
  try {
    const result = await ensureAttendanceRequestTable(global.logger || console);
    res.status(result.status === 'unavailable' ? 502 : 200).json(result);
  } catch (err) { res.status(500).json({ status: 'error', reason: err.message }); }
});

// POST /api/attendance-requests — employee submits a Missing Punch request.
router.post('/', requirePermission('attendance:read'), async (req, res, next) => {
  try {
    const { attendanceDate, punchType, requestedTime, reason, remarks, attachmentUrl } = req.body;
    if (!attendanceDate || !punchType || !requestedTime) {
      return res.status(400).json({ error: 'Attendance date, punch type and requested time are required' });
    }
    if (!PUNCH_TYPES[punchType]) return res.status(400).json({ error: 'Invalid punch type' });
    if (!/^\d{1,2}:\d{2}$/.test(requestedTime)) return res.status(400).json({ error: 'Requested time must be HH:MM' });
    if (attendanceDate > time.istDateStr()) return res.status(400).json({ error: 'Cannot request a correction for a future date' });

    const body = {
      hr_name: `Missing Punch — ${req.user.name} — ${attendanceDate}`,
      hr_employeeid: req.user.id, hr_employeename: req.user.name, hr_employeeemail: req.user.email || '',
      hr_attendancedate: String(attendanceDate).slice(0, 10),
      hr_punchtype: punchType, hr_requestedtime: requestedTime,
      hr_reason: reason || '', hr_remarks: remarks || '', hr_attachmenturl: attachmentUrl || '',
      hr_status: 'pending',
    };

    let created;
    try { created = await d365.create(REQ, body); }
    catch (err) {
      if (notConfigured(err)) return res.status(501).json({ error: 'Missing Punch requests are not configured yet. Ask an administrator to create the hr_attendancerequests table.' });
      throw err;
    }

    // Activity + emails (best-effort, never block the response).
    activity.record({ category: 'Attendance', type: 'correction_submitted', title: 'Missing Punch Request',
      name: req.user.name, meta: `${PUNCH_TYPES[punchType]} @ ${requestedTime} on ${attendanceDate}` });
    requestNotify.emailApplyAcknowledgement({ type: 'missing_punch', toEmail: req.user.email, employeeName: req.user.name, approverName: 'HR' });
    (async () => {
      try {
        const approvers = await requestNotify.getApprovers();
        const approver = approvers[0];
        if (approver) requestNotify.notifyNewRequest({
          type: 'missing_punch', recordId: created.hr_attendancerequestid, actor: req.user,
          details: [['Date', attendanceDate], ['Punch Type', PUNCH_TYPES[punchType]], ['Requested Time', requestedTime], ['Reason', reason || '—']],
          applyTime: new Date().toISOString(),
          approver: { id: approver.hr_hremployeeid, name: approver.hr_hremployee1, email: approver.hr_email },
        });
      } catch (_) {}
    })();

    res.status(201).json({ data: view(created) });
  } catch (err) { next(err); }
});

// GET /api/attendance-requests — employees see their own; HR/Admin see all (?status=pending).
router.get('/', requirePermission('attendance:read'), async (req, res, next) => {
  try {
    const isHR = ['super_admin', 'hr_manager'].includes(req.user.role);
    const filters = [];
    if (!isHR) filters.push(`hr_employeeid eq '${req.user.id}'`);
    else if (req.query.employeeId) filters.push(`hr_employeeid eq '${req.query.employeeId}'`);
    if (req.query.status) filters.push(`hr_status eq '${req.query.status}'`);
    let data = [];
    try {
      const r = await d365.getList(REQ, { filter: filters.join(' and ') || undefined, orderby: 'createdon desc', top: 500 });
      data = (r.data || []).map(view);
    } catch (err) { if (!notConfigured(err)) throw err; }   // table missing → empty list
    res.json({ data, count: data.length });
  } catch (err) { next(err); }
});

// Shared approve/reject. On approve: insert the punch and recalculate the day.
async function decide(user, id, decision, comment, { enforcePending = false } = {}) {
  const reqRec = await d365.getById(REQ, id, {});
  if (enforcePending && reqRec.hr_status && reqRec.hr_status !== 'pending') {
    const e = new Error(`This request is already ${reqRec.hr_status}`); e.status = 409; throw e;
  }
  const now = time.istDateStr();
  const patch = {
    hr_status: decision, hr_approvedby: user.name, hr_approveddate: now,
    hr_approvercomment: comment || '',
  };

  if (decision === 'approved') {
    const record = await findAttendanceRecord(reqRec.hr_employeeid, reqRec.hr_attendancedate);
    if (!record) { const e = new Error('No attendance record found for that date to correct'); e.status = 404; throw e; }
    const originalTimes = punchesFromRecord(record).map(p => p.t || p);
    const correctedTimes = insertPunchTime(originalTimes, reqRec.hr_requestedtime);
    const shift = await shiftFor(reqRec.hr_employeeid);
    const c = computeSession(correctedTimes, shift);                       // ← automatic recalculation
    await d365.update(ATT, record.hr_hrattendanceid, punchPayload(c));     // corrected day persisted
    patch.hr_originalpunches = JSON.stringify(originalTimes);              // audit: never lose history
    patch.hr_correctedpunches = JSON.stringify(correctedTimes);
    patch.hr_attendancerecordid = record.hr_hrattendanceid;
  }

  const updated = await d365.update(REQ, id, patch);

  activity.record({ category: 'Attendance', type: decision === 'approved' ? 'correction_approved' : 'correction_rejected',
    title: `Missing Punch ${decision === 'approved' ? 'Approved' : 'Rejected'}`, name: reqRec.hr_employeename,
    meta: `${PUNCH_TYPES[reqRec.hr_punchtype] || reqRec.hr_punchtype} @ ${reqRec.hr_requestedtime} on ${reqRec.hr_attendancedate}` });
  requestNotify.emailDecisionToEmployee({
    type: 'missing_punch', employeeId: reqRec.hr_employeeid, decision,
    approver: { name: user.name, email: user.email, role: user.role },
    remarks: comment || '', status: decision,
  });
  return updated;
}

// PATCH /api/attendance-requests/:id/approve  (HR / Super Admin)
router.patch('/:id/approve', requireRole('super_admin', 'hr_manager'), async (req, res, next) => {
  try { const u = await decide(req.user, req.params.id, 'approved', req.body.comment); res.json({ data: view(u) }); }
  catch (err) { if (err.status) return res.status(err.status).json({ error: err.message }); next(err); }
});

// PATCH /api/attendance-requests/:id/reject  (HR / Super Admin)
router.patch('/:id/reject', requireRole('super_admin', 'hr_manager'), async (req, res, next) => {
  try { const u = await decide(req.user, req.params.id, 'rejected', req.body.comment); res.json({ data: view(u) }); }
  catch (err) { if (err.status) return res.status(err.status).json({ error: err.message }); next(err); }
});

// POST /api/attendance-requests/:id/email-action — approve/reject from an email button.
router.post('/:id/email-action', requireRole('super_admin', 'hr_manager'), async (req, res, next) => {
  try {
    const { action, token, comment } = req.body;
    if (!token) return res.status(400).json({ error: 'Approval token required' });
    let claim;
    try { claim = verifyApprovalToken(token); } catch (_) { return res.status(401).json({ error: 'Approval link is invalid or has expired' }); }
    if (claim.type !== 'missing_punch' || claim.id !== req.params.id) return res.status(400).json({ error: 'Approval link does not match this request' });
    const decision = action || claim.action;
    if (!['approved', 'rejected'].includes(decision)) return res.status(400).json({ error: 'Invalid action' });
    const u = await decide(req.user, req.params.id, decision, comment, { enforcePending: true });
    res.json({ data: view(u) });
  } catch (err) { if (err.status) return res.status(err.status).json({ error: err.message }); next(err); }
});

module.exports = router;
