/**
 * Advance Salary notifications — in-app (Socket.io bell) + Activity feed +
 * best-effort email. Never throws: a notification failure must never fail or roll
 * back the advance request/decision.
 */
const d365 = require('./d365.service');
const { sendEmail, notifyUser, GRAPH_SENDER } = require('./notification.service');
const { resolveSender, isPlaceholder } = require('./email/sender');
const activity = require('./activity.service');
const T = require('./email/templates');
const requestNotify = require('./request-notify.service');

const EMP = d365.constructor.entities.employee;
const inr = (n) => '₹' + (Number(n) || 0).toLocaleString('en-IN');

async function emailTo(email, subject, title, contentHtml, from) {
  if (!email || isPlaceholder(email)) return { success: false };
  return sendEmail(email, subject, T.layout({ title, preheader: title, content: contentHtml }), { from: from || GRAPH_SENDER, meta: { type: 'advance' } }).catch(() => ({ success: false }));
}

/** Employee applied → notify HR approvers (in-app + email) + activity. */
async function notifyRequested({ advance, applicant }) {
  try {
    const amount = inr(advance.amount);
    activity.record({ category: 'Payroll', type: 'advance_requested', title: 'Advance Requested', name: applicant?.name, meta: `${applicant?.name || 'An employee'} requested an advance of ${amount}` });

    let approvers = [];
    try { approvers = await requestNotify.getApprovers(); } catch {}
    const content =
      `<p style="margin:0 0 12px;font-size:15px;color:#111827;">A new advance salary request needs your approval.</p>` +
      T.banner(`${applicant?.name || 'Employee'} requested ${amount}. Reason: ${T._esc(advance.reason || '—')}`);
    for (const ap of approvers) {
      try { notifyUser(ap.hr_hremployeeid, 'advance:requested', { id: advance.id, amount: advance.amount, employeeName: applicant?.name }); } catch {}
      emailTo(ap.hr_email, `Advance Salary Request — ${applicant?.name || 'Employee'} (${amount})`, 'Advance Salary Request', content);
    }
  } catch (e) { global.logger?.error?.(`notifyRequested failed: ${e.message}`); }
}

/** HR decided → notify the employee (in-app + email) + activity. */
async function notifyDecision({ advance, decision, approver }) {
  try {
    const amount = inr(advance.amount);
    const approved = decision === 'approved';
    activity.record({ category: 'Payroll', type: `advance_${decision}`, title: `Advance ${approved ? 'Approved' : 'Rejected'}`, name: approver?.name, meta: `${approver?.name || 'HR'} ${decision} an advance of ${amount} for ${advance.employeeName || 'an employee'}` });

    notifyUser(advance.employeeId, `advance:${decision}`, { id: advance.id, amount: advance.amount, emi: advance.emi, status: decision });

    let emp;
    try { emp = await d365.getById(EMP, advance.employeeId, { select: 'hr_hremployee1,hr_email' }); } catch {}
    if (emp?.hr_email && !isPlaceholder(emp.hr_email)) {
      const content = approved
        ? `<p style="margin:0 0 12px;font-size:15px;color:#111827;">Your advance salary request has been <strong>approved</strong>.</p>` +
          T.banner(`Amount ${amount}. Monthly EMI ${inr(advance.emi || advance.amount)}, recovered from your payroll starting ${advance.recoverFrom || 'the next payroll'}.`, 'success')
        : `<p style="margin:0 0 12px;font-size:15px;color:#111827;">Your advance salary request of ${amount} has been <strong>rejected</strong>.</p>` +
          T.banner(advance.remarks ? `Reason: ${T._esc(advance.remarks)}` : 'Please contact HR for details.', 'warn');
      let from = GRAPH_SENDER;
      const s = resolveSender({ email: approver?.email, label: 'Approver' });
      if (s.ok) from = s.sender;
      await emailTo(emp.hr_email, `Advance Salary ${approved ? 'Approved' : 'Rejected'} — ${amount}`, `Advance Salary ${approved ? 'Approved' : 'Rejected'}`, content, from);
    }
  } catch (e) { global.logger?.error?.(`notifyDecision failed: ${e.message}`); }
}

module.exports = { notifyRequested, notifyDecision };
