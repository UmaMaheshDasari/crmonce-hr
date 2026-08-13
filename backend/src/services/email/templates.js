/**
 * Shared email template ENGINE for the HR module.
 *
 * Every HR email is generated here from small, reusable components (header,
 * profile card, summary card, status badge, button, banner, footer) composed
 * into a responsive, dark-mode-aware, WCAG-minded layout. No duplicate HTML:
 * notifiers call the builder functions (bottom) and never write markup.
 *
 * Pure functions — no I/O, no secrets — so they are trivially unit-testable.
 */
const cfg = require('./config');

// ── helpers ──────────────────────────────────────────────────────────────
const esc = (v) => String(v ?? '—')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

// Long free text (e.g. Leave Reason): HTML-escaped (XSS-safe), with paragraphs,
// line breaks and multiple spaces PRESERVED via white-space:pre-wrap. Never truncated.
const longText = (v) =>
  `<div style="white-space:pre-wrap;word-break:break-word;line-height:1.6;color:#111827;font-size:14px;">${esc(v)}</div>`;

const STATUS_COLORS = {
  approved:  { bg: '#ecfdf5', fg: '#065f46', dot: '#10b981' },
  rejected:  { bg: '#fef2f2', fg: '#991b1b', dot: '#ef4444' },
  pending:   { bg: '#fffbeb', fg: '#92400e', dot: '#f59e0b' },
  cancelled: { bg: '#f3f4f6', fg: '#374151', dot: '#9ca3af' },
  default:   { bg: '#eef2ff', fg: '#3730a3', dot: '#6366f1' },
};
const statusKey = (s) => {
  const k = String(s || '').toLowerCase();
  if (k.includes('approv')) return 'approved';
  if (k.includes('reject')) return 'rejected';
  if (k.includes('pending')) return 'pending';
  if (k.includes('cancel')) return 'cancelled';
  return 'default';
};

// ── components ───────────────────────────────────────────────────────────
function statusBadge(status) {
  const c = STATUS_COLORS[statusKey(status)];
  return `<span role="status" style="display:inline-block;padding:4px 12px;border-radius:999px;` +
    `background:${c.bg};color:${c.fg};font-size:12px;font-weight:700;letter-spacing:.02em;">` +
    `<span aria-hidden="true" style="display:inline-block;width:8px;height:8px;border-radius:50%;` +
    `background:${c.dot};margin-right:6px;"></span>${esc(status)}</span>`;
}

function button(label, url, variant = 'primary') {
  const bg = variant === 'reject' ? '#dc2626' : variant === 'approve' ? '#059669' : cfg.brand.primary;
  return `<a href="${esc(url)}" role="button" aria-label="${esc(label)}" ` +
    `style="display:inline-block;padding:13px 30px;margin:0 6px;border-radius:10px;background:${bg};` +
    `color:#ffffff;text-decoration:none;font-weight:700;font-size:15px;">${esc(label)}</a>`;
}

function header() {
  const b = cfg.brand;
  return `
  <tr><td style="padding:0;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:linear-gradient(135deg,${b.navy} 0%,#0E2F44 100%);border-radius:16px 16px 0 0;">
      <tr><td style="padding:26px 32px;">
        <table role="presentation" cellpadding="0" cellspacing="0"><tr>
          <td style="vertical-align:middle;">
            <span style="display:inline-block;width:40px;height:40px;border-radius:11px;background:linear-gradient(135deg,${b.primary},${b.primaryDark});text-align:center;line-height:40px;color:#fff;font-weight:800;font-size:18px;">C</span>
          </td>
          <td style="vertical-align:middle;padding-left:12px;">
            <div style="color:#ffffff;font-size:18px;font-weight:800;letter-spacing:.02em;">${esc(b.name)}</div>
            <div style="color:#9db3c4;font-size:11px;text-transform:uppercase;letter-spacing:.12em;">${esc(b.tagline)}</div>
          </td>
        </tr></table>
      </td></tr>
    </table>
  </td></tr>`;
}

