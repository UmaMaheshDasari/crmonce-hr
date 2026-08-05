/**
 * Enterprise payslip PDF (pdfkit) — A4 portrait, professional blue/white theme with
 * rounded cards and sectioned layout (Zoho/Keka/GreytHR style). Returns a Buffer so
 * the download route and the approval email reuse the identical document.
 *
 * ALL company identity (name, logo, GSTIN, CIN, address, email, phone, website) is
 * read from Company Settings — nothing is hardcoded in the PDF.
 */
const fs = require('fs');
const PDFDocument = require('pdfkit');
const companySvc = require('./company.service');

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const pad2 = (n) => String(n).padStart(2, '0');
const monthYear = (p) => `${MONTHS[(p.hr_month || 1) - 1] || ''} ${p.hr_year || ''}`.trim();
const money = (v) => 'Rs. ' + (Number(v) || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const dash = (v) => (v === 0 || v ? String(v) : '—');
const maskAadhaar = (a) => { const s = String(a || '').replace(/\D/g, ''); return s.length === 12 ? `XXXX XXXX ${s.slice(8)}` : (a || '—'); };
const maskAccount = (a) => { const s = String(a || ''); return s.length > 4 ? `XXXX${s.slice(-4)}` : (a || '—'); };
const dfmt = (d) => { const s = String(d || '').slice(0, 10); if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return d || '—'; const [y, m, dd] = s.split('-'); return `${dd}-${MONTHS[+m - 1]?.slice(0, 3)}-${y}`; };

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

// ── palette ──
const C = { primary: '#1e40af', dark: '#0f172a', gray: '#64748b', border: '#e2e8f0', head: '#e8eefc', light: '#f8fafc', pos: '#047857', neg: '#b91c1c' };

async function buildPayslipPdf({ payroll, employee, company }) {
  company = company || await companySvc.getCompany();
  const doc = new PDFDocument({ size: 'A4', margin: 28 });
  const chunks = [];
  doc.on('data', (c) => chunks.push(c));
  const done = new Promise((resolve) => doc.on('end', () => resolve(Buffer.concat(chunks))));

  const X0 = 28, X1 = 567, W = X1 - X0;
  const emp = employee || {};
  const p = payroll || {};
  const my = monthYear(p);
  const empNo = emp.hr_employeeid || emp.hr_employeecode || emp.hr_etimecode || '—';
  const manager = emp['_hr_manager_value@OData.Community.Display.V1.FormattedValue'] || '—';
  const payrollNo = `PS/${p.hr_year || ''}-${pad2(p.hr_month || 0)}/${empNo}`;
  const now = new Date();

  // ── figures ──
  const basic = Number(p.hr_basic) || 0;
  const allowances = Number(p.hr_allowances) || 0;
  const overtime = Number(p.hr_overtime) || 0;
  const gross = p.hr_gross != null ? Number(p.hr_gross) : basic + allowances + overtime;
  const deductions = Number(p.hr_deductions) || 0;
  const net = p.hr_netpay != null ? Number(p.hr_netpay) : gross - deductions;
  const wd = p.hr_workingdays, pd = p.hr_paydays;
  const lopDays = (wd != null && pd != null) ? Math.max(0, wd - pd) : (p.hr_lop ? '—' : 0);

  // Earnings / deductions component lists. We store Basic + a combined Allowances +
  // Overtime; statutory items (HRA/PF/ESI/PT/IT) aren't itemised in the model, so
  // the combined amounts land in the "Other" rows and the rest show 0.00 — keeping
  // the totals exact while presenting the standard enterprise component layout.
  const earnings = [
    ['Basic Salary', basic],
    ['House Rent Allowance', 0],
    ['Special Allowance', 0],
    ['Medical Allowance', 0],
    ['Conveyance', 0],
    ['Other Allowances', allowances],
    ['Overtime', overtime],
  ];
  const deductionRows = [
    ['Provident Fund (PF)', 0],
    ['ESI', 0],
    ['Professional Tax', 0],
    ['Income Tax (TDS)', 0],
    ['LOP Deduction', 0],
    ['Other Deductions', deductions],
  ];

  // ── helpers ──
  const card = (x, y, w, h) => doc.roundedRect(x, y, w, h, 6).lineWidth(0.8).strokeColor(C.border).stroke();
  const sectionBar = (x, y, w, title) => {
    doc.roundedRect(x, y, w, 19, 3).fill(C.head);
    doc.fillColor(C.primary).font('Helvetica-Bold').fontSize(9).text(title.toUpperCase(), x + 9, y + 5.5, { characterSpacing: 0.4 });
    return y + 19;
  };
  const kv = (x, y, w, label, value) => {
    doc.font('Helvetica').fontSize(8).fillColor(C.gray).text(label, x + 9, y, { width: w * 0.42 });
    doc.font('Helvetica-Bold').fontSize(8.5).fillColor(C.dark).text(String(value ?? '—'), x + 9 + w * 0.42, y, { width: w * 0.58 - 12 });
  };

  // ── outer frame ──
  doc.roundedRect(X0, 28, W, 786, 8).lineWidth(1).strokeColor(C.primary).stroke();

  // ── header ──
  let y = 40;
  try { if (companySvc.LOGO_FILE && fs.existsSync(companySvc.LOGO_FILE)) doc.image(companySvc.LOGO_FILE, X0 + 12, y + 2, { fit: [62, 62] }); } catch { /* logo optional */ }
  const cx = X0 + 84, cw = W - 84 - 8;
  doc.fillColor(C.primary).font('Helvetica-Bold').fontSize(16).text(company.hr_name || 'Company', cx, y, { width: cw, align: 'center' });
  doc.font('Helvetica-Bold').fontSize(8.5).fillColor(C.dark)
    .text(`GSTIN: ${company.hr_gstin || '—'}     |     CIN: ${company.hr_cin || '—'}`, cx, y + 21, { width: cw, align: 'center' });
  doc.font('Helvetica').fontSize(7.5).fillColor(C.gray)
    .text(companySvc.addressLines(company).join(', '), cx, y + 33, { width: cw, align: 'center' });
  const contact = [company.hr_email && `Email: ${company.hr_email}`, company.hr_phone && `Phone: ${company.hr_phone}`, company.hr_website && company.hr_website].filter(Boolean).join('     |     ');
  doc.fillColor(C.gray).fontSize(7.5).text(contact, cx, y + 45, { width: cw, align: 'center' });
  y += 74;

  // ── payslip band ──
  doc.roundedRect(X0, y, W, 26, 4).fill(C.primary);
  doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(11).text(`PAY SLIP  ·  ${my}`, X0 + 12, y + 7.5);
  doc.font('Helvetica').fontSize(7.5).fillColor('#dbeafe')
    .text(`Payroll No: ${payrollNo}`, X1 - 250, y + 5, { width: 238, align: 'right' })
    .text(`Generated: ${dfmt(now.toISOString())}`, X1 - 250, y + 15, { width: 238, align: 'right' });
  y += 34;

  // ── employee details (2-column card) ──
  let top = sectionBar(X0, y, W, 'Employee Details');
  const halfW = W / 2;
  const empLeft = [
    ['Employee ID', empNo], ['Employee Name', emp.hr_hremployee1 || '—'],
    ['Department', emp.hr_department || '—'], ['Designation', emp.hr_designation || '—'],
    ['Reporting Manager', manager],
  ];
  const empRight = [
    ['Joining Date', dfmt(emp.hr_joiningdate)], ['PAN', emp.hr_pan || '—'],
    ['Bank A/C', maskAccount(emp.hr_accountnumber)], ['UAN', emp.hr_uan || '—'],
    ['PF Number', emp.hr_pfnumber || '—'],
  ];
  let ry = top + 8;
  for (let i = 0; i < empLeft.length; i++) { kv(X0, ry, halfW, empLeft[i][0], empLeft[i][1]); kv(X0 + halfW, ry, halfW, empRight[i][0], empRight[i][1]); ry += 14.5; }
  const empBottom = ry + 4;
  card(X0, top, W, empBottom - top);
  doc.moveTo(X0 + halfW, top).lineTo(X0 + halfW, empBottom).lineWidth(0.6).strokeColor(C.border).stroke();
  y = empBottom + 10;

  // ── attendance summary (stat grid) ──
  top = sectionBar(X0, y, W, 'Attendance Summary');
  const stats = [
    ['Working Days', dash(wd)], ['Present', dash(p.hr_presentdays)], ['Absent', dash(p.hr_absentdays)], ['Leave', '—'],
    ['LOP', dash(lopDays)], ['Salary Working Days', dash(pd)], ['Overtime (hrs)', dash(p.hr_overtime)], ['Late Count', '—'],
  ];
  const cellW = W / 4, cellH = 30, aTop = top;
  for (let i = 0; i < stats.length; i++) {
    const col = i % 4, row = Math.floor(i / 4);
    const x = X0 + col * cellW, cy = aTop + row * cellH;
    doc.font('Helvetica').fontSize(7).fillColor(C.gray).text(stats[i][0], x + 9, cy + 6, { width: cellW - 14 });
    doc.font('Helvetica-Bold').fontSize(11).fillColor(C.dark).text(String(stats[i][1]), x + 9, cy + 15, { width: cellW - 14 });
  }
  const aBottom = aTop + 2 * cellH + 2;
  card(X0, top, W, aBottom - top);
  for (let c = 1; c < 4; c++) doc.moveTo(X0 + c * cellW, top).lineTo(X0 + c * cellW, aBottom).lineWidth(0.5).strokeColor(C.border).stroke();
  doc.moveTo(X0, aTop + cellH).lineTo(X1, aTop + cellH).lineWidth(0.5).strokeColor(C.border).stroke();
  y = aBottom + 10;

  // ── earnings + deductions side by side ──
  const gap = 12, colW = (W - gap) / 2;
  const rowH = 15;
  const drawTable = (x, title, rows, totalLabel, totalVal, totalColor) => {
    const t = sectionBar(x, y, colW, title);
    let ty = t + 6;
    doc.fontSize(8);
    for (const [label, amt] of rows) {
      doc.font('Helvetica').fillColor(C.dark).text(label, x + 9, ty, { width: colW * 0.6 });
      doc.font('Helvetica').fillColor(amt ? totalColor : C.gray).text(money(amt), x + colW * 0.5, ty, { width: colW * 0.5 - 10, align: 'right' });
      ty += rowH;
    }
    // total row
    doc.rect(x + 0.5, ty, colW - 1, 20).fill(C.light);
    doc.font('Helvetica-Bold').fontSize(9).fillColor(C.dark).text(totalLabel, x + 9, ty + 6, { width: colW * 0.55 });
    doc.fillColor(totalColor).text(money(totalVal), x + colW * 0.45, ty + 6, { width: colW * 0.55 - 10, align: 'right' });
    const bottom = ty + 20;
    card(x, t, colW, bottom - t);
    return bottom;
  };
  const eBottom = drawTable(X0, 'Earnings', earnings, 'Gross Salary', gross, C.pos);
  const dBottom = drawTable(X0 + colW + gap, 'Deductions', deductionRows, 'Total Deductions', deductions, C.neg);
  y = Math.max(eBottom, dBottom) + 12;

  // ── net pay summary ──
  doc.roundedRect(X0, y, W, 44, 6).fill(C.primary);
  doc.fillColor('#dbeafe').font('Helvetica').fontSize(8).text('NET SALARY PAYABLE', X0 + 16, y + 9);
  doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(20).text(money(net), X0 + 16, y + 19);
  doc.font('Helvetica').fontSize(7.5).fillColor('#dbeafe').text('Gross Salary', X1 - 200, y + 8, { width: 90, align: 'right' });
  doc.fillColor('#ffffff').fontSize(8.5).text(money(gross), X1 - 200, y + 8, { width: 186, align: 'right' });
  doc.fillColor('#dbeafe').fontSize(7.5).text('Total Deductions', X1 - 200, y + 24, { width: 90, align: 'right' });
  doc.fillColor('#ffffff').fontSize(8.5).text('- ' + money(deductions), X1 - 200, y + 24, { width: 186, align: 'right' });
  y += 50;
  doc.font('Helvetica-Oblique').fontSize(8.5).fillColor(C.dark).text(`Amount in Words:  Rupees ${numberToWords(net)} Only`, X0 + 4, y);
  y += 22;

  // ── footer ──
  doc.moveTo(X0, y).lineTo(X1, y).lineWidth(0.6).strokeColor(C.border).stroke();
  y += 8;
  doc.font('Helvetica').fontSize(7.5).fillColor(C.gray).text('This is a computer-generated salary slip and does not require a signature.', X0, y, { width: W, align: 'center' });
  doc.font('Helvetica-Bold').fontSize(7.5).fillColor(C.dark).text('Generated by CRMONCE HR Management System', X0, y + 12, { width: W, align: 'center' });
  doc.font('Helvetica').fontSize(7).fillColor(C.gray).text(`${company.hr_name || ''}   ·   GSTIN: ${company.hr_gstin || '—'}   ·   CIN: ${company.hr_cin || '—'}`, X0, y + 24, { width: W, align: 'center' });

  doc.end();
  return done;
}

module.exports = { buildPayslipPdf, monthYear, numberToWords, MONTHS };
