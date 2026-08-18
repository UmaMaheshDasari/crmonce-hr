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
const { toValue } = require('../../services/picklist');   // only hr_attendance_status (a real Choice) uses this
const { computeSession, punchesFromRecord } = require('../../services/attendance.util');
const { insertPunchTime, detectMissingPunches, PUNCH_TYPES } = require('../../services/missing-punch.util');
const attnCfg = require('../../services/attendance.config');
const time = require('../../services/time.util');
const activity = require('../../services/activity.service');
const requestNotify = require('../../services/request-notify.service');
const { verifyApprovalToken } = require('../../services/approval-token');
const { ensureAttendanceRequestTable, addMissingColumn } = require('../../services/provision-attendance-request');

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
  date: String(r.hr_attendancedate || '').slice(0, 10),
  // hr_punchtype / hr_status are TEXT string codes ('lunch_out', 'pending', …).
  punchType: r.hr_punchtype, punchTypeLabel: PUNCH_TYPES[r.hr_punchtype] || r.hr_punchtype,
  requestedTime: r.hr_requestedtime, reason: r.hr_reason, remarks: r.hr_remarks,
  attachmentUrl: r.hr_attachmenturl, status: r.hr_status,
  originalPunches: safeJson(r.hr_originalpunches), correctedPunches: safeJson(r.hr_correctedpunches),
  approvedBy: r.hr_approvedby, approvedDate: r.hr_approveddate, approverComment: r.hr_approvercomment,
  attendanceRecordId: r.hr_attendancerecordid || null,
  createdon: r.createdon,
});
const safeJson = (s) => { try { return JSON.parse(s || '[]'); } catch { return []; } };

// Create the request, self-healing an incomplete Dataverse schema:
//  - table missing entirely → provision it, then retry;
//  - a column missing ("property 'X' does not exist") → add that column if we can,
//    else drop it from the payload and retry.
// Guarantees the insert succeeds against whatever schema actually exists.
async function robustCreateRequest(body) {
  const log = global.logger || console;
  let payload = { ...body };
  const triedAdd = new Set();
  for (let i = 0; i < 25; i++) {
    try { return await d365.create(REQ, payload); }
    catch (err) {
      const msg = err.message || '';
      const missingProp = msg.match(/property '([^']+)' does not exist/i);
      if (missingProp) {
        const prop = missingProp[1];
        if (!triedAdd.has(prop)) {                  // try to CREATE the column once…
          triedAdd.add(prop);
          if (await addMissingColumn(prop, log).catch(() => false)) continue;   // added → retry full payload
        }
        delete payload[prop];                       // …still missing / not creatable → omit it
        log.warn?.(`[attendance-requests] column ${prop} unavailable — omitted from payload`);
        continue;
      }
      if (notConfigured(err)) {                      // whole table missing → provision + retry
        const prov = await ensureAttendanceRequestTable(log).catch(() => ({ status: 'unavailable' }));
        if (prov.status === 'unavailable') { const e = new Error('Attendance Requests could not be provisioned automatically. The D365 app registration needs the System Customizer role. Details: ' + (prov.reason || 'permission denied')); e.status = 503; throw e; }
        continue;
      }
      throw err;                                     // unrelated error → bubble up
    }
  }
  const e = new Error('Could not create the request after schema repair'); e.status = 500; throw e;
}

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
    const dateOnly = String(attendanceDate || '').slice(0, 10);
    if (!attendanceDate || !punchType || !requestedTime) {
      return res.status(400).json({ error: 'Attendance date, correction type and correct time are required' });
    }
    if (!PUNCH_TYPES[punchType]) return res.status(400).json({ error: 'Invalid correction type' });
    if (!/^\d{1,2}:\d{2}$/.test(requestedTime)) return res.status(400).json({ error: 'Correct time must be HH:MM' });
    if (!String(reason || '').trim()) return res.status(400).json({ error: 'Reason is required' });   // #8
    if (dateOnly > time.istDateStr()) return res.status(400).json({ error: 'Cannot request a correction for a future date' });

    // #8: no duplicate — block a second PENDING request for the same day.
    try {
      const { data: dupes } = await d365.getList(REQ, {
        filter: `hr_employeeid eq '${req.user.id}' and hr_attendancedate eq '${dateOnly}' and hr_status eq 'pending'`,
        top: 1,
      });
      if (dupes && dupes.length) return res.status(409).json({ error: 'A correction request for this date is already pending approval.' });
    } catch (_) { /* table not provisioned yet — robustCreateRequest handles that */ }

    // Every value is a STRING — hr_punchtype and hr_status are Edm.String (Text)
    // columns in Dataverse, so we store the string code, never an option-set int.
    const body = {
      hr_name: `Attendance Correction — ${req.user.name} — ${dateOnly}`,
      hr_employeeid: req.user.id, hr_employeename: req.user.name, hr_employeeemail: req.user.email || '',
      hr_attendancedate: String(attendanceDate).slice(0, 10),
      hr_punchtype: String(punchType),          // 'lunch_out' | 'missing_check_out' | …  (Text)
      hr_requestedtime: String(requestedTime),  // 'HH:MM' (Text)
      hr_reason: reason || '', hr_remarks: remarks || '', hr_attachmenturl: attachmentUrl || '',
      hr_status: 'pending',                     // Text
    };
    // Guard: every hr_attendancerequests column is Edm.String — never let a numeric
    // slip into the payload (that is the 0x80048d19 / "convert Int32 to String" 400).
    for (const k of Object.keys(body)) if (typeof body[k] === 'number') body[k] = String(body[k]);

    // Requirement #10: self-heal the schema (create table / add missing columns)
    // and retry — never return "not configured" when we can fix it automatically.
    const created = await robustCreateRequest(body);

    // Activity + emails (best-effort, never block the response).
    activity.record({ category: 'Attendance', type: 'correction_submitted', title: 'Attendance Correction Request',
      name: req.user.name, meta: `${PUNCH_TYPES[punchType]} @ ${requestedTime} on ${dateOnly}` });
    // Employee acknowledgement — "Attendance Correction Request Submitted", FROM the
    // employee's own mailbox. (moduleTitle overrides the display name for THIS email
    // only; the missing_punch DECISION email keeps its "Missing Punch" wording.)
    requestNotify.emailApplyAcknowledgement({ type: 'missing_punch', moduleTitle: 'Attendance Correction', toEmail: req.user.email, employeeName: req.user.name, approverName: 'HR' });
    // ONE actionable "Attendance Correction Request - {name}" email to the WHOLE
    // authorized HR queue (all active Super Admin + HR Manager) on the TO line, no
    // CC. FROM = the employee's own mailbox. Fire-and-forget — never blocks/faults
    // the submission; the record is already saved.
    requestNotify.emailCorrectionRequestToHR({
      recordId: created.hr_attendancerequestid, actor: req.user,
      details: [['Date', time.fmtDate(attendanceDate)], ['Punch Type', PUNCH_TYPES[punchType]], ['Requested Time', requestedTime], ['Reason', reason || '—']],
      applyTime: new Date().toISOString(),
    }).catch(() => {});

    res.status(201).json({ data: view(created) });
  } catch (err) { if (err.status) return res.status(err.status).json({ error: err.message }); next(err); }
});