function footer() {
  const b = cfg.brand;
  return `
  <tr><td style="padding:22px 32px;border-top:1px solid #eef0f3;">
    <p style="margin:0;color:#8a94a6;font-size:12px;line-height:1.6;">
      ${esc(b.name)} · ${esc(b.tagline)}<br>
      <a href="${esc(b.appUrl)}" style="color:${b.primary};text-decoration:none;">${esc(b.appUrl)}</a>
      · Need help? <a href="mailto:${esc(b.supportEmail)}" style="color:${b.primary};text-decoration:none;">${esc(b.supportEmail)}</a>
    </p>
    <p style="margin:8px 0 0;color:#b3bac6;font-size:11px;">This is an automated message from ${esc(b.name)} HR.</p>
  </td></tr>`;
}

/** Employee profile card (avatar initials + identity). */
function profileCard({ name, id, department, email } = {}) {
  const initials = String(name || 'E').split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase();
  return card(`
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
      <td style="width:52px;vertical-align:middle;">
        <span style="display:inline-block;width:52px;height:52px;border-radius:50%;background:linear-gradient(135deg,${cfg.brand.primary},${cfg.brand.primaryDark});text-align:center;line-height:52px;color:#fff;font-weight:800;font-size:18px;">${esc(initials)}</span>
      </td>
      <td style="vertical-align:middle;padding-left:14px;">
        <div style="font-size:16px;font-weight:700;color:#111827;">${esc(name)}</div>
        <div style="font-size:13px;color:#6b7280;">${esc(department || 'Employee')}${email ? ' · ' + esc(email) : ''}</div>
        <div style="font-size:11px;color:#9ca3af;">ID: ${esc(id)}</div>
      </td>
    </tr></table>`);
}

/** Summary card: an accessible key/value grid. rows = [[label,value], ...] */
function summaryCard(title, rows) {
  const body = rows.map(([k, v]) =>
    `<tr>
      <th scope="row" style="text-align:left;padding:7px 16px 7px 0;color:#6b7280;font-size:13px;font-weight:600;white-space:nowrap;vertical-align:top;">${esc(k)}</th>
      <td style="padding:7px 0;color:#111827;font-size:14px;">${v}</td>
    </tr>`).join('');
  return card(
    (title ? `<div style="font-size:13px;font-weight:700;color:#374151;text-transform:uppercase;letter-spacing:.06em;margin-bottom:10px;">${esc(title)}</div>` : '') +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0">${body}</table>`
  );
}

function banner(text, tone = 'info') {
  const c = tone === 'warn' ? { bg: '#fffbeb', fg: '#92400e', bd: '#fde68a' }
        : tone === 'success' ? { bg: '#ecfdf5', fg: '#065f46', bd: '#a7f3d0' }
        : { bg: '#eff6ff', fg: '#1e40af', bd: '#bfdbfe' };
  return `<div role="note" style="margin:18px 0;padding:14px 16px;border:1px solid ${c.bd};background:${c.bg};color:${c.fg};border-radius:12px;font-size:13px;line-height:1.6;">${text}</div>`;
}

function card(inner) {
  return `<div style="margin:14px 0;padding:18px 20px;border:1px solid #eef0f3;border-radius:14px;background:#ffffff;">${inner}</div>`;
}

