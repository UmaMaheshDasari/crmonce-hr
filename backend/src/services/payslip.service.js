/**
 * Payslip PDF generator (pdfkit) — builds a professional A4 payslip into a Buffer
 * so BOTH the download route and the approval email reuse the exact same document.
 * Layout mirrors the company's standard payslip: logo + company identity header,
 * "Payslip for the month of <Month Year>", a bordered two-column employee grid,
 * an Earnings (Full/Actual) + Deductions table, totals, Net Pay in words, footer.
 * All company identity comes from Company Settings (never hardcoded).
 */
const fs = require('fs');
const PDFDocument = require('pdfkit');
const companySvc = require('./company.service');

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const monthYear = (p) => `${MONTHS[(p.hr_month || 1) - 1] || ''} ${p.hr_year || ''}`.trim();
const intfmt = (v) => (Math.round(Number(v) || 0)).toLocaleString('en-IN');
const dfmt = (d) => { const s = String(d || '').slice(0, 10); if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return d || ''; const [y, m, dd] = s.split('-'); return `${dd} ${MONTHS[+m - 1]?.slice(0, 3)} ${y}`; };

// Integer → Indian-English words (rupees).
function numberToWords(num) {
  num = Math.round(Number(num) || 0);
  if (num === 0) return 'Zero';
  const a = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
  const b = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];
  const two = (n) => (n < 20 ? a[n] : b[Math.floor(n / 10)] + (n % 10 ? ' ' + a[n % 10] : ''));
  const three = (n) => (n >= 100 ? a[Math.floor(n / 100)] + ' Hundred' + (n % 100 ? ' ' : '') : '') + (n % 100 ? two(n % 100) : '');
  let w = '';
  const cr = Math.floor(num / 10000000); num %= 10000000;
  const la = Math.floor(num / 100000); num %= 100000;
  const th = Math.floor(num / 1000); num %= 1000;
  if (cr) w += two(cr) + ' Crore ';
  if (la) w += two(la) + ' Lakh ';
  if (th) w += two(th) + ' Thousand ';
  if (num) w += three(num);
  return w.trim();
}

/**
 * @param {object} p { payroll, employee, company? }
 * @returns {Promise<Buffer>}
 */
