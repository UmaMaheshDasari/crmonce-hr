/**
 * Late Login requests. An employee submits a Late Login (Date, Expected/Actual
 * login time, Reason, Remarks) instead of a leave. Two-step approval: reporting
 * manager → HR. On approval attendance stays Present and NO leave is deducted —
 * this is purely a record, so no attendance/leave/payroll mutation is performed.
 *
 * A configurable monthly limit (Payroll Settings → Maximum Late Logins Per Month)
 * raises a WARNING when exceeded, but never blocks — HR keeps approval authority.
 */
const d365 = require('./d365.service');
const payrollSettings = require('./payroll-settings.service');
let notif; try { notif = require('./notification.service'); } catch (_) { notif = null; }
let activity; try { activity = require('./activity.service'); } catch (_) { activity = null; }

const LATE = d365.constructor.entities.lateLogin;
const EMP = d365.constructor.entities.employee;

const audit = (p) => { try { activity?.record?.(p); } catch (_) {} };
const notifyUser = (id, ev, p) => { try { notif?.notifyUser?.(id, ev, p); } catch (_) {} };
const broadcast = (ev, p) => { try { notif?.broadcast?.(ev, p); } catch (_) {} };
const esc = (v) => String(v ?? '').replace(/'/g, "''");
const SELECT = 'hr_lateloginid,hr_employeeid,hr_employeename,hr_date,hr_month,hr_expectedtime,hr_actualtime,hr_reason,hr_remarks,hr_status,hr_managerstatus,hr_approvedby,hr_approveddate,hr_createdby,createdon';

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
  createdOn: r.createdon,
});

async function getRaw(id) { return d365.getById(LATE, id, { select: SELECT }); }

async function list({ employeeId, month, status } = {}) {
  const filters = [];
  if (employeeId) filters.push(`hr_employeeid eq '${esc(employeeId)}'`);
  if (month) filters.push(`hr_month eq '${esc(month)}'`);
  if (status) filters.push(`hr_status eq '${esc(status)}'`);
  const { data } = await d365.getList(LATE, { select: SELECT, filter: filters.join(' and ') || undefined, orderby: 'createdon desc', top: 2000 });
  return (data || []).map(shape);
}

async function policy() {
  try { return (await payrollSettings.getResolved()).lateLogin; }
  catch { return { graceMinutes: 15, maxPerMonth: 3 }; }
}

/** How many late logins (pending or approved) the employee already has this month. */
async function monthlyCount(employeeId, month) {
  try {
    const { data } = await d365.getList(LATE, {
      select: 'hr_lateloginid,hr_status',
      filter: `hr_employeeid eq '${esc(employeeId)}' and hr_month eq '${esc(month)}'`, top: 200,
    });
    return (data || []).filter(r => r.hr_status !== 'rejected').length;
  } catch { return 0; }
}

/**
 * Create a Late Login request. Returns { record, warning } — `warning` is set when
 * the monthly limit is exceeded (submission still proceeds; HR keeps authority).
 */
async function create({ employeeId, employeeName, date, expectedTime, actualTime, reason, remarks, createdBy }) {
  const ds = String(date || '').slice(0, 10);
  const month = ds.slice(0, 7);
  const p = await policy();
  const priorCount = await monthlyCount(employeeId, month);
  const warning = (priorCount + 1) > Number(p.maxPerMonth || 0)
    ? `This is Late Login #${priorCount + 1} this month, exceeding the limit of ${p.maxPerMonth}. HR approval is required.`
    : '';
  const name = employeeName || '';
  const body = {
    hr_name: `${name || employeeId} · Late Login · ${ds}`.slice(0, 250),
    hr_employeeid: String(employeeId), hr_employeename: name, hr_date: ds, hr_month: month,
    hr_expectedtime: String(expectedTime || ''), hr_actualtime: String(actualTime || ''),
    hr_reason: reason || '', hr_remarks: remarks || '',
    hr_status: 'pending', hr_managerstatus: 'pending', hr_createdby: createdBy || '',
  };
  const created = await d365.create(LATE, body);
  broadcast('latelogin:pending', { employeeName: name, date: ds });
  notifyUser(employeeId, 'latelogin:submitted', { date: ds });
  audit({ category: 'Attendance', type: 'latelogin_submitted', title: 'Late Login submitted', name, meta: { date: ds, exceeded: !!warning } });
  return { record: shape({ ...body, hr_lateloginid: created.hr_lateloginid }), warning };
}

// Manager decision (first step). action = 'approved' | 'rejected'.
async function managerDecide(id, action, approver, remarks) {
  const row = await getRaw(id);
  const patch = { hr_managerstatus: action };
  if (action === 'rejected') { patch.hr_status = 'rejected'; patch.hr_approvedby = approver?.name || 'Manager'; patch.hr_approveddate = new Date().toISOString(); if (remarks) patch.hr_remarks = remarks; }
  await d365.update(LATE, id, patch);
  if (action === 'approved') { broadcast('latelogin:manager_approved', { employeeName: row.hr_employeename, date: row.hr_date }); }
  else { notifyUser(row.hr_employeeid, 'latelogin:rejected', { date: row.hr_date, by: 'Manager' }); }
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
  audit({ category: 'Attendance', type: `latelogin_${action}`, title: `Late Login ${action}`, name: row.hr_employeename, meta: { by: approver?.name } });
  return shape({ ...row, ...patch });
}

module.exports = { list, getRaw, shape, create, managerDecide, hrDecide, monthlyCount, policy };