/** Base responsive + dark-mode + accessible layout. `preheader` is hidden inbox text. */
function layout({ title, preheader = '', content }) {
  return `<!-- ${esc(title)} -->
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${esc(preheader)}</div>
<style>
  @media (prefers-color-scheme: dark) {
    .hr-body { background:#0b1220 !important; }
    .hr-card, .hr-shell { background:#111827 !important; border-color:#1f2937 !important; }
    .hr-shell td, .hr-shell th, .hr-shell div, .hr-shell p { color:#e5e7eb !important; }
  }
  @media only screen and (max-width:620px) {
    .hr-shell { width:100% !important; border-radius:0 !important; }
    .hr-btn { display:block !important; margin:8px 0 !important; text-align:center; }
  }
  a { color:${cfg.brand.primary}; }
</style>
<table role="presentation" class="hr-body" width="100%" cellpadding="0" cellspacing="0" style="background:#f3f4f6;padding:24px 0;font-family:'Segoe UI',Arial,Helvetica,sans-serif;">
  <tr><td align="center">
    <table role="presentation" class="hr-shell" width="600" cellpadding="0" cellspacing="0" style="width:600px;max-width:600px;background:#ffffff;border-radius:16px;overflow:hidden;border:1px solid #eef0f3;">
      ${header()}
      <tr><td style="padding:26px 32px;">${content}</td></tr>
      ${footer()}
    </table>
  </td></tr>
</table>`;
}

// ── builders (return { subject, html }) — the only public surface ─────────
const greet = (name) => `<p style="margin:0 0 12px;font-size:15px;color:#111827;">Dear ${esc(name || 'Approver')},</p>`;

/** Rows shared by request emails (approver + CC). `rows` = type-specific [label,value]. */
function requestRows(d) {
  // Reason (and any long free-text field) keeps its full formatting; everything
  // else is a single escaped value.
  const base = (d.rows || []).map(([k, v]) => [k, /reason|comment|remark|note/i.test(k) ? longText(v) : esc(v)]);
  base.push(['Current Status', statusBadge(d.status || 'L1 Pending')]);
  base.push(['Apply Time', esc(d.applyTime)]);
  return base;
}

function newRequestApprover(d) {
  const subject = `${d.moduleTitle} Request - ${d.employee.name}`;
  const content =
    greet(d.approverName) +
    `<p style="margin:0 0 4px;color:#374151;">A new ${d.moduleTitle.toLowerCase()} request needs your approval.</p>` +
    profileCard(d.employee) +
    summaryCard('Request details', requestRows(d)) +
    `<div style="text-align:center;margin:22px 0 6px;">
       <span class="hr-btn">${button('Approve', d.approveUrl, 'approve')}</span>
       <span class="hr-btn">${button('Reject', d.rejectUrl, 'reject')}</span>
     </div>` +
    banner('The buttons open the HR System and require you to be signed in. No change is made until you confirm while logged in.');
  return { subject, html: layout({ title: subject, preheader: `Approve or reject ${d.employee.name}'s ${d.moduleTitle.toLowerCase()} request`, content }) };
}

// Informational copy for CC recipients WITHOUT approval access — NO approve/reject
// buttons, NO action links or tokens. Subject is explicitly prefixed "For Your
// Information:" so the recipient sees at a glance that no action is expected of them.
function newRequestCc(d) {
  const subject = `For Your Information: ${d.moduleTitle} Request - ${d.employee.name}`;
  const content =
    greet(d.recipientName) +
    `<p style="margin:0 0 4px;color:#374151;">This ${d.moduleTitle.toLowerCase()} request has been submitted for approval by <strong>${esc(d.employee.name)}</strong>. You are receiving this notification for information only.</p>` +
    profileCard(d.employee) +
    summaryCard('Request details', requestRows(d)) +
    banner(`This email is for your information only. No action is required from you.<br>Awaiting approval from <strong>${esc(d.approverName || 'the approver')}</strong>.`);
  return { subject, html: layout({ title: subject, preheader: 'For your information only', content }) };
}

function acknowledgement(d) {
  const subject = `${d.moduleTitle} Request Submitted`;
  const content =
    greet(d.employeeName) +
    `<p style="margin:0 0 4px;color:#374151;">Your ${d.moduleTitle.toLowerCase()} request has been submitted successfully.</p>` +
    summaryCard('Submission', [
      ['Approver', esc(d.approverName)],
      ['Current Status', statusBadge('L1 Pending')],
    ]);
  return { subject, html: layout({ title: subject, preheader: 'We have received your request', content }) };
}