// GET /api/attendance-requests — employees see their own; HR/Admin see all (?status=pending).
router.get('/', requirePermission('attendance:read'), async (req, res, next) => {
  try {
    const isHR = ['super_admin', 'hr_manager'].includes(req.user.role);
    const filters = [];
    if (!isHR) filters.push(`hr_employeeid eq '${req.user.id}'`);
    else if (req.query.employeeId) filters.push(`hr_employeeid eq '${req.query.employeeId}'`);
    if (req.query.status) filters.push(`hr_status eq '${req.query.status}'`);   // Text column
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
  const reqDate = String(reqRec.hr_attendancedate || '').slice(0, 10);
  // All Text columns → store string values (no option-set ints, no lookup bind).
  const patch = {
    hr_status: decision,                          // 'approved' | 'rejected' (Text)
    hr_approvedby: user.name,
    hr_approveddate: time.istDateStr(),           // 'YYYY-MM-DD' (Text)
    hr_approvercomment: comment || '',
  };

  if (decision === 'approved') {
    const record = await findAttendanceRecord(reqRec.hr_employeeid, reqDate);
    if (!record) { const e = new Error('No attendance record found for that date to correct'); e.status = 404; throw e; }
    const originalTimes = punchesFromRecord(record).map(p => p.t || p);
    const correctedTimes = insertPunchTime(originalTimes, reqRec.hr_requestedtime);
    const shift = await shiftFor(reqRec.hr_employeeid);
    const c = computeSession(correctedTimes, shift);                       // ← automatic recalculation
    await d365.update(ATT, record.hr_hrattendanceid, punchPayload(c));     // corrected day persisted
    patch.hr_originalpunches = JSON.stringify(originalTimes);              // audit: never lose history
    patch.hr_correctedpunches = JSON.stringify(correctedTimes);
    patch.hr_attendancerecordid = record.hr_hrattendanceid;               // corrected record (Text)
  }

  const updated = await d365.update(REQ, id, patch);

  activity.record({ category: 'Attendance', type: decision === 'approved' ? 'correction_approved' : 'correction_rejected',
    title: `Missing Punch ${decision === 'approved' ? 'Approved' : 'Rejected'}`, name: reqRec.hr_employeename,
    meta: `${PUNCH_TYPES[reqRec.hr_punchtype] || reqRec.hr_punchtype} @ ${reqRec.hr_requestedtime} on ${reqDate}` });
  // Decision email → the EMPLOYEE ONLY (no HR / manager CC). FROM the approver's mailbox.
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
