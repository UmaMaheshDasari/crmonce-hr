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
const time = require('./time.util');
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
  late_login:      { title: 'Late Login' },
  late_permission: { title: 'Late Permission' },
  missing_punch:   { title: 'Missing Punch' },
};

// Seed/placeholder addresses that must never receive mail (e.g. admin@yourcompany.com).
const PLACEHOLDER_DOMAINS = ['yourcompany.com', 'yourdomain.com', 'example.com'];
const isPlaceholderEmail = (email) =>
  !email || PLACEHOLDER_DOMAINS.some(d => String(email).toLowerCase().endsWith('@' + d));

// Roles with authorized approval access (reuses the existing role system — NOT a new
// one). These are the same roles getApprovers() returns and that guard the approval
// routes. A CC recipient with one of these roles gets an ACTIONABLE email; anyone else
// gets information-only. Being CC'd alone NEVER grants approval rights.
const AUTHORIZED_APPROVAL_ROLES = ['super_admin', 'hr_manager'];
const isAuthorizedApprovalRole = (role) => AUTHORIZED_APPROVAL_ROLES.includes(String(role || '').toLowerCase());

/**
 * The ONE approval-authorization rule, shared by the email button-rendering and the
 * approval API guard: a user may act on a request iff they are an authorized HR/Admin
 * approver OR they are the explicitly selected approver. CC membership grants nothing.
 */
function canActOnApproval({ role, userId, approverId }) {
  if (isAuthorizedApprovalRole(role)) return true;                       // authorized HR/Admin/Super Admin
  if (approverId && userId && String(approverId) === String(userId)) return true;  // explicitly selected approver
  return false;
}

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

// The HUMAN Employee ID shown in emails (e.g. EMP1039) — NEVER the Dataverse record
// GUID (hr_hremployeeid). Uses the same source-of-truth + fallbacks the app uses
// everywhere: hr_employeeid → hr_employeecode → hr_etimecode.
const employeeIdOf = (e) => String(e?.hr_employeeid || e?.hr_employeecode || e?.hr_etimecode || '');

/** Employee-card fields for request emails: department + the human Employee ID. */
async function employeeCardInfo(employeeGuid) {
  try {
    const e = await d365.getByIdOptional(EMP, employeeGuid, { select: 'hr_department', optionalSelect: 'hr_employeeid,hr_employeecode,hr_etimecode' });
    return { department: e?.hr_department || '—', employeeId: employeeIdOf(e) };
  } catch (_) { return { department: '—', employeeId: '' }; }
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
async function notifyNewRequest({ type, recordId, actor, details, applyTime, approver, cc = [], status }) {
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

    // Employee card shows the HUMAN Employee ID (EMP1039), never the GUID actor.id.
    const cardInfo = await employeeCardInfo(actor.id);
    const employee = { name: actor?.name, id: cardInfo.employeeId || '—', department: cardInfo.department, email: actor?.email };
    // Apply Time shown as DD-MM-YYYY hh:mm AM/PM (global format), never a raw ISO string.
    const applyTimeFmt = time.fmtDateTime(applyTime);
    const { approveUrl, rejectUrl } = approvalUrls(type, recordId);

    // 1) Approver email — TO the approver ONLY (with Approve/Reject buttons).
    //    The applicant is the SENDER, never a recipient, and saveToSentItems is
    //    false so NO copy of this buttoned email reaches the applicant's mailbox.
    const a = T.newRequestApprover({
      moduleTitle: cfg.title, employee, rows: details, applyTime: applyTimeFmt, approverName: approver.name, approveUrl, rejectUrl, status,
    });
    const ra = await sendEmail(approver.email, a.subject, a.html, {
      from: s.sender, saveToSentItems: false, meta: { type: `${type}_new_approver` },
    });
    global.logger?.[ra?.success ? 'info' : 'error'](
      `${cfg.title} approver email FROM ${s.sender} → ${approver.email}: ${ra?.success ? 'sent' : (ra?.error || 'failed')}`);

    // 2) CC recipients — RECIPIENT-SPECIFIC content (never one identical email):
    //      • CC WITH an authorized HR/Admin approval role → actionable email WITH
    //        Approve/Reject buttons (they can genuinely approve — the API allows it).
    //      • CC WITHOUT approval access → information-only, NO buttons, NO token/URL.
    //    The applicant and the selected approver are never re-CC'd.
    const ccList = (cc || []).filter(c =>
      c?.email && !isPlaceholderEmail(c.email) &&
      c.email.toLowerCase() !== actor?.email?.toLowerCase() &&
      c.email.toLowerCase() !== approver.email.toLowerCase());
    for (const c of ccList) {
      if (isAuthorizedApprovalRole(c.role)) {
        // Same signed Approve/Reject links as the approver — the backend still validates
        // the logged-in user's role/approver identity before any write (defence in depth).
        const am = T.newRequestApprover({
          moduleTitle: cfg.title, employee, rows: details, applyTime: applyTimeFmt, approverName: c.name, approveUrl, rejectUrl, status,
        });
        const rc = await sendEmail(c.email, am.subject, am.html, {
          from: s.sender, saveToSentItems: false, meta: { type: `${type}_new_cc_approver` },
        });
        global.logger?.[rc?.success ? 'info' : 'error'](
          `${cfg.title} CC (actionable, ${c.role}) email FROM ${s.sender} → ${c.email}: ${rc?.success ? 'sent' : (rc?.error || 'failed')}`);
      } else {
        const cm = T.newRequestCc({
          moduleTitle: cfg.title, employee, rows: details, applyTime: applyTimeFmt, recipientName: c.name, approverName: approver.name, status,
        });
        const rc = await sendEmail(c.email, cm.subject, cm.html, {
          from: s.sender, saveToSentItems: false, meta: { type: `${type}_new_cc` },
        });
        global.logger?.[rc?.success ? 'info' : 'error'](
          `${cfg.title} CC (info) email FROM ${s.sender} → ${c.email}: ${rc?.success ? 'sent' : (rc?.error || 'failed')}`);
      }
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
 * Decision → email the EMPLOYEE ONLY (Approved/Rejected), with balance + .ics for
 * approved leave. FROM = the approver's OWN mailbox (HR@ / umamahesh@).
 *
 * The reporting manager and HR are NEVER emailed or CC'd on a decision — they were
 * already notified when the request was submitted. The `cc` argument is accepted
 * for backward compatibility but is intentionally IGNORED. `approver` = {name,email}.
 */
async function emailDecisionToEmployee({ type, employeeId, decision, approver, approverName, remarks, status, fromDate, toDate, leaveType, cc = [] }) {   // eslint-disable-line no-unused-vars
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

    // Employee ONLY — never CC HR or the reporting manager on a decision.
    const r = await sendEmail(emp.hr_email, subject, html, { from: s.sender, attachments, meta: { type: `${type}_decision` } });
    global.logger?.[r?.success ? 'info' : 'error'](
      `${cfg.title} decision email FROM ${s.sender} → ${emp.hr_email} (employee only): ${r?.success ? 'sent' : (r?.error || 'failed')}`);
  } catch (err) {
    global.logger?.error(`emailDecisionToEmployee(${type}) failed: ${err.message}`);
  }
}

module.exports = {
  notifyNewRequest, emailApplyAcknowledgement, emailDecisionToEmployee,
  getApprovers, isPlaceholderEmail, getLeaveBalance, approvalUrls,
  isAuthorizedApprovalRole, canActOnApproval, AUTHORIZED_APPROVAL_ROLES,
  employeeIdOf, employeeCardInfo,
};