function decision(d) {
  const label = d.decision === 'approved' ? 'Approved' : 'Rejected';
  const subject = `${d.moduleTitle} ${label}`;
  const rows = [
    ['Employee Name', esc(d.employeeName)],
    ['Approver Name', esc(d.approverName)],
    ['Approval Date', esc(d.date)],
    ['Remarks', esc(d.remarks)],
    ['Current Status', statusBadge(label)],
  ];
  if (d.balance) {
    rows.push(['Leave Balance', `${esc(d.balance.balance)} / ${esc(d.balance.entitlement)} days remaining (${esc(d.balance.taken)} taken)`]);
  }
  const content =
    greet(d.employeeName) +
    `<p style="margin:0 0 4px;color:#374151;">Your ${d.moduleTitle.toLowerCase()} request has been <strong>${label.toLowerCase()}</strong>.</p>` +
    summaryCard('Decision', rows) +
    (d.decision === 'approved' ? banner('An Outlook calendar invite is attached for your approved leave.', 'success') : '');
  return { subject, html: layout({ title: subject, preheader: `Your request was ${label.toLowerCase()}`, content }) };
}

function reminder(d) {
  const subject = `Reminder: ${d.moduleTitle} Request awaiting your approval - ${d.employee.name}`;
  const content =
    greet(d.approverName) +
    banner(`This ${d.moduleTitle.toLowerCase()} request has been pending your approval for over ${esc(d.hours)} hours.`, 'warn') +
    profileCard(d.employee) +
    summaryCard('Request details', requestRows(d)) +
    `<div style="text-align:center;margin:22px 0 6px;">
       <span class="hr-btn">${button('Approve', d.approveUrl, 'approve')}</span>
       <span class="hr-btn">${button('Reject', d.rejectUrl, 'reject')}</span>
     </div>`;
  return { subject, html: layout({ title: subject, preheader: 'Action still required', content }) };
}

/**
 * Attendance Exception notification (auto-detected missing punch). Doubles as the
 * reminder + escalation email via the `reminder` / `escalation` flags.
 * d: { employeeName, date, issueLabel, punches:[…], raiseUrl, reminder, escalation, ccNote }
 */
function attendanceException(d) {
  const punchList = (d.punches && d.punches.length) ? d.punches.map(p => esc(p)).join(' &nbsp;·&nbsp; ') : '—';
  const lead = d.escalation
    ? `This attendance exception has been open and no correction request has been submitted. It is now being escalated.`
    : d.reminder
      ? `This is a reminder — our attendance system detected an incomplete attendance record that still needs your action.`
      : `Our attendance system detected an incomplete attendance record that needs your action.`;
  const content =
    greet(d.employeeName) +
    `<p style="margin:0 0 6px;font-size:14px;color:#374151;line-height:1.6;">${esc(lead)}</p>` +
    summaryCard('Attendance Exception', [
      ['Attendance Date', esc(d.date)],
      ['Issue', statusBadge(d.issueLabel)],
      ['Recorded Punches', punchList],
    ]) +
    banner('Please submit an Attendance Correction Request so HR can review and update your attendance.', d.escalation ? 'warn' : 'info') +
    (d.ccNote ? `<p style="margin:0 0 6px;font-size:12px;color:#6b7280;">${esc(d.ccNote)}</p>` : '') +
    `<div style="text-align:center;margin:22px 0 6px;">${button('Raise Attendance Correction', d.raiseUrl)}</div>`;
  const subject = d.escalation
    ? 'Attendance Correction Pending – Escalation'
    : 'Action Required – Attendance Correction Needed';
  return { subject, html: layout({ title: subject, preheader: `${d.issueLabel} on ${d.date} — action needed`, content }) };
}

