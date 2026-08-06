/**
 * Enterprise salary slip PDF (pdfkit) — A4 portrait. Clean white theme with royal-
 * blue headings, light-gray section bars and thin borders. Salary information only
 * (no attendance). Returns a Buffer so the download route and the approval email
 * reuse the identical document.
 *
 * ALL company identity (name, logo, GSTIN, CIN, registered office, email, phone,
 * website) is read from Company Settings — nothing is hardcoded in the PDF.
 */
const fs = require('fs');
const PDFDocument = require('pdfkit');
const companySvc = require('./company.service');
const { calculateProfessionalTax } = require('./professional-tax');

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const pad2 = (n) => String(n).padStart(2, '0');
const monthYear = (p) => `${MONTHS[(p.hr_month || 1) - 1] || ''} ${p.hr_year || ''}`.trim();
const money = (v) => 'Rs. ' + (Number(v) || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const maskAccount = (a) => { const s = String(a || ''); return s.length > 4 ? `XXXX${s.slice(-4)}` : (a || '—'); };
const dfmt = (d) => { const s = String(d || '').slice(0, 10); if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return d || '—'; const [y, m, dd] = s.split('-'); return `${dd}-${MONTHS[+m - 1]?.slice(0, 3)}-${y}`; };
const DEFAULT_MANAGER = process.env.DEFAULT_MANAGER_NAME || 'Uma Mahesh';

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

// ── palette (white / light-gray / royal blue) ──
const C = { blue: '#2563EB', dark: '#0f172a', gray: '#64748b', border: '#e5e7eb', head: '#f1f5f9', light: '#f8fafc' };

// Company email + HR-portal website (normalise a blank/legacy bare crmonce.com).
function resolveContact(company = {}) {
  const email = company.hr_email || 'info@crmonce.com';
  const rawSite = String(company.hr_website || '').trim();
  const website = (!rawSite || /^(https?:\/\/)?(www\.)?crmonce\.com\/?$/i.test(rawSite)) ? 'https://hr.crmonce.com' : rawSite;
  return { email, website };
}

/**
 * The single numeric core of the payslip — used by BOTH the PDF and the on-screen
 * HTML view so they can never disagree. Full monthly gross with LOP as an explicit
 * deduction: Gross − PF − PT − TDS − LOP − Advance − Other = Net.
 */
function computeFigures(p = {}) {
  const basic = Number(p.hr_basic) || 0;
  const hra = Number(p.hr_hra) || 0;
  const special = Number(p.hr_special) || 0;
  const medical = Number(p.hr_medical) || 0;
  const conveyance = Number(p.hr_conveyance) || 0;
  const allowances = Number(p.hr_allowances) || 0;   // "Other Allowances" bucket
  const overtime = Number(p.hr_overtime) || 0;
  const gross = basic + hra + special + medical + conveyance + allowances + overtime;

  const pf = Number(p.hr_pf) || 0;
  // Professional Tax is ALWAYS shown from the slab on the base gross (the six
  // salary components, excluding overtime) — never a stale stored value.
  const ptBase = basic + hra + special + medical + conveyance + allowances;
  // Professional Tax = the amount STORED at generation (resolved from the PT Master
  // for that month/state) → historical payslips are immutable. Falls back to the
  // built-in slab only for legacy rows generated before PT was stored.
  const professionalTax = (p.hr_professionaltax != null && p.hr_professionaltax !== '')
    ? (Number(p.hr_professionaltax) || 0)
    : calculateProfessionalTax(ptBase);
  const incomeTax = Number(p.hr_incometax) || Number(p.hr_tds) || 0;
  const lop = Number(p.hr_lop) || 0;
  const advance = Number(p.hr_advance) || 0;
  const otherDeductions = Number(p.hr_deductions) || 0;
  const deductions = pf + professionalTax + incomeTax + lop + advance + otherDeductions;
  const net = gross - deductions;

  // DYNAMIC payslip: only components with a value appear — every zero-value row is
  // hidden (no empty rows). Section totals stay exact regardless.
  const earnings = [
    ['Basic', basic], ['House Rent Allowance (HRA)', hra], ['Special Allowance', special],
    ['Medical Allowance', medical], ['Conveyance', conveyance], ['Other Allowances', allowances + overtime],
  ].filter(([, amt]) => amt > 0);
  const deductionRows = [
    ['Provident Fund (PF)', pf], ['Professional Tax', professionalTax],
    ['Income Tax (TDS)', incomeTax], ['LOP Deduction', lop],
    ['Advance Salary', advance], ['Other Deductions', otherDeductions],
  ].filter(([, amt]) => amt > 0);
  return { gross, deductions, net, earnings, deductionRows };
}

/**
 * Structured payslip model (company + employee + earnings/deductions + net) for the
 * responsive on-screen view. Shares computeFigures() with the PDF. Never throws.
 */
async function payslipModel({ payroll, employee, company }) {
  company = company || await companySvc.getCompany();
  const emp = employee || {};
  const p = payroll || {};
  const empNo = emp.hr_employeeid || emp.hr_employeecode || emp.hr_etimecode || '—';
  const manager = emp['_hr_manager_value@OData.Community.Display.V1.FormattedValue'] || emp._reportingmanager || DEFAULT_MANAGER;
  const { email, website } = resolveContact(company);
  const f = computeFigures(p);
  const asMoney = ([label, amount]) => ({ label, amount, display: money(amount) });
  return {
    company: {
      name: company.hr_name || 'Company', gstin: company.hr_gstin || '', cin: company.hr_cin || '',
      addressLines: companySvc.addressLines(company), email, website, logoUrl: company.hr_logourl || '/crmonce-logo.png',
    },
    employee: {
      employeeId: empNo, name: emp.hr_hremployee1 || '—', department: emp.hr_department || '—',
      designation: emp.hr_designation || '—', joiningDate: dfmt(emp.hr_joiningdate), manager,
      pan: emp.hr_pan || '—', bankAccount: maskAccount(emp.hr_accountnumber), pfNumber: emp.hr_pfnumber || '—', uan: emp.hr_uan || '—',
    },
    meta: { monthYear: monthYear(p), payrollNo: `PS/${p.hr_year || ''}-${pad2(p.hr_month || 0)}/${empNo}`, generatedOn: dfmt(new Date().toISOString()), status: p.hr_status || '', locked: p.hr_locked === 'true' },
    earnings: f.earnings.map(asMoney), gross: f.gross, grossDisplay: money(f.gross),
    deductions: f.deductionRows.map(asMoney), totalDeductions: f.deductions, totalDeductionsDisplay: money(f.deductions),
    net: f.net, netDisplay: money(f.net), netInWords: `Rupees ${numberToWords(f.net)} Only`,
  };
}

async function buildPayslipPdf({ payroll, employee, company }) {
  company = company || await companySvc.getCompany();
  const doc = new PDFDocument({ size: 'A4', margin: 30 });
  const chunks = [];
  doc.on('data', (c) => chunks.push(c));
  const done = new Promise((resolve) => doc.on('end', () => resolve(Buffer.concat(chunks))));

  const X0 = 30, X1 = 565, W = X1 - X0;
  const emp = employee || {};
  const p = payroll || {};
  const my = monthYear(p);
  const empNo = emp.hr_employeeid || emp.hr_employeecode || emp.hr_etimecode || '—';
  const manager = emp['_hr_manager_value@OData.Community.Display.V1.FormattedValue'] || emp._reportingmanager || DEFAULT_MANAGER;
  const payrollNo = `PS/${p.hr_year || ''}-${pad2(p.hr_month || 0)}/${empNo}`;

  // ── figures (shared numeric core — identical to the on-screen HTML view) ──
  const { gross, deductions, net, earnings, deductionRows } = computeFigures(p);

  // ── helpers ──
  const card = (x, y, w, h) => doc.roundedRect(x, y, w, h, 5).lineWidth(0.8).strokeColor(C.border).stroke();
  const sec = (x, y, w, title) => {
    doc.rect(x, y, w, 20).fillAndStroke(C.head, C.border);
    doc.fillColor(C.blue).font('Helvetica-Bold').fontSize(9).text(title.toUpperCase(), x + 10, y + 6, { characterSpacing: 0.3 });
    return y + 20;
  };
  const kv = (x, y, w, label, value) => {
    doc.font('Helvetica').fontSize(8).fillColor(C.gray).text(label, x + 10, y, { width: w * 0.42 });
    doc.font('Helvetica-Bold').fontSize(8.5).fillColor(C.dark).text(String(value ?? '—'), x + 10 + w * 0.42, y, { width: w * 0.58 - 14 });
  };

  // ── header (white) — logo floats left; all company identity is centered across
  //    the FULL page width so name / GSTIN / CIN / address / email / website line
  //    up on one centre axis regardless of the logo. ──
  const { email, website } = resolveContact(company);

  let y = 34;
  try { if (companySvc.LOGO_FILE && fs.existsSync(companySvc.LOGO_FILE)) doc.image(companySvc.LOGO_FILE, X0 + 4, y + 2, { fit: [56, 56] }); } catch { /* logo optional */ }
  doc.fillColor(C.blue).font('Helvetica-Bold').fontSize(17).text(company.hr_name || 'Company', X0, y, { width: W, align: 'center' });
  doc.font('Helvetica-Bold').fontSize(8.5).fillColor(C.dark).text(`GSTIN: ${company.hr_gstin || '—'}      CIN: ${company.hr_cin || '—'}`, X0, y + 24, { width: W, align: 'center' });
  doc.font('Helvetica').fontSize(7.5).fillColor(C.gray).text(companySvc.addressLines(company).join(', '), X0, y + 37, { width: W, align: 'center' });
  const contact = `Email: ${email}      |      Website: ${website}`;
  doc.font('Helvetica').fontSize(7.5).fillColor(C.gray).text(contact, X0, y + 49, { width: W, align: 'center' });
  y += 72;
  doc.moveTo(X0, y).lineTo(X1, y).lineWidth(1).strokeColor(C.blue).stroke();
  y += 10;

  // ── payslip title row ──
  doc.fillColor(C.blue).font('Helvetica-Bold').fontSize(12).text(`Salary Slip for ${my}`, X0, y);
  doc.font('Helvetica').fontSize(7.5).fillColor(C.gray)
    .text(`Payroll No: ${payrollNo}`, X1 - 240, y - 1, { width: 240, align: 'right' })
    .text(`Generated: ${dfmt(new Date().toISOString())}`, X1 - 240, y + 9, { width: 240, align: 'right' });
  y += 24;

  // ── employee details (2-column) ──
  let top = sec(X0, y, W, 'Employee Details');
  const halfW = W / 2;
  const left = [
    ['Employee ID', empNo], ['Employee Name', emp.hr_hremployee1 || '—'],
    ['Department', emp.hr_department || '—'], ['Designation', emp.hr_designation || '—'],
    ['Reporting Manager', manager],
  ];
  const right = [
    ['Joining Date', dfmt(emp.hr_joiningdate)], ['PAN', emp.hr_pan || '—'],
    ['Bank Account', maskAccount(emp.hr_accountnumber)], ['PF Number', emp.hr_pfnumber || '—'],
    ['UAN', emp.hr_uan || '—'],
  ];
  let ry = top + 9;
  for (let i = 0; i < left.length; i++) { kv(X0, ry, halfW, left[i][0], left[i][1]); kv(X0 + halfW, ry, halfW, right[i][0], right[i][1]); ry += 15; }
  const eBottom = ry + 5;
  card(X0, top, W, eBottom - top);
  doc.moveTo(X0 + halfW, top).lineTo(X0 + halfW, eBottom).lineWidth(0.6).strokeColor(C.border).stroke();
  y = eBottom + 12;

  // ── earnings + deductions side by side ──
  const gap = 12, colW = (W - gap) / 2, rowH = 15.5;
  const table = (x, title, rows, totalLabel, totalVal) => {
    const t = sec(x, y, colW, title);
    let ty = t + 7;
    doc.fontSize(8.5);
    rows.forEach(([label, amt], i) => {
      if (i % 2 === 1) doc.rect(x + 0.5, ty - 2.5, colW - 1, rowH).fill(C.light);
      doc.font('Helvetica').fillColor(C.dark).text(label, x + 10, ty, { width: colW * 0.6 });
      doc.font('Helvetica').fillColor(amt ? C.dark : C.gray).text(money(amt), x + colW * 0.5, ty, { width: colW * 0.5 - 12, align: 'right' });
      ty += rowH;
    });
    doc.rect(x + 0.5, ty, colW - 1, 22).fillAndStroke(C.head, C.border);
    doc.font('Helvetica-Bold').fontSize(9).fillColor(C.blue).text(totalLabel, x + 10, ty + 6.5, { width: colW * 0.55 });
    doc.fillColor(C.dark).text(money(totalVal), x + colW * 0.45, ty + 6.5, { width: colW * 0.55 - 12, align: 'right' });
    const bottom = ty + 22;
    card(x, t, colW, bottom - t);
    return bottom;
  };
  const earnBottom = table(X0, 'Earnings', earnings, 'Gross Salary', gross);
  const dedBottom = table(X0 + colW + gap, 'Deductions', deductionRows, 'Total Deductions', deductions);
  y = Math.max(earnBottom, dedBottom) + 14;

  // ── net salary (light card, blue number) ──
  doc.roundedRect(X0, y, W, 46, 6).fillAndStroke(C.light, C.border);
  doc.fillColor(C.gray).font('Helvetica').fontSize(8).text('NET SALARY PAYABLE', X0 + 16, y + 9);
  doc.fillColor(C.blue).font('Helvetica-Bold').fontSize(21).text(money(net), X0 + 16, y + 19);
  doc.font('Helvetica').fontSize(8).fillColor(C.gray).text('Gross Salary', X1 - 210, y + 9, { width: 100, align: 'right' });
  doc.fillColor(C.dark).font('Helvetica-Bold').text(money(gross), X1 - 210, y + 9, { width: 196, align: 'right' });
  doc.font('Helvetica').fillColor(C.gray).text('Total Deductions', X1 - 210, y + 25, { width: 100, align: 'right' });
  doc.fillColor(C.dark).font('Helvetica-Bold').text('- ' + money(deductions), X1 - 210, y + 25, { width: 196, align: 'right' });
  y += 54;
  doc.font('Helvetica-Oblique').fontSize(8.5).fillColor(C.dark).text(`Amount in Words:  Rupees ${numberToWords(net)} Only`, X0 + 2, y);
  y += 26;

  // ── footer ──
  doc.moveTo(X0, y).lineTo(X1, y).lineWidth(0.6).strokeColor(C.border).stroke();
  y += 9;
  doc.font('Helvetica-Bold').fontSize(8).fillColor(C.dark).text('Generated by CRMONCE HR Management System', X0, y, { width: W, align: 'center' });
  doc.font('Helvetica').fontSize(7.5).fillColor(C.gray).text('This is a computer-generated salary slip. No signature required.', X0, y + 12, { width: W, align: 'center' });
  doc.fontSize(7).text(`${company.hr_name || ''}   ·   GSTIN: ${company.hr_gstin || '—'}   ·   CIN: ${company.hr_cin || '—'}`, X0, y + 24, { width: W, align: 'center' });

  doc.end();
  return done;
}

module.exports = { buildPayslipPdf, payslipModel, computeFigures, resolveContact, monthYear, numberToWords, MONTHS };
