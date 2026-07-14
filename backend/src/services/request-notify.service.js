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
const { sendEmail, notifyUser, verifyMailbox } = require('./notification.service');
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

/** Log + audit that an email was intentionally NOT sent — the workflow NEVER
 *  falls back to another mailbox. Returns undefined so callers can `return` it. */
function auditSkip(type, metaType, from, to, reason) {
  const title = (TYPE_CFG[type] || { title: type }).title;
  global.logger?.error(`${title} email NOT sent — ${reason}`);
  global.logger?.info(`EMAIL_AUDIT ${JSON.stringify({ from: from || null, to: to || null, type: metaType, status: 'skipped', reason, at: new Date().toISOString() })}`);
}

/** Active HR Managers + Super Admins — the only valid approvers. */
async function getApprovers() {
  try {
    const { data } = await d365.getList(EMP, {
      filter: `(hr_role eq ${toValue('hr_role', 'super_admin')} or hr_role eq ${toValue('hr_role', 'hr_manager')}) ` +
              `and hr_status eq ${toValue('hr_employee_status', 'active')}`,
      select: 'hr_hremployeeid,hr_hremployee1,hr_email,hr_department',
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
    if (!s.ok) return auditSkip(type, `${type}_new_approver`, actor?.email, approver.email, s.reason);
    const v = await verifyMailbox(s.sender);
    if (!v.ok) return auditSkip(type, `${type}_new_approver`, s.sender, approver.email, v.reason);

    const employee = { name: actor?.name, id: actor?.id, department: await departmentOf(actor.id), email: actor?.email };
    const { approveUrl, rejectUrl } = approvalUrls(type, recordId);

    // 1) Approver email — TO the approver ONLY (with Approve/Reject buttons).
    //    The applicant is the SENDER, never a recipient, and saveToSentItems is
    //    false so NO copy of this buttoned email reaches the applicant's mailbox.
    const a = T.newRequestApprover({
      moduleTitle: cfg.title, employee, rows: details, applyTime, approverName: approver.name, approveUrl, rejectUrl,
    });
    const ra = await sendEmail(approver.email, a.subject, a.html, {
      from: s.sender, saveToSentItems: false, meta: { type: `${type}_new_approver` },
    });
    global.logger?.[ra?.success ? 'info' : 'error'](
      `${cfg.title} approver email FROM ${s.sender} → ${approver.email}: ${ra?.success ? 'sent' : (ra?.error || 'failed')}`);

    // 2) CC recipients — a SEPARATE informational email with NO action buttons.
    //    Each selected user (never the applicant/approver) gets an FYI copy.
    const ccList = (cc || []).filter(c =>
      c?.email && !isPlaceholderEmail(c.email) &&
      c.email.toLowerCase() !== actor?.email?.toLowerCase() &&
      c.email.toLowerCase() !== approver.email.toLowerCase());
    for (const c of ccList) {
      const cm = T.newRequestCc({
        moduleTitle: cfg.title, employee, rows: details, applyTime, recipientName: c.name, approverName: approver.name,
      });
      const rc = await sendEmail(c.email, cm.subject, cm.html, {
        from: s.sender, saveToSentItems: false, meta: { type: `${type}_new_cc` },
      });
      global.logger?.[rc?.success ? 'info' : 'error'](
        `${cfg.title} CC (info) email FROM ${s.sender} → ${c.email}: ${rc?.success ? 'sent' : (rc?.error || 'failed')}`);
    }
  } catch (err) {
    global.logger?.error(`notifyNewRequest(${type}) failed: ${err.message}`);
  }
}

/** Acknowledgement → email the employee immediately after submission, FROM their
 *  own company mailbox (never info@). Skipped with a reason if unusable. */
async function emailApplyAcknowledgement({ type, toEmail, employeeName, approverName }) {
  try {
    const cfg = TYPE_CFG[type] || { title: type };
    const s = resolveSender({ email: toEmail, label: 'Employee' });
    if (!s.ok) return auditSkip(type, `${type}_ack`, toEmail, toEmail, s.reason);
    const v = await verifyMailbox(s.sender);
    if (!v.ok) return auditSkip(type, `${type}_ack`, s.sender, toEmail, v.reason);

    const { subject, html } = T.acknowledgement({ moduleTitle: cfg.title, employeeName, approverName });
    // saveToSentItems=false → the applicant gets exactly ONE copy (inbox), not a
    // second copy in Sent. This is the ONLY email the employee should receive.
    const r = await sendEmail(toEmail, subject, html, { from: s.sender, saveToSentItems: false, meta: { type: `${type}_ack` } });
    global.logger?.[r?.success ? 'info' : 'error'](`${cfg.title} acknowledgement FROM ${s.sender} → ${toEmail}: ${r?.success ? 'sent' : (r?.error || 'failed')}`);
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
    // Sender = the approver's OWN mailbox. No fallback: if it can't be used, the
    // decision email is NOT sent (skipped + audited). The employee is still
    // notified in-app by the caller (notifyLeaveApproval).
    const s = resolveSender({ email: approver?.email, label: 'Approver' });
    if (!s.ok) return auditSkip(type, `${type}_decision`, approver?.email, emp.hr_email, s.reason);
    const mb = await verifyMailbox(s.sender);
    if (!mb.ok) return auditSkip(type, `${type}_decision`, s.sender, emp.hr_email, mb.reason);

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
    const r = await sendEmail(emp.hr_email, subject, html, { from: s.sender, cc: ccEmails, attachments, meta: { type: `${type}_decision` } });
    global.logger?.[r?.success ? 'info' : 'error'](
      `${cfg.title} decision email FROM ${s.sender} → ${emp.hr_email} (cc: ${ccEmails.join(', ') || 'none'}): ${r?.success ? 'sent' : (r?.error || 'failed')}`);
  } catch (err) {
    global.logger?.error(`emailDecisionToEmployee(${type}) failed: ${err.message}`);
  }
}

module.exports = {
  notifyNewRequest, emailApplyAcknowledgement, emailDecisionToEmployee,
  getApprovers, isPlaceholderEmail, getLeaveBalance, approvalUrls,
};
