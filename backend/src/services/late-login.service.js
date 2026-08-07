/**
 * Late Login requests (and, future-ready, other self-service request types via
 * hr_requesttype: Early Logout / WFH / Permission / On Duty / Client Visit /
 * Business Travel — the same table + API serve all of them).
 *
 * An employee submits a Late Login (Date, Expected/Actual login time, Reason,
 * Remarks, optional Attachment). Two-step approval: reporting manager → HR (unless
 * settings disable approval, then it is auto-approved). Attendance stays Present
 * and NO leave/salary is deducted — this is purely a record (a future payroll
 * penalty hook exists in settings but is off by default).
 */
const d365 = require('./d365.service');
const payrollSettings = require('./payroll-settings.service');
const { toValue } = require('./picklist');
let notif; try { notif = require('./notification.service'); } catch (_) { notif = null; }
let activity; try { activity = require('./activity.service'); } catch (_) { activity = null; }

const LATE = d365.constructor.entities.lateLogin;
const EMP = d365.constructor.entities.employee;

const audit = (p) => { try { activity?.record?.(p); } catch (_) {} };
const notifyUser = (id, ev, p) => { try { notif?.notifyUser?.(id, ev, p); } catch (_) {} };
const broadcast = (ev, p) => { try { notif?.broadcast?.(ev, p); } catch (_) {} };
const esc = (v) => String(v ?? '').replace(/'/g, "''");
const today = () => new Date().toISOString().slice(0, 10);
const addDays = (dateStr, days) => { const d = new Date(`${dateStr}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + Number(days)); return d.toISOString().slice(0, 10); };

// New columns (requestType/attachmentId/ip) are optional so reads degrade until provisioned.
const SELECT_BASE = 'hr_lateloginid,hr_employeeid,hr_employeename,hr_date,hr_month,hr_expectedtime,hr_actualtime,hr_reason,hr_remarks,hr_status,hr_managerstatus,hr_approvedby,hr_approveddate,hr_createdby,createdon';
const SELECT_OPT = 'hr_requesttype,hr_attachmentid,hr_ip';

const shape = (r) => ({
  id: r.hr_lateloginid,
  employeeId: r.hr_employeeid,
  employeeName: r.hr_employeename || '',
  date: r.hr_date || '',
  month: r.hr_month || '',
  expectedTime: r.hr_expectedtime || '',
  actualTime: r.hr_actualtime || '',
  reason: r.hr_reason || '',
  remarks: r.hr_remarks || '',
  status: r.hr_status || 'pending',
  managerStatus: r.hr_managerstatus || 'pending',
  approvedBy: r.hr_approvedby || '',
  approvedDate: r.hr_approveddate || '',
  createdBy: r.hr_createdby || '',
  requestType: r.hr_requesttype || 'late_login',
  attachmentId: r.hr_attachmentid || '',
  ip: r.hr_ip || '',
  createdOn: r.createdon,
});

async function getRaw(id) {
  const r = await d365.getByIdOptional(LATE, id, { select: SELECT_BASE, optionalSelect: SELECT_OPT });
  return r;
}

async function list({ employeeId, month, status, requestType, from, to } = {}) {
  const filters = [];
  if (employeeId) filters.push(`hr_employeeid eq '${esc(employeeId)}'`);
  if (month) filters.push(`hr_month eq '${esc(month)}'`);
  if (status) filters.push(`hr_status eq '${esc(status)}'`);
  if (requestType) filters.push(`hr_requesttype eq '${esc(requestType)}'`);
  if (from) filters.push(`hr_date ge '${esc(from)}'`);
  if (to) filters.push(`hr_date le '${esc(to)}'`);
  const { data } = await d365.getListOptional(LATE, { select: SELECT_BASE, optionalSelect: SELECT_OPT, filter: filters.join(' and ') || undefined, orderby: 'createdon desc', top: 5000 });
  return (data || []).map(shape);
}

async function policy() {
  try { return (await payrollSettings.getResolved()).lateLogin; }
  catch { return { graceMinutes: 15, maxPerMonth: 3, backdatedDays: 30, allowFuture: true, approvalRequired: true, attendanceMode: 'late_present', penaltyEnabled: false }; }
}

/** How many requests (pending or approved) the employee already has this month. */
async function monthlyCount(employeeId, month) {
  try {
    const { data } = await d365.getList(LATE, {
      select: 'hr_lateloginid,hr_status',
      filter: `hr_employeeid eq '${esc(employeeId)}' and hr_month eq '${esc(month)}'`, top: 200,
    });
    return (data || []).filter(r => !['rejected', 'cancelled'].includes(r.hr_status)).length;
  } catch { return 0; }
}

// ── email helpers (best-effort; never throw / block) ──────────────────────────
async function sendEmail(to, subject, html) { try { if (to && notif?.sendEmail) await notif.sendEmail(to, subject, html); } catch (e) { global.logger?.warn?.(`[late-login] email skipped: ${e.message}`); } }
async function getEmployee(id) { try { return await d365.getByIdOptional(EMP, id, { select: 'hr_email,hr_hremployee1,hr_department', optionalSelect: '_hr_manager_value' }); } catch { return null; } }
async function managerEmail(employeeId) {
  try {
    const emp = await d365.getByIdOptional(EMP, employeeId, { select: 'hr_hremployeeid', optionalSelect: '_hr_manager_value' });
    if (!emp?._hr_manager_value) return null;
    const mgr = await d365.getById(EMP, emp._hr_manager_value, { select: 'hr_email' });
    return mgr?.hr_email || null;
  } catch { return null; }
}
async function hrEmails() {
  try {
    const { data } = await d365.getList(EMP, {
      select: 'hr_email',
      filter: `(hr_role eq ${toValue('hr_role', 'super_admin')} or hr_role eq ${toValue('hr_role', 'hr_manager')}) and hr_status eq ${toValue('hr_employee_status', 'active')}`,
    });
    return (data || []).map(e => e.hr_email).filter(Boolean);
  } catch { return []; }
}

const REQ_LABEL = { late_login: 'Late Login', early_logout: 'Early Logout', wfh: 'Work From Home', permission: 'Permission', on_duty: 'On Duty', client_visit: 'Client Visit', travel: 'Business Travel' };

/**
 * Create a request. Returns { record, warning }. Validates the date window
 * (backdated ≤ setting; future only when allowed). `warning` is set when the
 * monthly limit is exceeded (submission still proceeds; HR keeps authority).
 */
async function create({ employeeId, employeeName, date, expectedTime, actualTime, reason, remarks, attachmentId, requestType = 'late_login', ip, createdBy }) {
  const ds = String(date || '').slice(0, 10);
  const p = await policy();
  const t = today();
  // Future / backdated validation (spec §3/§4).
  if (ds > t && !p.allowFuture) { const e = new Error('Future Late Login requests are not allowed.'); e.status = 400; throw e; }
  const earliest = addDays(t, -(Number(p.backdatedDays) || 30));
  if (ds < earliest) { const e = new Error(`You can submit Late Login requests only within the previous ${Number(p.backdatedDays) || 30} days.`); e.status = 400; throw e; }

  const month = ds.slice(0, 7);
  const priorCount = await monthlyCount(employeeId, month);
  const warning = (priorCount + 1) > Number(p.maxPerMonth || 0)
    ? `This is Late Login #${priorCount + 1} this month, exceeding the limit of ${p.maxPerMonth}. HR approval is required.`
    : '';
  const name = employeeName || '';
  const autoApprove = !p.approvalRequired;
  let payload = {
    hr_name: `${name || employeeId} · ${REQ_LABEL[requestType] || 'Late Login'} · ${ds}`.slice(0, 250),
    hr_employeeid: String(employeeId), hr_employeename: name, hr_date: ds, hr_month: month,
    hr_expectedtime: String(expectedTime || ''), hr_actualtime: String(actualTime || ''),
    hr_reason: reason || '', hr_remarks: remarks || '',
    hr_status: autoApprove ? 'approved' : 'pending', hr_managerstatus: autoApprove ? 'approved' : 'pending',
    hr_createdby: createdBy || '', hr_requesttype: requestType || 'late_login',
    hr_attachmentid: attachmentId || '', hr_ip: ip || '',
    ...(autoApprove ? { hr_approvedby: 'Auto', hr_approveddate: new Date().toISOString() } : {}),
  };
  // Resilient create — strip a not-yet-provisioned optional column and retry.
  let created;
  for (let i = 0; i < 5; i++) {
    try { created = await d365.create(LATE, payload); break; }
    catch (err) {
      if (d365._isMissingProperty?.(err)) { const prop = d365._missingPropertyName?.(err); if (prop && payload[prop] !== undefined) { delete payload[prop]; continue; } }
      throw err;
    }
  }

  const label = REQ_LABEL[requestType] || 'Late Login';
  notifyUser(employeeId, 'latelogin:submitted', { date: ds });
  audit({ category: 'Attendance', type: 'latelogin_submitted', title: `${label} submitted`, name, meta: { date: ds, requestType, ip, exceeded: !!warning } });
  if (!autoApprove) {
    broadcast('latelogin:pending', { employeeName: name, date: ds });
    // Email manager + HR (spec §6).
    const [mgr, hrs] = await Promise.all([managerEmail(employeeId), hrEmails()]);
    const recipients = [...new Set([mgr, ...hrs].filter(Boolean))];
    const html = `<p>${name || 'An employee'} submitted a ${label} request.</p><p><b>Date:</b> ${ds}<br/><b>Expected:</b> ${expectedTime || '—'} · <b>Actual:</b> ${actualTime || '—'}<br/><b>Reason:</b> ${reason || '—'}</p>${warning ? `<p style="color:#b45309">${warning}</p>` : ''}<p>Please review in the HR portal.</p>`;
    for (const to of recipients) await sendEmail(to, `${label} Request Submitted`, html);
  } else {
    notifyUser(employeeId, 'latelogin:approved', { date: ds });
  }
  return { record: shape({ ...payload, hr_lateloginid: created.hr_lateloginid }), warning };
}

// Manager decision (first step). action = 'approved' | 'rejected'.
async function managerDecide(id, action, approver, remarks) {
  const row = await getRaw(id);
  const patch = { hr_managerstatus: action };
  if (action === 'rejected') { patch.hr_status = 'rejected'; patch.hr_approvedby = approver?.name || 'Manager'; patch.hr_approveddate = new Date().toISOString(); if (remarks) patch.hr_remarks = remarks; }
  await d365.update(LATE, id, patch);
  if (action === 'approved') { broadcast('latelogin:manager_approved', { employeeName: row.hr_employeename, date: row.hr_date }); }
  else { notifyUser(row.hr_employeeid, 'latelogin:rejected', { date: row.hr_date, by: 'Manager' }); await emailDecision(row, 'rejected'); }
  audit({ category: 'Attendance', type: `latelogin_manager_${action}`, title: `Late Login ${action} (Manager)`, name: row.hr_employeename, meta: { by: approver?.name } });
  return shape({ ...row, ...patch });
}

// HR decision (final step). action = 'approved' | 'rejected'.
async function hrDecide(id, action, approver, remarks) {
  const row = await getRaw(id);
  const patch = { hr_status: action, hr_approvedby: approver?.name || 'HR', hr_approveddate: new Date().toISOString() };
  if (action === 'approved') patch.hr_managerstatus = 'approved';
  if (remarks) patch.hr_remarks = remarks;
  await d365.update(LATE, id, patch);
  notifyUser(row.hr_employeeid, `latelogin:${action}`, { date: row.hr_date, by: approver?.name || 'HR' });
  await emailDecision(row, action);
  audit({ category: 'Attendance', type: `latelogin_${action}`, title: `Late Login ${action}`, name: row.hr_employeename, meta: { by: approver?.name, approvedDate: patch.hr_approveddate } });
  return shape({ ...row, ...patch });
}

// Employee cancels their own pending request.
async function cancel(id, by) {
  const row = await getRaw(id);
  await d365.update(LATE, id, { hr_status: 'cancelled' });
  audit({ category: 'Attendance', type: 'latelogin_cancelled', title: 'Late Login cancelled', name: row.hr_employeename, meta: { by: by?.name } });
  return shape({ ...row, hr_status: 'cancelled' });
}

async function emailDecision(row, action) {
  const emp = await getEmployee(row.hr_employeeid);
  const label = REQ_LABEL[row.hr_requesttype || 'late_login'] || 'Late Login';
  const subject = action === 'approved' ? `${label} Approved` : `${label} Rejected`;
  const html = `<p>Hi ${emp?.hr_hremployee1 || row.hr_employeename || ''},</p><p>Your ${label} request for <b>${row.hr_date}</b> has been <b>${action}</b>.</p>${row.hr_remarks ? `<p><b>Remarks:</b> ${row.hr_remarks}</p>` : ''}`;
  await sendEmail(emp?.hr_email, subject, html);
}

/** Dashboard counts for an employee (or all, for HR). */
async function summary({ employeeId, month } = {}) {
  const rows = await list({ employeeId, month });
  return {
    total: rows.length,
    pending: rows.filter(r => r.status === 'pending').length,
    approved: rows.filter(r => r.status === 'approved').length,
    rejected: rows.filter(r => r.status === 'rejected').length,
    cancelled: rows.filter(r => r.status === 'cancelled').length,
  };
}

/** Is there an APPROVED late login for this employee on this date? (attendance overlay) */
async function approvedOn(employeeId, date) {
  try {
    const { data } = await d365.getList(LATE, {
      select: 'hr_lateloginid',
      filter: `hr_employeeid eq '${esc(employeeId)}' and hr_date eq '${esc(String(date).slice(0, 10))}' and hr_status eq 'approved'`, top: 1,
    });
    return !!(data && data[0]);
  } catch { return false; }
}

/**
 * A Set of `${employeeId}|${date}` for every APPROVED late login in a window —
 * used by the attendance list to label days without extra per-row queries.
 * Best-effort: any failure (e.g. table not yet provisioned) yields an empty Set.
 */
async function approvedSet({ from, to, employeeId } = {}) {
  try {
    const filters = [`hr_status eq 'approved'`];
    if (employeeId) filters.push(`hr_employeeid eq '${esc(employeeId)}'`);
    if (from) filters.push(`hr_date ge '${esc(String(from).slice(0, 10))}'`);
    if (to) filters.push(`hr_date le '${esc(String(to).slice(0, 10))}'`);
    const { data } = await d365.getList(LATE, { select: 'hr_employeeid,hr_date', filter: filters.join(' and '), top: 5000 });
    return new Set((data || []).map(r => `${r.hr_employeeid}|${String(r.hr_date || '').slice(0, 10)}`));
  } catch { return new Set(); }
}

module.exports = { list, getRaw, shape, create, managerDecide, hrDecide, cancel, monthlyCount, summary, approvedOn, approvedSet, policy, REQ_LABEL };
