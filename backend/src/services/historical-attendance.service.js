/**
 * Historical Attendance Requests.
 *
 * An employee raises a request to record attendance for a PAST date they were
 * marked Absent (Date, In/Out, Reason, Comments, optional Attachment). HR approves,
 * rejects, or asks for more information. On APPROVAL the SINGLE attendance record
 * for that date is created-or-UPDATED (never a second row) with the punches, its
 * status recomputed by computeSession, source = manual, plus Approved By / Date.
 * Because Present/Absent/Half-Day/Late and payroll all DERIVE from the one
 * attendance record, the dashboard self-recalculates. If payroll for that month is
 * already processed/locked, the caller is warned to regenerate. Full audit is kept
 * (old status → new status), nothing is ever deleted.
 */
const d365 = require('./d365.service');
const { toValue, toLabel } = require('./picklist');
const { computeSession, punchesFromRecord } = require('./attendance.util');
const payrollSettings = require('./payroll-settings.service');
let attnCfg; try { attnCfg = require('./attendance.config'); } catch (_) { attnCfg = null; }
let notif; try { notif = require('./notification.service'); } catch (_) { notif = null; }
let activity; try { activity = require('./activity.service'); } catch (_) { activity = null; }
const { ENTITY_SET: ATT_AUDIT_SET } = require('./provision-attendance-audit');

const HIST = 'hr_histattendances';
const ATT = d365.constructor.entities.attendance;
const EMP = d365.constructor.entities.employee;
const PAYROLL = d365.constructor.entities.payroll;

const esc = (v) => String(v ?? '').replace(/'/g, "''");
const today = () => new Date().toISOString().slice(0, 10);
const audit = (p) => { try { activity?.record?.(p); } catch (_) {} };
const notifyUser = (id, ev, p) => { try { notif?.notifyUser?.(id, ev, p); } catch (_) {} };
const broadcast = (ev, p) => { try { notif?.broadcast?.(ev, p); } catch (_) {} };
async function sendEmail(to, subject, html) { try { if (to && notif?.sendEmail) await notif.sendEmail(to, subject, html, { meta: { type: 'hist_attendance' } }); } catch (e) { global.logger?.warn?.(`[hist-attendance] email skipped: ${e.message}`); } }

const SELECT = 'hr_histattendanceid,hr_employeeid,hr_employeename,hr_date,hr_month,hr_intime,hr_outtime,hr_reason,hr_comments,hr_attachmentid,hr_status,hr_approvedby,hr_approveddate,hr_approvercomment,hr_oldstatus,hr_newstatus,createdon';

const shape = (r) => ({
  id: r.hr_histattendanceid,
  employeeId: r.hr_employeeid,
  employeeName: r.hr_employeename || '',
  date: r.hr_date || '',
  month: r.hr_month || '',
  inTime: r.hr_intime || '',
  outTime: r.hr_outtime || '',
  reason: r.hr_reason || '',
  comments: r.hr_comments || '',
  attachmentId: r.hr_attachmentid || '',
  status: r.hr_status || 'pending',
  approvedBy: r.hr_approvedby || '',
  approvedDate: r.hr_approveddate || '',
  approverComment: r.hr_approvercomment || '',
  oldStatus: r.hr_oldstatus || '',
  newStatus: r.hr_newstatus || '',
  createdOn: r.createdon,
});

async function getRaw(id) { return d365.getById(HIST, id, { select: SELECT }); }

async function list({ employeeId, status, month } = {}) {
  const f = [];
  if (employeeId) f.push(`hr_employeeid eq '${esc(employeeId)}'`);
  if (status) f.push(`hr_status eq '${esc(status)}'`);
  if (month) f.push(`hr_month eq '${esc(month)}'`);
  const { data } = await d365.getList(HIST, { select: SELECT, filter: f.join(' and ') || undefined, orderby: 'createdon desc', top: 2000 });
  return (data || []).map(shape);
}

async function policy() {
  try { return (await payrollSettings.getResolved()).historicalAttendance || { monthsBack: 6 }; }
  catch { return { monthsBack: 6 }; }
}

function monthsAgo(n) { const d = new Date(); d.setMonth(d.getMonth() - Number(n || 6)); return d.toISOString().slice(0, 10); }

async function getEmployee(id) { try { return await d365.getByIdOptional(EMP, id, { select: 'hr_email,hr_hremployee1', optionalSelect: 'hr_shiftname,hr_shiftstarttime,hr_shiftendtime' }); } catch { return null; } }
function shiftOf(emp) { try { return attnCfg ? attnCfg.resolveEmployeeShift(emp?.hr_shiftname, emp?.hr_shiftstarttime, emp?.hr_shiftendtime) : undefined; } catch { return attnCfg?.resolveShift?.(); } }
async function hrEmails() {
  try {
    const { data } = await d365.getList(EMP, { select: 'hr_email', filter: `(hr_role eq ${toValue('hr_role', 'super_admin')} or hr_role eq ${toValue('hr_role', 'hr_manager')}) and hr_status eq ${toValue('hr_employee_status', 'active')}` });
    return (data || []).map(e => e.hr_email).filter(Boolean);
  } catch { return []; }
}

/** Recomputed session → attendance record columns. */
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
  hr_source: toValue('hr_attendance_source', 'manual_correction'),   // Historical Attendance (manual source)
});

