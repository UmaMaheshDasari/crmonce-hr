// ── PAYROLL ───────────────────────────────────────────────────────
const express = require('express');
const payrollRouter = express.Router();
const d365 = require('../../services/d365.service');
const { requireRole, requirePermission } = require('../../middleware/auth.middleware');
const { notifyPayrollProcessed, broadcast } = require('../../services/notification.service');
const { toValue, labelsForList, labelsForEntity } = require('../../services/picklist');

payrollRouter.get('/', requirePermission('payroll:read'), async (req, res, next) => {
  try {
    const { employeeId, month, year, page = 1, limit = 20 } = req.query;
    const filters = [];
    const targetId = req.user.role === 'employee' ? req.user.id : employeeId;
    if (targetId) filters.push(`_hr_hremployee_value eq '${targetId}'`);
    if (month) filters.push(`hr_month eq ${month}`);
    if (year) filters.push(`hr_year eq ${year}`);

    const result = await d365.getList(d365.constructor.entities.payroll, {
      select: 'hr_hrpayrollid,hr_month,hr_year,hr_basic,hr_allowances,hr_deductions,hr_netpay,hr_status,hr_processeddate,_hr_hremployee_value',
      filter: filters.join(' and ') || undefined,
      orderby: 'hr_year desc,hr_month desc',
      top: limit, skip: (page - 1) * limit,
    });
    res.json(labelsForList('hr_hrpayrolls', result));
  } catch (err) { next(err); }
});

payrollRouter.post('/process', requireRole('super_admin', 'hr_manager'), async (req, res, next) => {
  try {
    const { month, year, employeeIds } = req.body;
    // Fetch employees
    const filter = employeeIds?.length
      ? employeeIds.map(id => `hr_hremployeeid eq '${id}'`).join(' or ')
      : `hr_status eq ${toValue('hr_employee_status', 'active')}`;
    const { data: employees } = await d365.getList(d365.constructor.entities.employee, {
      select: 'hr_hremployeeid,hr_hremployee1,hr_salary,hr_allowances,hr_deductions',
      filter,
    });

    const results = [];
    for (const emp of employees) {
      const basic = emp.hr_salary || 0;
      const allowances = emp.hr_allowances || 0;
      const deductions = emp.hr_deductions || 0;
      const netPay = basic + allowances - deductions;

      const payroll = await d365.create(d365.constructor.entities.payroll, {
        'hr_hremployee@odata.bind': `/hr_hremployees(${emp.hr_hremployeeid})`,
        hr_month: month, hr_year: year,
        hr_basic: basic, hr_allowances: allowances,
        hr_deductions: deductions, hr_netpay: netPay,
        hr_status: toValue('hr_payroll_status', 'processed'), hr_processeddate: new Date().toISOString(),
      });
      await notifyPayrollProcessed(emp.hr_hremployeeid, `${month}/${year}`);
      results.push(payroll);
    }
    // Broadcast payroll processed event to all connected clients
    broadcast('payroll:processed', { month: `${month}/${year}`, count: results.length });
    res.json({ message: `Payroll processed for ${results.length} employees`, count: results.length });
  } catch (err) { next(err); }
});

