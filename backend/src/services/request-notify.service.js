/**
 * Shared request notifications for approval workflows (Leave, Late Permission).
 *
 * All HTML comes from the shared template engine (./email/templates) — this file
 * only assembles data and calls sendEmail(). Reuses existing infrastructure:
 *   - Email      → sendEmail()          (notification.service.js — Microsoft Graph)
 *   - Socket.io  → notifyUser           (notification.service.js)
 *   - D365       → d365.service.js
 *   - JWT tokens → approval-token.js
 *   - Templates  → email/templates.js   - Config → email/config.js
 *
 * Every function is best-effort: never throws, never blocks the caller.
 */
const d365 = require('./d365.service');
const { toValue } = require('./picklist');
const { sendEmail, notifyUser } = require('./notification.service');
const { signApprovalToken } = require('./approval-token');
const { resolveSender } = require('./email/sender');
const T = require('./email/templates');
const ecfg = require('./email/config');
const { buildLeaveICS, icsAttachment } = require('./email/ics');

const EMP = d365.constructor.entities.employee;
const LEAVE = d365.constructor.entities.leave;

const TYPE_CFG = {
  leave:           { title: 'Leave' },
  late_permission: { title: 'Late Permission' },
};

// Seed/placeholder addresses that must never receive mail (e.g. admin@yourcompany.com).
const PLACEHOLDER_DOMAINS = ['yourcompany.com', 'yourdomain.com', 'example.com'];
const isPlaceholderEmail = (email) =>
  !email || PLACEHOLDER_DOMAINS.some(d => String(email).toLowerCase().endsWith('@' + d));

/** Active HR Managers + Super Admins — the only valid approvers. */
async function getApprovers() {
  try {
    const { data } = await d365.getList(EMP, {
      filter: `(hr_role eq ${toValue('hr_role', 'super_admin')} or hr_role eq ${toValue('hr_role', 'hr_manager')}) ` +
              `and hr_status eq ${toValue('hr_employee_status', 'active')}`,
      select: 'hr_hremployeeid,hr_hremployee1,hr_email',
      orderby: 'hr_hremployee1 asc',
    });
    return (data || []).filter(a => a.hr_email && !isPlaceholderEmail(a.hr_email));
  } catch (err) {
    global.logger?.error(`getApprovers failed: ${err.message}`);
    return [];
  }
}

/** Signed approve/reject links for the email buttons. */
function approvalUrls(type, id) {
  const mk = (action) => {
    const token = signApprovalToken({ type, id, level: 'hr', action });
    return `${ecfg.brand.appUrl}/approve?type=${type}&id=${encodeURIComponent(id)}&action=${action}&t=${encodeURIComponent(token)}`;
  };
  return { approveUrl: mk('approved'), rejectUrl: mk('rejected') };
}

async function departmentOf(employeeId) {
  try { const e = await d365.getById(EMP, employeeId, { select: 'hr_department' }); return e?.hr_department || '—'; }
  catch (_) { return '—'; }
}

/** Configurable leave balance = annual entitlement − approved days taken this year. */
async function getLeaveBalance(employeeId) {
  try {
    const year = new Date().getFullYear();
    const { data } = await d365.getList(LEAVE, {
      filter: `_hr_hremployee_value eq '${employeeId}' and hr_status eq ${toValue('hr_leave_status', 'approved')}`,
      select: 'hr_days,hr_fromdate',
    });
    const taken = (data || [])
      .filter(l => String(l.hr_fromdate || '').startsWith(String(year)))
      .reduce((s, l) => s + (Number(l.hr_days) || 0), 0);
    const entitlement = ecfg.leave.annualEntitlement;
    return { entitlement, taken, balance: Math.max(0, entitlement - taken) };
  } catch (_) { return null; }
}

/**
 * New request → email the SELECTED approver (buttons) + optional CC (informational).
 * In-app notification goes only to the approver. Call AFTER a successful create.
 */
async function notifyNewRequest({ type, recordId, actor, details, applyTime, approver, cc = [] }) {
  try {
    const cfg = TYPE_CFG[type] || { title: type };
    if (approver?.id) {
      notifyUser(approver.id, 'request:new', { requestType: type, id: recordId, employeeName: actor?.name });
    }
    if (!approver?.email) {
      global.logger?.warn(`${cfg.title} new-request email skipped: selected approver has no email`);
      return;
    }

    // Dynamic sender = the applicant's OWN mailbox. Never fall back to info@ — if
    // the mailbox can't be used, log the exact reason and skip (audited).
    const s = resolveSender({ email: actor?.email, label: 'Employee' });
    if (!s.ok) {
      global.logger?.error(`${cfg.title} request email NOT sent — ${s.reason}`);
      global.logger?.info(`EMAIL_AUDIT ${JSON.stringify({ from: actor?.email || null, to: approver.email, type: `${type}_new_approver`, status: 'skipped', reason: s.reason, at: new Date().toISOString() })}`);
      return;
    }

    const employee = { name: actor?.name, id: actor?.id, department: await departmentOf(actor.id), email: actor?.email };
    const { approveUrl, rejectUrl } = approvalUrls(type, recordId);

    // ONE email — FROM employee, TO approver, CC = ONLY the explicitly selected
    // users (real CC line). No automatic CC of info@/HR@/umamahesh@.
    const ccEmails = (cc || []).filter(c => c?.email && !isPlaceholderEmail(c.email)).map(c => c.email);
    const a = T.newRequestApprover({
      moduleTitle: cfg.title, employee, rows: details, applyTime, approverName: approver.name, approveUrl, rejectUrl,
    });
    const ra = await sendEmail(approver.email, a.subject, a.html, {
      from: s.sender, cc: ccEmails, meta: { type: `${type}_new_approver` },
    });
    global.logger?.[ra?.success ? 'info' : 'error'](
      `${cfg.title} request email FROM ${s.sender} → ${approver.email} (cc: ${ccEmails.join(', ') || 'none'}): ${ra?.success ? 'sent' : (ra?.error || 'failed')}`);
  } catch (err) {
    global.logger?.error(`notifyNewRequest(${type}) failed: ${err.message}`);
  }
}