/**
 * Create a request. Validates the date window (past, within the configured months)
 * and blocks a duplicate PENDING request for the same employee/date.
 */
async function create({ employeeId, employeeName, date, inTime, outTime, reason, comments, attachmentId, ip, createdBy }) {
  const ds = String(date || '').slice(0, 10);
  const t = today();
  if (!ds) { const e = new Error('Date is required.'); e.status = 400; throw e; }
  if (ds > t) { const e = new Error('Historical Attendance can only be raised for a past date.'); e.status = 400; throw e; }
  const p = await policy();
  const earliest = monthsAgo(p.monthsBack);
  if (ds < earliest) { const e = new Error(`You can raise Historical Attendance only within the last ${p.monthsBack} months.`); e.status = 400; throw e; }
  if (!String(reason || '').trim()) { const e = new Error('Reason is required.'); e.status = 400; throw e; }

  // No duplicate pending for the same employee + date (spec §10).
  try {
    const { data } = await d365.getList(HIST, { select: 'hr_histattendanceid', filter: `hr_employeeid eq '${esc(employeeId)}' and hr_date eq '${esc(ds)}' and hr_status eq 'pending'`, top: 1 });
    if (data && data[0]) { const e = new Error('A Historical Attendance request for this date is already pending.'); e.status = 409; throw e; }
  } catch (e) { if (e.status === 409) throw e; /* table not provisioned → create handles it */ }

  const month = ds.slice(0, 7);
  const name = employeeName || '';
  let payload = {
    hr_name: `${name || employeeId} · Historical Attendance · ${ds}`.slice(0, 250),
    hr_employeeid: String(employeeId), hr_employeename: name, hr_date: ds, hr_month: month,
    hr_intime: String(inTime || ''), hr_outtime: String(outTime || ''),
    hr_reason: reason || '', hr_comments: comments || '', hr_attachmentid: attachmentId || '',
    hr_status: 'pending', hr_createdby: createdBy || '', hr_ip: ip || '',
  };
  let created;
  for (let i = 0; i < 6; i++) {
    try { created = await d365.create(HIST, payload); break; }
    catch (err) {
      if (d365._isMissingProperty?.(err)) { const prop = d365._missingPropertyName?.(err); if (prop && payload[prop] !== undefined) { delete payload[prop]; continue; } }
      throw err;
    }
  }

  notifyUser(employeeId, 'histattendance:submitted', { date: ds });
  broadcast('histattendance:pending', { employeeName: name, date: ds });
  audit({ category: 'Attendance', type: 'histattendance_submitted', title: 'Historical Attendance requested', name, meta: { date: ds } });
  const hrs = await hrEmails();
  const html = `<p>${name || 'An employee'} raised a Historical Attendance request.</p><p><b>Date:</b> ${ds}<br/><b>In:</b> ${inTime || '—'} · <b>Out:</b> ${outTime || '—'}<br/><b>Reason:</b> ${reason || '—'}</p><p>Please review in the HR portal.</p>`;
  for (const to of [...new Set(hrs)]) await sendEmail(to, 'Historical Attendance Request Submitted', html);
  return shape({ ...payload, hr_histattendanceid: created.hr_histattendanceid });
}

async function findAttendance(empId, date) {
  const { data } = await d365.getList(ATT, {
    select: 'hr_hrattendanceid,hr_date,hr_intime,hr_outtime,hr_allpunches,hr_punchcount,hr_status,_hr_hremployee_value',
    filter: `_hr_hremployee_value eq '${esc(empId)}' and hr_date eq ${date}`, top: 1,
  });
  return (data && data[0]) || null;
}

async function writeAttendanceAudit({ attendanceId, employeeId, employeeName, date, oldStatus, newStatus, inTime, outTime, updatedBy, reason }) {
  try {
    await d365.create(ATT_AUDIT_SET, {
      hr_name: `${employeeName || employeeId} · ${date} · historical`.slice(0, 250),
      hr_attendanceid: String(attendanceId || ''), hr_employeeid: String(employeeId || ''), hr_employeename: employeeName || '',
      hr_date: date, hr_action: 'historical_attendance',
      hr_oldvalue: JSON.stringify({ status: oldStatus }), hr_newvalue: JSON.stringify({ status: newStatus, inTime, outTime }),
      hr_updatedby: updatedBy || '', hr_updatedon: new Date().toISOString(), hr_reason: reason || '',
    });
  } catch (e) { global.logger?.warn?.(`[hist-attendance] audit skipped: ${e.message}`); }
}

