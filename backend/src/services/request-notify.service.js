/**
 * Shared request notifications for approval workflows (Leave, Late Permission).
 *
 * Reuses existing infrastructure only:
 *   - Nodemailer  → sendEmail()          (notification.service.js)
 *   - Socket.io   → broadcast/notifyUser (notification.service.js)
 *   - D365        → d365.service.js
 *   - JWT tokens  → approval-token.js
 *
 * No new email provider, no duplicated notification logic. Both request types
 * call the same functions so they "behave exactly the same".
 *
 * Every function is best-effort: it never throws and never blocks the caller
 * (Apply / Approve must succeed even if email or sockets fail).
 */
const d365 = require('./d365.service');
const { toValue } = require('./picklist');
const { sendEmail, broadcast, notifyUser } = require('./notification.service');
const { signApprovalToken } = require('./approval-token');

const EMP = d365.constructor.entities.employee;
const APP_URL = (process.env.FRONTEND_URL || 'https://hr.crmonce.com').replace(/\/$/, '');

const TYPE_CFG = {
  leave:           { title: 'Leave' },
  late_permission: { title: 'Late Permission' },
};

const rowHtml = (label, value) =>
  `<tr><td style="padding:3px 14px 3px 0;color:#374151;"><strong>${label}</strong></td>` +
  `<td style="padding:3px 0;color:#111827;">${value ?? '—'}</td></tr>`;

/** Active Super Admin recipients — looked up from the Employees table (never hardcoded). */
async function getSuperAdmins() {
  try {
    const { data } = await d365.getList(EMP, {
      filter: `hr_role eq ${toValue('hr_role', 'super_admin')} and hr_status eq ${toValue('hr_employee_status', 'active')}`,
      select: 'hr_hremployeeid,hr_email,hr_hremployee1',
    });
    return (data || []).filter(a => a.hr_email);
  } catch (err) {
    global.logger?.error(`getSuperAdmins failed: ${err.message}`);
    return [];
  }
}

/** Approve / Reject buttons, each carrying its own signed, short-lived token. */
function approvalButtons(type, id) {
  const mk = (action, label, color) => {
    const token = signApprovalToken({ type, id, level: 'hr', action });
    const url = `${APP_URL}/approve?type=${type}&id=${encodeURIComponent(id)}&action=${action}&t=${encodeURIComponent(token)}`;
    return `<a href="${url}" style="display:inline-block;padding:11px 26px;margin:0 8px 0 0;border-radius:8px;` +
           `background:${color};color:#fff;text-decoration:none;font-weight:600;` +
           `font-family:Arial,sans-serif;font-size:14px;">${label}</a>`;
  };
  return `<div style="margin:20px 0 4px;">${mk('approved', 'Approve', '#059669')}${mk('rejected', 'Reject', '#dc2626')}</div>`;
}

/**
 * New request → notify Super Admin(s) in-app + email with Approve/Reject buttons.
 * Call AFTER a successful D365 create.
 *   type      : 'leave' | 'late_permission'
 *   recordId  : D365 record id
 *   actor     : req.user (authenticated employee — id, name)
 *   details   : array of [label, value] rows specific to the request type
 *   applyTime : ISO string
 */
async function notifyNewRequest({ type, recordId, actor, details, applyTime }) {
  try {
    const cfg = TYPE_CFG[type] || { title: type };
    const admins = await getSuperAdmins();

    // In-app: notify each Super Admin + broadcast for any listening bell.
    const payload = { requestType: type, id: recordId, employeeName: actor?.name };
    admins.forEach(a => notifyUser(a.hr_hremployeeid, 'request:new', payload));
    broadcast('request:new', payload);

    const recipients = admins.map(a => a.hr_email);
    if (recipients.length === 0) {
      global.logger?.warn(`${cfg.title} new-request email skipped: no active Super Admin with an email`);
      return;
    }

    // Department is not in the JWT — fetch it (best-effort).
    let department = '—';
    try {
      const emp = await d365.getById(EMP, actor.id, { select: 'hr_department' });
      department = emp?.hr_department || '—';
    } catch (_) { /* non-fatal */ }

    const subject = `New ${cfg.title} Request - ${actor?.name || 'Employee'}`;
    const detailRows = (details || []).map(([k, v]) => rowHtml(k, v)).join('');
    const html = `
      <div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#111;">
        <p>Hello Super Admin,</p>
        <p>A new ${cfg.title.toLowerCase()} request has been submitted.</p>
        <table style="border-collapse:collapse;">
          ${rowHtml('Employee Name:', actor?.name)}
          ${rowHtml('Employee ID:', actor?.id)}
          ${rowHtml('Department:', department)}
          ${detailRows}
          ${rowHtml('Status:', 'L1 Pending')}
          ${rowHtml('Apply Time:', applyTime || '—')}
        </table>
        ${approvalButtons(type, recordId)}
        <p style="color:#6b7280;font-size:12px;margin-top:14px;">
          These buttons open the HR System and require you to be signed in.
          No change is made to any record until you confirm while logged in.
        </p>
        <p>HR System:<br><a href="${APP_URL}">${APP_URL}</a></p>
      </div>`;

    const r = await sendEmail(recipients.join(','), subject, html);
    global.logger?.[r?.success ? 'info' : 'error'](
      `${cfg.title} new-request email → ${recipients.join(', ')}: ${r?.success ? 'sent' : (r?.error || 'failed')}`
    );
  } catch (err) {
    global.logger?.error(`notifyNewRequest(${type}) failed: ${err.message}`);
  }
}

/**
 * Decision → email the employee (Approved / Rejected). Best-effort.
 * In-app notification is emitted by the caller's existing notify path, so this
 * only sends the email (avoids duplicate bell notifications for Leave).
 */
async function emailDecisionToEmployee({ type, employeeId, decision, approverName, remarks, status }) {
  try {
    const cfg = TYPE_CFG[type] || { title: type };
    let emp;
    try { emp = await d365.getById(EMP, employeeId, { select: 'hr_hremployee1,hr_email' }); } catch (_) {}
    if (!emp?.hr_email) {
      global.logger?.warn(`${cfg.title} decision email skipped: employee ${employeeId} has no email`);
      return;
    }
    const decisionLabel = decision === 'approved' ? 'Approved' : 'Rejected';
    const subject = `${cfg.title} ${decisionLabel}`;
    const html = `
      <div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#111;">
        <p>Hello ${emp.hr_hremployee1 || 'Employee'},</p>
        <p>Your ${cfg.title.toLowerCase()} request has been <strong>${decisionLabel.toLowerCase()}</strong>.</p>
        <table style="border-collapse:collapse;">
          ${rowHtml('Employee Name:', emp.hr_hremployee1)}
          ${rowHtml('Approver Name:', approverName)}
          ${rowHtml('Approval Date:', new Date().toISOString().split('T')[0])}
          ${rowHtml('Remarks:', remarks || '—')}
          ${rowHtml('Current Status:', status || decisionLabel)}
        </table>
        <p>HR System:<br><a href="${APP_URL}">${APP_URL}</a></p>
      </div>`;
    const r = await sendEmail(emp.hr_email, subject, html);
    global.logger?.[r?.success ? 'info' : 'error'](
      `${cfg.title} decision email → ${emp.hr_email}: ${r?.success ? 'sent' : (r?.error || 'failed')}`
    );
  } catch (err) {
    global.logger?.error(`emailDecisionToEmployee(${type}) failed: ${err.message}`);
  }
}

module.exports = { notifyNewRequest, emailDecisionToEmployee, getSuperAdmins };