/** Acknowledgement → email the employee immediately after submission. */
async function emailApplyAcknowledgement({ type, toEmail, employeeName, approverName }) {
  try {
    if (!toEmail) { global.logger?.warn(`${type} acknowledgement skipped: no employee email`); return; }
    const cfg = TYPE_CFG[type] || { title: type };
    const { subject, html } = T.acknowledgement({ moduleTitle: cfg.title, employeeName, approverName });
    const r = await sendEmail(toEmail, subject, html, { meta: { type: `${type}_ack` } });
    global.logger?.[r?.success ? 'info' : 'error'](`${cfg.title} acknowledgement → ${toEmail}: ${r?.success ? 'sent' : (r?.error || 'failed')}`);
  } catch (err) {
    global.logger?.error(`emailApplyAcknowledgement(${type}) failed: ${err.message}`);
  }
}

/**
 * Decision → email the employee (Approved/Rejected) with balance + .ics for
 * approved leave. FROM = the approver's OWN mailbox (HR@ / umamahesh@). CC =
 * original CC recipients (real CC line). `approver` = { name, email }.
 */
async function emailDecisionToEmployee({ type, employeeId, decision, approver, approverName, remarks, status, fromDate, toDate, leaveType, cc = [] }) {
  try {
    const cfg = TYPE_CFG[type] || { title: type };
    let emp;
    try { emp = await d365.getById(EMP, employeeId, { select: 'hr_hremployee1,hr_email' }); } catch (_) {}
    if (!emp?.hr_email) { global.logger?.warn(`${cfg.title} decision email skipped: employee ${employeeId} has no email`); return; }

    const aName = approver?.name || approverName;
    // Sender = approver's own mailbox. If it can't be used, log the exact reason
    // (the employee is still informed via the system mailbox — never silent).
    const fromOpt = {};
    if (approver?.email) {
      const s = resolveSender({ email: approver.email, label: 'Approver' });
      if (s.ok) fromOpt.from = s.sender;
      else global.logger?.error(`${cfg.title} decision — approver mailbox unusable (${s.reason}); sending from system mailbox`);
    }

    const balance = type === 'leave' ? await getLeaveBalance(employeeId) : null;
    const { subject, html } = T.decision({
      moduleTitle: cfg.title,
      employeeName: emp.hr_hremployee1,
      approverName: aName,
      date: new Date().toISOString().split('T')[0],
      remarks: remarks || '—',
      decision,
      balance,
    });

    const attachments = [];
    if (decision === 'approved' && type === 'leave' && fromDate && toDate) {
      const ics = buildLeaveICS({
        uid: `leave-${employeeId}-${fromDate}`, employeeName: emp.hr_hremployee1,
        leaveType: leaveType || 'Leave', from: fromDate, to: toDate,
      });
      attachments.push(icsAttachment(ics, 'leave.ics'));
    }

    const ccEmails = (cc || []).filter(c => c?.email && !isPlaceholderEmail(c.email)).map(c => c.email);
    const r = await sendEmail(emp.hr_email, subject, html, { ...fromOpt, cc: ccEmails, attachments, meta: { type: `${type}_decision` } });
    global.logger?.[r?.success ? 'info' : 'error'](
      `${cfg.title} decision email FROM ${fromOpt.from || '(system)'} → ${emp.hr_email} (cc: ${ccEmails.join(', ') || 'none'}): ${r?.success ? 'sent' : (r?.error || 'failed')}`);
  } catch (err) {
    global.logger?.error(`emailDecisionToEmployee(${type}) failed: ${err.message}`);
  }
}

/** Optional FYI to CC recipients after a decision (only when configured). */
async function emailDecisionFyiToCc({ type, ccRecipients, decision, employeeName, approverName }) {
  try {
    if (!Array.isArray(ccRecipients) || ccRecipients.length === 0) return;
    const cfg = TYPE_CFG[type] || { title: type };
    for (const c of ccRecipients) {
      if (!c?.email || isPlaceholderEmail(c.email)) continue;
      const { subject, html } = T.decisionCcFyi({ moduleTitle: cfg.title, recipientName: c.name, employeeName, approverName, decision });
      const r = await sendEmail(c.email, subject, html, { meta: { type: `${type}_decision_cc` } });
      global.logger?.[r?.success ? 'info' : 'error'](`${cfg.title} CC FYI (decision) → ${c.email}: ${r?.success ? 'sent' : (r?.error || 'failed')}`);
    }
  } catch (err) {
    global.logger?.error(`emailDecisionFyiToCc(${type}) failed: ${err.message}`);
  }
}

module.exports = {
  notifyNewRequest, emailApplyAcknowledgement, emailDecisionToEmployee,
  emailDecisionFyiToCc, getApprovers, isPlaceholderEmail, getLeaveBalance, approvalUrls,
};