/** Is payroll for that employee's month already finalised (processed/paid/locked)? */
async function payrollFinalised(employeeId, month) {
  try {
    const [y, m] = month.split('-').map(Number);
    const draft = toValue('hr_payroll_status', 'draft');
    const { data } = await d365.getListOptional(PAYROLL, {
      select: 'hr_hrpayrollid,hr_status', optionalSelect: 'hr_locked',
      filter: `_hr_hremployee_value eq '${esc(employeeId)}' and hr_month eq ${m} and hr_year eq ${y}`, top: 1,
    });
    const row = data && data[0];
    if (!row) return false;
    return row.hr_locked === 'true' || (row.hr_status !== undefined && row.hr_status !== draft);
  } catch { return false; }
}

/**
 * HR decision. action = 'approved' | 'rejected' | 'more_info'.
 * On approval, upsert the single attendance record for the date.
 */
async function decide(id, action, approver, comment) {
  const row = await getRaw(id);
  const empId = row.hr_employeeid;
  const ds = String(row.hr_date || '').slice(0, 10);
  const patch = { hr_status: action, hr_approvedby: approver?.name || 'HR', hr_approveddate: new Date().toISOString(), hr_approvercomment: comment || '' };
  let warning = null;

  if (action === 'approved') {
    const emp = await getEmployee(empId);
    const shift = shiftOf(emp);
    const existing = await findAttendance(empId, ds);
    const oldStatus = existing ? (toLabel('hr_attendance_status', existing.hr_status) || 'absent') : 'absent';
    const times = [row.hr_intime, row.hr_outtime].map(t => String(t ?? '').trim()).filter(Boolean);
    const c = computeSession(times, shift);
    const body = punchPayload(c);
    let attendanceId;
    if (existing) {
      await d365.update(ATT, existing.hr_hrattendanceid, body);   // REPLACE — never a second row
      attendanceId = existing.hr_hrattendanceid;
    } else {
      const saved = await d365.create(ATT, { 'hr_hremployee@odata.bind': `/hr_hremployees(${empId})`, hr_date: ds, ...body });
      attendanceId = saved.hr_hrattendanceid;
    }
    const newStatus = c.status;
    patch.hr_oldstatus = oldStatus;
    patch.hr_newstatus = newStatus;

    await writeAttendanceAudit({ attendanceId, employeeId: empId, employeeName: row.hr_employeename, date: ds, oldStatus, newStatus, inTime: body.hr_intime, outTime: body.hr_outtime, updatedBy: approver?.name, reason: row.hr_reason });

    // Payroll: recalculates automatically on the next generation for a draft/none
    // month; if already finalised, warn that it needs regeneration (spec §5).
    if (await payrollFinalised(empId, row.hr_month || ds.slice(0, 7))) {
      warning = 'Attendance changed after payroll generation. Payroll needs regeneration.';
      broadcast('payroll:needs_regeneration', { employeeName: row.hr_employeename, month: row.hr_month || ds.slice(0, 7), date: ds });
    }
    notifyUser(empId, 'histattendance:approved', { date: ds });
    audit({ category: 'Attendance', type: 'histattendance_approved', title: 'Historical Attendance approved', name: row.hr_employeename, meta: { date: ds, oldStatus, newStatus, by: approver?.name } });
    await emailEmployee(emp, row, 'approved', comment, { oldStatus, newStatus });
  } else {
    notifyUser(empId, `histattendance:${action}`, { date: ds });
    audit({ category: 'Attendance', type: `histattendance_${action}`, title: `Historical Attendance ${action === 'more_info' ? 'needs more info' : action}`, name: row.hr_employeename, meta: { date: ds, by: approver?.name } });
    await emailEmployee(await getEmployee(empId), row, action, comment);
  }

  await d365.update(HIST, id, patch);
  return { record: shape({ ...row, ...patch }), warning };
}

async function emailEmployee(emp, row, action, comment, extra = {}) {
  const subj = action === 'approved' ? 'Historical Attendance Approved' : action === 'rejected' ? 'Historical Attendance Rejected' : 'Historical Attendance — More Information Needed';
  const body = action === 'approved'
    ? `<p>Your Historical Attendance request for <b>${row.hr_date}</b> has been <b>approved</b>. Attendance updated: ${extra.oldStatus || 'Absent'} → <b>${extra.newStatus || 'Present'}</b>.</p>`
    : action === 'rejected'
      ? `<p>Your Historical Attendance request for <b>${row.hr_date}</b> has been <b>rejected</b>.</p>`
      : `<p>Your Historical Attendance request for <b>${row.hr_date}</b> needs more information. Please review and resubmit.</p>`;
  await sendEmail(emp?.hr_email, subj, `<p>Hi ${emp?.hr_hremployee1 || row.hr_employeename || ''},</p>${body}${comment ? `<p><b>HR comment:</b> ${comment}</p>` : ''}`);
}

async function summary({ employeeId, month } = {}) {
  const rows = await list({ employeeId, month });
  return {
    total: rows.length,
    pending: rows.filter(r => r.status === 'pending').length,
    approved: rows.filter(r => r.status === 'approved').length,
    rejected: rows.filter(r => r.status === 'rejected').length,
    moreInfo: rows.filter(r => r.status === 'more_info').length,
  };
}

module.exports = { list, getRaw, shape, create, decide, summary, policy };