/**
 * Missing Punch informational email — ONE per employee/day (§7). Sent to the
 * EMPLOYEE ONLY (no HR/manager CC by default). Employee acts by raising a
 * correction; the ledger guarantees this is not re-sent on recalc/refresh.
 * d: { employeeName, date, shift, inTime, outTime, raiseUrl }
 */
function missingPunch(d) {
  const subject = `Missing Punch - ${d.date}`;
  const content =
    greet(d.employeeName) +
    `<p style="margin:0 0 6px;font-size:14px;color:#374151;line-height:1.6;">Your attendance for <strong>${esc(d.date)}</strong> appears to have a missing punch. Please check your attendance and submit an attendance correction if required.</p>` +
    summaryCard('Attendance', [
      ['Date', esc(d.date)],
      ['Shift', esc(d.shift || '—')],
      ['In Time', esc(d.inTime || '—')],
      ['Out Time', esc(d.outTime || '—')],
      ['Attendance Status', statusBadge('Missing Punch')],
    ]) +
    (d.raiseUrl ? `<div style="text-align:center;margin:22px 0 6px;">${button('Raise Attendance Correction', d.raiseUrl)}</div>` : '') +
    banner('If your attendance is correct, no action is needed. Otherwise please submit an Attendance Correction so HR can update it.');
  return { subject, html: layout({ title: subject, preheader: `Missing punch on ${d.date} — please review`, content }) };
}

/**
 * Late Login informational email — ONE per employee/day (§9). Employee only.
 * Purely informational (attendance stays Present); the ledger prevents repeats on
 * recalc / dashboard / payroll.
 * d: { employeeName, date, shift, expectedTime, actualTime }
 */
function lateLoginNotice(d) {
  const subject = `Late Login Notification - ${d.date}`;
  const mins = (n) => `${Number(n)} minute${Number(n) === 1 ? '' : 's'}`;
  const lateByTxt = (d.lateBy != null && Number(d.lateBy) > 0) ? mins(d.lateBy) : '—';
  const graceTxt = (d.grace != null && Number(d.grace) > 0) ? mins(d.grace) : '5 minutes';
  const content =
    greet(d.employeeName) +
    `<p style="margin:0 0 6px;font-size:14px;color:#374151;line-height:1.6;">Our attendance system recorded a <strong>Late Entry</strong> for <strong>${esc(d.date)}</strong>. This is for your information only — it does not affect your salary, attendance, or leave, and no action is required.</p>` +
    summaryCard('Attendance', [
      ['Employee', esc(d.employeeName || '—')],
      ['Date', esc(d.date)],
      ['Scheduled Start', esc(d.expectedTime || '—')],
      ['Grace Period', esc(graceTxt)],
      ['Actual Check-In', esc(d.actualTime || '—')],
      ['Late By', esc(lateByTxt)],
      ['Attendance Status', statusBadge('Late Entry')],
    ]) +
    banner('If this looks incorrect, please raise an Attendance Correction or a Late Login request in the HR Portal.');
  return { subject, html: layout({ title: subject, preheader: `Late entry on ${d.date}`, content }) };
}

/**
 * Late Login INFORMATION email to HR (manual Late Login Request — NOT the automatic
 * Late Entry notice above, and NOT an approval). No Approve/Reject, no link, no token.
 * d: { employeeName, employeeId, department, date, expectedTime, actualTime, lateBy, reason, remarks }
 */