// GET /api/payroll/:id/payslip — generate PDF payslip
payrollRouter.get('/:id/payslip', requirePermission('payroll:read'), async (req, res, next) => {
  try {
    const PDFDocument = require('pdfkit');
    const payroll = await d365.getById(d365.constructor.entities.payroll, req.params.id, {
      select: 'hr_hrpayrollid,hr_month,hr_year,hr_basic,hr_allowances,hr_deductions,hr_netpay,hr_status,hr_processeddate,_hr_hremployee_value',
    });

    // Get employee details
    const empId = payroll._hr_hremployee_value;
    const employee = empId ? await d365.getById(d365.constructor.entities.employee, empId, {
      select: 'hr_hremployeeid,hr_hremployee1,hr_email,hr_department,hr_designation',
    }) : {};

    const empName = employee.hr_hremployee1 || payroll['_hr_hremployee_value@OData.Community.Display.V1.FormattedValue'] || 'Employee';
    const months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
    const monthName = months[(payroll.hr_month || 1) - 1];
    const basic = payroll.hr_basic || 0;
    const allowances = payroll.hr_allowances || 0;
    const deductions = payroll.hr_deductions || 0;
    const netPay = payroll.hr_netpay || 0;
    const fmt = (v) => v.toLocaleString('en-IN', { minimumFractionDigits: 2 });

    // Create PDF
    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename=Payslip_${empName.replace(/\s+/g,'_')}_${monthName}_${payroll.hr_year}.pdf`);
    doc.pipe(res);

    // ── Header ──────────────────────────────────────────────────
    doc.rect(0, 0, 595, 100).fill('#4338ca');
    doc.fontSize(22).font('Helvetica-Bold').fillColor('#ffffff')
       .text('PAYSLIP', 50, 30);
    doc.fontSize(10).font('Helvetica').fillColor('#c7d2fe')
       .text(`${monthName} ${payroll.hr_year}`, 50, 58);
    doc.fontSize(9).fillColor('#e0e7ff')
       .text('Your Company Name', 350, 30, { align: 'right', width: 195 })
       .text('123 Business Road, City', 350, 44, { align: 'right', width: 195 })
       .text('contact@yourcompany.com', 350, 58, { align: 'right', width: 195 });

    // ── Employee Info ───────────────────────────────────────────
    let y = 120;
    doc.fillColor('#1e1b4b').fontSize(12).font('Helvetica-Bold')
       .text('Employee Details', 50, y);
    y += 25;
    doc.fontSize(9).font('Helvetica').fillColor('#374151');

    const infoRows = [
      ['Employee Name', empName],
      ['Email', employee.hr_email || '—'],
      ['Department', employee.hr_department || '—'],
      ['Designation', employee.hr_designation || '—'],
      ['Pay Period', `${monthName} ${payroll.hr_year}`],
      ['Processed Date', payroll.hr_processeddate ? new Date(payroll.hr_processeddate).toLocaleDateString('en-IN') : '—'],
    ];

    for (const [label, value] of infoRows) {
      doc.font('Helvetica-Bold').fillColor('#6b7280').text(label, 50, y, { width: 150 });
      doc.font('Helvetica').fillColor('#111827').text(value, 200, y, { width: 300 });
      y += 18;
    }

    // ── Earnings Table ──────────────────────────────────────────
    y += 15;
    doc.fillColor('#1e1b4b').fontSize(12).font('Helvetica-Bold')
       .text('Earnings', 50, y);
    y += 20;

    // Table header
    doc.rect(50, y, 495, 22).fill('#f3f4f6');
    doc.fontSize(9).font('Helvetica-Bold').fillColor('#374151');
    doc.text('Component', 60, y + 6, { width: 300 });
    doc.text('Amount (₹)', 400, y + 6, { width: 135, align: 'right' });
    y += 22;

    // Earnings rows
    const earnings = [
      ['Basic Salary', basic],
      ['Allowances (HRA, DA, etc.)', allowances],
    ];
    for (const [label, amount] of earnings) {
      doc.font('Helvetica').fillColor('#374151').text(label, 60, y + 5, { width: 300 });
      doc.font('Helvetica').fillColor('#059669').text(`₹${fmt(amount)}`, 400, y + 5, { width: 135, align: 'right' });
      doc.moveTo(50, y + 22).lineTo(545, y + 22).strokeColor('#e5e7eb').lineWidth(0.5).stroke();
      y += 22;
    }

    // Gross total
    doc.rect(50, y, 495, 24).fill('#ecfdf5');
    doc.font('Helvetica-Bold').fillColor('#065f46').text('Gross Earnings', 60, y + 7, { width: 300 });
    doc.text(`₹${fmt(basic + allowances)}`, 400, y + 7, { width: 135, align: 'right' });
    y += 35;

    // ── Deductions Table ────────────────────────────────────────
    doc.fillColor('#1e1b4b').fontSize(12).font('Helvetica-Bold')
       .text('Deductions', 50, y);
    y += 20;

    doc.rect(50, y, 495, 22).fill('#f3f4f6');
    doc.fontSize(9).font('Helvetica-Bold').fillColor('#374151');
    doc.text('Component', 60, y + 6, { width: 300 });
    doc.text('Amount (₹)', 400, y + 6, { width: 135, align: 'right' });
    y += 22;

    const deductionRows = [
      ['PF / ESI / Tax Deductions', deductions],
    ];
    for (const [label, amount] of deductionRows) {
      doc.font('Helvetica').fillColor('#374151').text(label, 60, y + 5, { width: 300 });
      doc.font('Helvetica').fillColor('#dc2626').text(`-₹${fmt(amount)}`, 400, y + 5, { width: 135, align: 'right' });
      doc.moveTo(50, y + 22).lineTo(545, y + 22).strokeColor('#e5e7eb').lineWidth(0.5).stroke();
      y += 22;
    }

    doc.rect(50, y, 495, 24).fill('#fef2f2');
    doc.font('Helvetica-Bold').fillColor('#991b1b').text('Total Deductions', 60, y + 7, { width: 300 });
    doc.text(`-₹${fmt(deductions)}`, 400, y + 7, { width: 135, align: 'right' });
    y += 45;

    // ── Net Pay ─────────────────────────────────────────────────
    doc.rect(50, y, 495, 40).fill('#4338ca');
    doc.fontSize(14).font('Helvetica-Bold').fillColor('#ffffff')
       .text('Net Pay', 60, y + 12, { width: 200 });
    doc.fontSize(16).text(`₹${fmt(netPay)}`, 300, y + 11, { width: 235, align: 'right' });
    y += 55;

    // ── Footer ──────────────────────────────────────────────────
    doc.fontSize(8).font('Helvetica').fillColor('#9ca3af')
       .text('This is a computer-generated payslip and does not require a signature.', 50, y, { width: 495, align: 'center' });
    doc.text(`Generated on ${new Date().toLocaleDateString('en-IN')} at ${new Date().toLocaleTimeString('en-IN')}`, 50, y + 14, { width: 495, align: 'center' });

    doc.end();
  } catch (err) { next(err); }
});

module.exports = payrollRouter;
