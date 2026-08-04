/**
 * Emails the payslip PDF to the employee after payroll approval.
 * Subject: "Salary Slip - <Month Year>". Best-effort, never throws — a failed
 * email never blocks/rolls back the approval.
 */
const { sendEmail, GRAPH_SENDER } = require('./notification.service');
const { buildPayslipPdf, monthYear } = require('./payslip.service');
const { inTenant } = require('./email/sender');
const companySvc = require('./company.service');
const T = require('./email/templates');

const inr = (v) => '₹' + (Number(v) || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/**
 * @param {object} p { payroll, employee, company? }
 * @returns {Promise<{success:boolean, sentAt:string|null, error?:string}>}
 */
async function emailPayslip({ payroll, employee, company }) {
  try {
    company = company || await companySvc.getCompany();
    const to = employee?.hr_email;
    if (!to) { global.logger?.warn(`[payslip] email skipped — employee has no mailbox`); return { success: false, sentAt: null, error: 'no recipient' }; }

    const my = monthYear(payroll);
    const subject = `Salary Slip - ${my}`;
    // Sender = the company mailbox when it's a tenant address, else info@crmonce.com.
    const from = company.hr_email && inTenant(company.hr_email) ? company.hr_email : GRAPH_SENDER;

    const gross = payroll.hr_gross != null ? payroll.hr_gross : (payroll.hr_basic || 0) + (payroll.hr_allowances || 0);
    const content =
      `<p style="margin:0 0 12px;font-size:15px;color:#111827;">Dear ${T._esc(employee.hr_hremployee1 || 'Employee')},</p>` +
      `<p style="margin:0 0 4px;color:#374151;">Your salary slip for <strong>${T._esc(my)}</strong> is attached (PDF).</p>` +
      T.summaryCard('Salary Summary', [
        ['Gross Salary', T._esc(inr(gross))],
        ['Total Deductions', T._esc(inr(payroll.hr_deductions || 0))],
        ['Net Pay', `<strong>${T._esc(inr(payroll.hr_netpay || 0))}</strong>`],
      ]) +
      T.banner('This payslip is confidential. Please contact HR for any discrepancy.');
    const html = T.layout({ title: subject, preheader: `Salary slip for ${my}`, content });

    const pdf = await buildPayslipPdf({ payroll, employee, company });
    const safeName = String(employee.hr_hremployee1 || 'Employee').replace(/\s+/g, '_');
    const r = await sendEmail(to, subject, html, {
      from,
      attachments: [{ name: `Payslip_${safeName}_${my.replace(/\s+/g, '_')}.pdf`, contentType: 'application/pdf', contentBytes: pdf.toString('base64') }],
      meta: { type: 'payslip' },
    });
    global.logger?.[r?.success ? 'info' : 'error'](`[payslip] email FROM ${from} → ${to} (${my}): ${r?.success ? 'sent' : (r?.error || 'failed')}`);
    return { success: !!r?.success, sentAt: r?.success ? new Date().toISOString() : null, error: r?.error };
  } catch (err) {
    global.logger?.error(`emailPayslip failed: ${err.message}`);
    return { success: false, sentAt: null, error: err.message };
  }
}

module.exports = { emailPayslip };