function lateLoginInfo(d) {
  const subject = `Late Login Information - ${d.employeeName} - ${d.date}`;
  const lateByTxt = (() => {
    const n = Number(d.lateBy);
    if (!Number.isFinite(n) || n <= 0) return '—';
    const h = Math.floor(n / 60), m = n % 60;
    return [h ? `${h} hour${h === 1 ? '' : 's'}` : '', m ? `${m} minute${m === 1 ? '' : 's'}` : ''].filter(Boolean).join(' ') || '0 minutes';
  })();
  const content =
    `<p style="margin:0 0 12px;font-size:15px;color:#111827;">Dear HR,</p>` +
    `<p style="margin:0 0 4px;color:#374151;"><strong>${esc(d.employeeName)}</strong> has submitted a Late Login entry.</p>` +
    summaryCard('Late Login Details', [
      ['Employee', esc(d.employeeName)],
      ['Employee ID', esc(d.employeeId)],
      ['Department', esc(d.department || '—')],
      ['Date', esc(d.date)],
      ['Shift Start Time', esc(d.expectedTime || '—')],
      ['Late Login Time', esc(d.actualTime || '—')],
      ['Late By', esc(lateByTxt)],
      ['Reason', longText(d.reason || '—')],
      ['Remarks', longText(d.remarks || '—')],
    ]) +
    banner('This is an informational notification only. No approval is required.');
  return { subject, html: layout({ title: subject, preheader: `Late Login information — ${d.employeeName}`, content }) };
}

/**
 * "Leave Request Required" email to the EMPLOYEE — sent by the daily verification job
 * when a Late Login date arrives with NO recorded check-in. Informational + guidance
 * (no buttons/approval). d: { employeeName, date }
 */
function lateLoginLeaveRequired(d) {
  const subject = `Leave Request Required - ${d.date}`;
  const content =
    greet(d.employeeName) +
    `<p style="margin:0 0 8px;font-size:14px;color:#374151;line-height:1.6;">You submitted a Late Login request for <strong>${esc(d.date)}</strong>. Our attendance system shows that <strong>no Check-In was recorded</strong> for you on this date.</p>` +
    `<p style="margin:0 0 8px;font-size:14px;color:#374151;line-height:1.6;">If you were absent on this day, please submit a <strong>Leave Request</strong> in the HR System to regularize your attendance.</p>` +
    banner('Please apply for Leave to regularize your attendance for this date.', 'warn');
  return { subject, html: layout({ title: subject, preheader: `No check-in recorded on ${d.date} — please apply for Leave`, content }) };
}

/**
 * New performance goal assigned → email to the employee.
 * d: { employeeName, goalTitle, description, quarter, financialYear, priority,
 *      weightage, dueDate, assignedBy, assignedOn, viewUrl }
 */
function goalAssigned(d) {
  const subject = 'New Performance Goal Assigned';
  const rows = [
    ['Employee', esc(d.employeeName)],
    ['Goal Title', `<strong>${esc(d.goalTitle)}</strong>`],
    ['Description', longText(d.description || '—')],
    ['Quarter', esc(d.quarter)],
    ['Financial Year', esc(d.financialYear)],
    ['Priority', statusBadge(d.priority)],
    ['Weightage', `${esc(d.weightage)}%`],
    ['Due Date', esc(d.dueDate || '—')],
    ['Assigned By', esc(d.assignedBy)],
    ['Assigned On', esc(d.assignedOn)],
  ];
  const content =
    `<p style="margin:0 0 12px;font-size:15px;color:#111827;">Hello ${esc(d.employeeName)},</p>` +
    `<p style="margin:0 0 4px;color:#374151;">A new performance goal has been assigned to you.</p>` +
    summaryCard('Goal Details', rows) +
    banner('Please log in to the HR Portal to review and update your progress.') +
    `<div style="text-align:center;margin:22px 0 6px;">${button('View Goal', d.viewUrl)}</div>`;
  return { subject, html: layout({ title: subject, preheader: `New goal assigned: ${d.goalTitle}`, content }) };
}

module.exports = {
  // components (exported for tests/reuse)
  statusBadge, button, profileCard, summaryCard, banner, layout,
  // builders
  newRequestApprover, newRequestCc, acknowledgement, decision, reminder, attendanceException,
  missingPunch, lateLoginNotice, lateLoginInfo, lateLoginLeaveRequired, goalAssigned,
  _esc: esc, _longText: longText,
};
