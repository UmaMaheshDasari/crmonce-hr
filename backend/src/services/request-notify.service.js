/**
 * Shared request notifications for approval workflows (Leave, Late Permission).
 *
 * Reuses existing infrastructure only:
 *   - Email      → sendEmail()          (notification.service.js — Microsoft Graph)
 *   - Socket.io  → broadcast/notifyUser (notification.service.js)
 *   - D365       → d365.service.js
 *   - JWT tokens → approval-token.js
 *
 * No new email provider, no duplicated notification logic.
 * Every function is best-effort: it never throws and never blocks the caller.
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

const wrap = (inner) =>
  `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#111;">${inner}` +
  `<p>HR System:<br><a href="${APP_URL}">${APP_URL}</a></p></div>`;

const greeting = (name) => `<p>Dear ${name || 'Approver'},</p>`;

// Seed/placeholder addresses that must never receive mail (e.g. admin@yourcompany.com).
const PLACEHOLDER_DOMAINS = ['yourcompany.com', 'yourdomain.com', 'example.com'];
const isPlaceholderEmail = (email) =>
  !email || PLACEHOLDER_DOMAINS.some(d => String(email).toLowerCase().endsWith('@' + d));

/** Active HR Managers + Super Admins — the only valid approvers (from the Employees table). */
async function getApprovers() {
  try {
    const { data } = await d365.getList(EMP, {
      filter: `(hr_role eq ${toValue('hr_role', 'super_admin')} or hr_role eq ${toValue('hr_role', 'hr_manager')}) ` +
              `and hr_status eq ${toValue('hr_employee_status', 'active')}`,
      select: 'hr_hremployeeid,hr_hremployee1,hr_email',
      orderby: 'hr_hremployee1 asc',
    });
    // Skip records with no email or placeholder/seed addresses.
    return (data || []).filter(a => a.hr_email && !isPlaceholderEmail(a.hr_email));
  } catch (err) {
    global.logger?.error(`getApprovers failed: ${err.message}`);
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
 * New request → email the SELECTED approver (with Approve/Reject buttons) and,
 * optionally, CC recipients (informational, NO buttons). In-app notification
 * goes only to the selected approver. Call AFTER a successful D365 create.
 *   approver : { id, name, email }        (required — TO)
 *   cc       : [{ id, name, email }]       (optional — informational)
 */
async function notifyNewRequest({ type, recordId, actor, details, applyTime, approver, cc = [] }) {
  try {
    const cfg = TYPE_CFG[type] || { title: type };

    // In-app: notify ONLY the selected approver.
    if (approver?.id) {
      notifyUser(approver.id, 'request:new', { requestType: type, id: recordId, employeeName: actor?.name });
    }

    if (!approver?.email) {
      global.logger?.warn(`${cfg.title} new-request email skipped: selected approver has no email`);
      return;
    }

    // Department is not in the JWT — fetch it (best-effort).
    let department = '—';
    try {
      const emp = await d365.getById(EMP, actor.id, { select: 'hr_department' });
      department = emp?.hr_department || '—';
    } catch (_) { /* non-fatal */ }

    const subject = `${cfg.title} Request - ${actor?.name || 'Employee'}`;
    // Reply-To = the employee, so approver/CC can reply straight to them.
    const replyTo = actor?.email ? { name: actor.name, email: actor.email } : undefined;
    const detailRows = (details || []).map(([k, v]) => rowHtml(k, v)).join('');
    const infoTable = `
      <table style="border-collapse:collapse;">
        ${rowHtml('Employee Name:', actor?.name)}
        ${rowHtml('Employee ID:', actor?.id)}
        ${rowHtml('Department:', department)}
        ${detailRows}
        ${rowHtml('Current Status:', 'L1 Pending')}
        ${rowHtml('Apply Time:', applyTime || '—')}
      </table>`;

    // ── Approver email (TO) — with action buttons ──
    const approverHtml = wrap(`
      ${greeting(approver.name)}
      <p>A new ${cfg.title.toLowerCase()} request has been submitted for your approval.</p>
      ${infoTable}
      ${approvalButtons(type, recordId)}
      <p style="color:#6b7280;font-size:12px;margin-top:14px;">
        These buttons open the HR System and require you to be signed in.
        No change is made until you confirm while logged in.
      </p>`);
    const ra = await sendEmail(approver.email, subject, approverHtml, { replyTo });
    global.logger?.[ra?.success ? 'info' : 'error'](
      `${cfg.title} approver email → ${approver.email}: ${ra?.success ? 'sent' : (ra?.error || 'failed')}`
    );

    // ── CC recipients — informational only, NO buttons ──
    for (const c of (cc || [])) {
      if (!c?.email) continue;
      const ccHtml = wrap(`
        ${greeting(c.name)}
        <p>A new ${cfg.title.toLowerCase()} request has been submitted.</p>
        ${infoTable}
        <hr style="border:none;border-top:1px solid #e5e7eb;margin:16px 0;">
        <p style="color:#6b7280;">
          This email is for your information only.<br>
          No action is required from your side.<br>
          Awaiting approval from: <strong>${approver.name || 'the approver'}</strong>.
        </p>`);
      const rc = await sendEmail(c.email, subject, ccHtml, { replyTo });
      global.logger?.[rc?.success ? 'info' : 'error'](
        `${cfg.title} CC email → ${c.email}: ${rc?.success ? 'sent' : (rc?.error || 'failed')}`
      );
    }
  } catch (err) {
    global.logger?.error(`notifyNewRequest(${type}) failed: ${err.message}`);
  }
}

/**
 * Acknowledgement → email the employee immediately after submission. Best-effort.
 */
async function emailApplyAcknowledgement({ type, toEmail, employeeName, approverName }) {
  try {
    if (!toEmail) {
      global.logger?.warn(`${type} acknowledgement skipped: employee has no email`);
      return;
    }
    const cfg = TYPE_CFG[type] || { title: type };
    const subject = `${cfg.title} Request Submitted`;
    const html = wrap(`
      ${greeting(employeeName)}
      <p>Your ${cfg.title.toLowerCase()} request has been submitted successfully.</p>
      <table style="border-collapse:collapse;">
        ${rowHtml('Approver:', approverName)}
        ${rowHtml('Current Status:', 'L1 Pending')}
      </table>`);
    const r = await sendEmail(toEmail, subject, html);
    global.logger?.[r?.success ? 'info' : 'error'](
      `${cfg.title} acknowledgement → ${toEmail}: ${r?.success ? 'sent' : (r?.error || 'failed')}`
    );
  } catch (err) {
    global.logger?.error(`emailApplyAcknowledgement(${type}) failed: ${err.message}`);
  }
}

/**
 * Decision → email the employee (Approved / Rejected). Best-effort.
 * In-app notification is emitted by the caller's existing notify path.
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
    const html = wrap(`
      ${greeting(emp.hr_hremployee1)}
      <p>Your ${cfg.title.toLowerCase()} request has been <strong>${decisionLabel.toLowerCase()}</strong>.</p>
      <table style="border-collapse:collapse;">
        ${rowHtml('Employee Name:', emp.hr_hremployee1)}
        ${rowHtml('Approver Name:', approverName)}
        ${rowHtml('Approval Date:', new Date().toISOString().split('T')[0])}
        ${rowHtml('Remarks:', remarks || '—')}
        ${rowHtml('Current Status:', status || decisionLabel)}
      </table>`);
    const r = await sendEmail(emp.hr_email, subject, html);
    global.logger?.[r?.success ? 'info' : 'error'](
      `${cfg.title} decision email → ${emp.hr_email}: ${r?.success ? 'sent' : (r?.error || 'failed')}`
    );
  } catch (err) {
    global.logger?.error(`emailDecisionToEmployee(${type}) failed: ${err.message}`);
  }
}

/**
 * Optional FYI to CC recipients after a decision (only when configured).
 * Informational only — no buttons. Best-effort.
 */
async function emailDecisionFyiToCc({ type, ccRecipients, decision, employeeName, approverName }) {
  try {
    if (!Array.isArray(ccRecipients) || ccRecipients.length === 0) return;
    const cfg = TYPE_CFG[type] || { title: type };
    const decisionLabel = decision === 'approved' ? 'Approved' : 'Rejected';
    const subject = `${cfg.title} ${decisionLabel} - ${employeeName || 'Employee'}`;
    for (const c of ccRecipients) {
      if (!c?.email || isPlaceholderEmail(c.email)) continue;
      const html = wrap(`
        ${greeting(c.name)}
        <p>The ${cfg.title.toLowerCase()} request from <strong>${employeeName || 'an employee'}</strong> has been
        <strong>${decisionLabel.toLowerCase()}</strong> by ${approverName || 'the approver'}.</p>
        <p style="color:#6b7280;">This email is for your information only. No action is required from your side.</p>`);
      const r = await sendEmail(c.email, subject, html);
      global.logger?.[r?.success ? 'info' : 'error'](
        `${cfg.title} CC FYI (decision) → ${c.email}: ${r?.success ? 'sent' : (r?.error || 'failed')}`
      );
    }
  } catch (err) {
    global.logger?.error(`emailDecisionFyiToCc(${type}) failed: ${err.message}`);
  }
}

module.exports = {
  notifyNewRequest, emailApplyAcknowledgement, emailDecisionToEmployee,
  emailDecisionFyiToCc, getApprovers, isPlaceholderEmail,
};