async function buildPayslipPdf({ payroll, employee, company }) {
  company = company || await companySvc.getCompany();
  const doc = new PDFDocument({ size: 'A4', margin: 30 });
  const chunks = [];
  doc.on('data', (c) => chunks.push(c));
  const done = new Promise((resolve) => doc.on('end', () => resolve(Buffer.concat(chunks))));

  const X0 = 30, X1 = 565, W = X1 - X0;            // content region
  const my = monthYear(payroll);
  const emp = employee || {};

  // Derived salary figures.
  const basic = Number(payroll.hr_basic) || 0;
  const allow = Number(payroll.hr_allowances) || 0;
  const overtime = Number(payroll.hr_overtime) || 0;
  const wd = payroll.hr_workingdays != null ? Number(payroll.hr_workingdays) : 0;
  const pd = payroll.hr_paydays != null ? Number(payroll.hr_paydays) : wd;
  const ratio = wd > 0 ? pd / wd : 1;
  const actualBasic = Math.round(basic * ratio);
  const actualAllow = Math.round(allow * ratio);
  const totalFull = basic + allow;
  const totalActual = payroll.hr_gross != null ? Number(payroll.hr_gross) : actualBasic + actualAllow + overtime;
  const deductions = Number(payroll.hr_deductions) || 0;
  const net = payroll.hr_netpay != null ? Number(payroll.hr_netpay) : totalActual - deductions;
  const lopDays = Math.max(0, wd - pd);

  // Print date (top-left, small).
  const now = new Date();
  const stamp = `Print Date: ${dfmt(now.toISOString())}, ${now.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}`;
  doc.font('Helvetica').fontSize(7.5).fillColor('#333').text(stamp, X0, 18);

  // ── Header box: logo + company identity + payslip title ──
  let y = 34;
  const headerH = 66;
  doc.rect(X0, y, W, headerH).lineWidth(0.8).strokeColor('#000').stroke();
  try { if (companySvc.LOGO_FILE && fs.existsSync(companySvc.LOGO_FILE)) doc.image(companySvc.LOGO_FILE, X0 + 8, y + 10, { fit: [70, 46] }); } catch { /* logo optional */ }
  doc.fillColor('#000').font('Helvetica-Bold').fontSize(14).text(company.hr_name || 'Company', X0, y + 10, { width: W, align: 'center' });
  const addr = companySvc.addressLines(company).join(' ');
  doc.font('Helvetica').fontSize(7.5).text(addr, X0, y + 28, { width: W, align: 'center' });
  doc.font('Helvetica-Bold').fontSize(11).text(`Payslip for the month of ${my}`, X0, y + 44, { width: W, align: 'center' });
  y += headerH;

  // ── Employee grid: 2 columns × rows (label/value each side) ──
  // Employee ID is the independent Employee Code (EMP0001) — NEVER the GUID.
  const empNo = emp.hr_employeecode || emp.hr_etimecode || (emp.hr_hremployeeid || '').slice(0, 8) || '';
  const managerName = emp['_hr_manager_value@OData.Community.Display.V1.FormattedValue'] || '';
  const left = [
    ['Name:', emp.hr_hremployee1 || ''],
    ['Joining Date:', dfmt(emp.hr_joiningdate)],
    ['Designation:', emp.hr_designation || ''],
    ['Department:', emp.hr_department || ''],
    ['Location:', company.hr_city || ''],
    ['Effective Work Days:', wd || ''],
    ['LOP:', lopDays],
  ];
  const right = [
    ['Employee ID:', empNo],
    ['Reporting Manager:', managerName],
    ['Bank Name:', emp.hr_bankname || ''],
    ['Bank Account No:', emp.hr_accountnumber || ''],
    ['PAN Number:', emp.hr_pan || ''],
    ['PF No:', emp.hr_pfnumber || ''],
    ['PF UAN:', emp.hr_uan || ''],
  ];
  const rowH = 15;
  const gridH = rowH * left.length;
  const midX = X0 + W / 2;
  doc.rect(X0, y, W, gridH).strokeColor('#000').lineWidth(0.8).stroke();
  doc.moveTo(midX, y).lineTo(midX, y + gridH).stroke();
  doc.fontSize(8.5);
  const cell = (label, value, x, ry, half) => {
    doc.font('Helvetica').fillColor('#000').text(label, x + 4, ry + 4, { width: 100 });
    doc.font('Helvetica').fillColor('#000').text(String(value ?? ''), x + 108, ry + 4, { width: half - 112 });
  };
  for (let i = 0; i < left.length; i++) {
    const ry = y + i * rowH;
    cell(left[i][0], left[i][1], X0, ry, W / 2);
    if (right[i][0]) cell(right[i][0], right[i][1], midX, ry, W / 2);
  }
  y += gridH;

  // ── Earnings / Deductions table ──
  // Columns: Earnings label | Full | Actual | Deductions label | Actual
  const cEarn = X0, cFull = X0 + 210, cAct = X0 + 280, cDed = X0 + 350, cDedAct = X1;
  const th = 16;
  doc.rect(X0, y, W, th).fillAndStroke('#f0f0f0', '#000');
  doc.fillColor('#000').font('Helvetica-Bold').fontSize(8.5);
  doc.text('Earnings', cEarn + 4, y + 4, { width: 200 });
  doc.text('Full', cFull, y + 4, { width: 66, align: 'right' });
  doc.text('Actual', cAct, y + 4, { width: 66, align: 'right' });
  doc.text('Deductions', cDed + 4, y + 4, { width: 150 });
  doc.text('Actual', cDedAct - 70, y + 4, { width: 66, align: 'right' });
  // vertical dividers
  const earnRows = [
    ['BASIC', basic, actualBasic],
    ['ALLOWANCES', allow, actualAllow],
  ];
  if (overtime) earnRows.push(['OVERTIME', overtime, overtime]);
  const dedRows = [['PF / ESI / TAX & OTHER', deductions]];
  const bodyRows = Math.max(earnRows.length, dedRows.length, 3);
  const bodyH = bodyRows * rowH;
  const tableTop = y;
  y += th;
  doc.font('Helvetica').fontSize(8.5).fillColor('#000');
  for (let i = 0; i < bodyRows; i++) {
    const ry = y + i * rowH;
    if (earnRows[i]) {
      doc.text(earnRows[i][0], cEarn + 4, ry + 3, { width: 200 });
      doc.text(intfmt(earnRows[i][1]), cFull, ry + 3, { width: 66, align: 'right' });
      doc.text(intfmt(earnRows[i][2]), cAct, ry + 3, { width: 66, align: 'right' });
    }
    if (dedRows[i]) {
      doc.text(dedRows[i][0], cDed + 4, ry + 3, { width: 150 });
      doc.text(intfmt(dedRows[i][1]), cDedAct - 70, ry + 3, { width: 66, align: 'right' });
    }
  }
  y += bodyH;
  // Totals row
  doc.rect(X0, y, W, th).fillAndStroke('#f7f7f7', '#000');
  doc.font('Helvetica-Bold').fillColor('#000').fontSize(8.5);
  doc.text('Total Earnings: INR.', cEarn + 4, y + 4, { width: 200 });
  doc.text(intfmt(totalFull), cFull, y + 4, { width: 66, align: 'right' });
  doc.text(intfmt(totalActual), cAct, y + 4, { width: 66, align: 'right' });
  doc.text('Total Deductions: INR.', cDed + 4, y + 4, { width: 150 });
  doc.text(intfmt(deductions), cDedAct - 70, y + 4, { width: 66, align: 'right' });
  const bottom = y + th;

  // Table outer border + column dividers spanning header→totals.
  doc.rect(X0, tableTop, W, bottom - tableTop).strokeColor('#000').lineWidth(0.8).stroke();
  for (const vx of [cFull, cAct, cDed]) doc.moveTo(vx, tableTop).lineTo(vx, bottom).stroke();
  y = bottom;

  // ── Net Pay + amount in words ──
  const netH = 20;
  doc.rect(X0, y, W, netH).strokeColor('#000').lineWidth(0.8).stroke();
  doc.font('Helvetica-Bold').fontSize(9.5).fillColor('#000')
    .text('Net Pay for the month ( Total Earnings - Total Deductions ):', X0 + 4, y + 5, { width: 380 });
  doc.text(intfmt(net), X1 - 120, y + 5, { width: 116, align: 'right' });
  y += netH;
  doc.rect(X0, y, W, 18).strokeColor('#000').lineWidth(0.8).stroke();
  doc.font('Helvetica-Oblique').fontSize(9).text(`(Rupees ${numberToWords(net)} Only)`, X0 + 4, y + 5, { width: W - 8 });
  y += 18 + 14;

  // ── Footer ──
  doc.font('Helvetica').fontSize(8).fillColor('#333')
    .text('This is a system generated payslip and does not require signature.', X0, y, { width: W, align: 'center' });
  doc.text('Generated by CRMONCE HRMS', X0, y + 12, { width: W, align: 'center' });

  doc.end();
  return done;
}

module.exports = { buildPayslipPdf, monthYear, numberToWords, MONTHS };
