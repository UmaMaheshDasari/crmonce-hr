/**
 * Email payslip must show the SAME Total Deductions as the PDF/on-screen view.
 *
 * Bug: the email body used payroll.hr_deductions (the "Other Deductions" bucket only)
 * as Total Deductions → showed ₹0 when the real deduction was Professional Tax.
 * Fix: the email body uses computeFigures() — the single source of truth shared by the
 * PDF and the on-screen view. This exercises the REAL emailPayslip (PDF built, email
 * captured via the notification test transport — no network).
 */
process.env.NODE_ENV = 'test';
process.env.AZURE_CLIENT_ID = process.env.AZURE_CLIENT_ID || 'test-client';
process.env.AZURE_CLIENT_SECRET = process.env.AZURE_CLIENT_SECRET || 'test-secret';
process.env.AZURE_TENANT_ID = process.env.AZURE_TENANT_ID || 'test-tenant';

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const notification = require('../src/services/notification.service');
const { emailPayslip } = require('../src/services/payslip-notify.service');
const { computeFigures } = require('../src/services/payslip.service');

const company = { hr_name: 'CRMONCE', hr_email: 'info@crmonce.com', hr_website: 'https://www.crmonce.com', hr_gstin: 'G', hr_cin: 'C', hr_addressline: 'Nellore, India' };
const employee = { hr_hremployee1: 'Test Emp', hr_email: 'emp@crmonce.com', hr_employeeid: 'EMP1' };

let captured;
beforeEach(() => { captured = []; notification.setTransport((req, extra) => { captured.push(extra); }); });
afterEach(() => { notification.resetTransport(); });

test('computeFigures (single source of truth): Total = PT even when Other bucket is 0', () => {
  const f = computeFigures({ hr_basic: 16000, hr_professionaltax: 150, hr_deductions: 0 });
  assert.strictEqual(f.gross, 16000);
  assert.strictEqual(f.deductions, 150);
  assert.strictEqual(f.net, 15850);
});

test('EMAIL payslip shows the REAL Total Deductions (₹150.00, not ₹0)', async () => {
  const payroll = { hr_month: 8, hr_year: 2026, hr_basic: 16000, hr_professionaltax: 150, hr_deductions: 0, hr_netpay: 15850, hr_gross: 16000 };
  const r = await emailPayslip({ payroll, employee, company });
  assert.strictEqual(r.success, true, 'email sent (captured)');
  assert.strictEqual(captured.length, 1);
  const html = captured[0].html;
  assert.match(html, /Total Deductions/);
  assert.match(html, /₹150\.00/, 'Total Deductions shows the real ₹150');
  assert.match(html, /₹15,850\.00/, 'Net Pay 15,850');
  assert.match(html, /₹16,000\.00/, 'Gross 16,000');
  assert.ok(!html.includes('₹0.00'), 'the summary never shows a ₹0.00 deduction');
  // The email carries the SAME PDF the download uses.
  assert.ok(Array.isArray(captured[0].attachments) && captured[0].attachments[0]?.contentType === 'application/pdf', 'PDF attached');
});

test('EMAIL payslip totals PF + PT together', async () => {
  const payroll = { hr_month: 8, hr_year: 2026, hr_basic: 20000, hr_pf: 1000, hr_professionaltax: 200, hr_deductions: 0, hr_netpay: 18800 };
  const r = await emailPayslip({ payroll, employee, company });
  assert.strictEqual(r.success, true);
  const html = captured[0].html;
  assert.match(html, /₹1,200\.00/, 'PF 1000 + PT 200 = 1,200 total deductions');
  assert.match(html, /₹18,800\.00/, 'Net = 20,000 − 1,200');
});
