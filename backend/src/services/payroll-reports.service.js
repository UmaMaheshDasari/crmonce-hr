/**
 * Payroll / HR Excel reports (exceljs). Each builder returns an ExcelJS.Workbook:
 *   payroll-register   — every payroll row for the year (earnings/deductions/net)
 *   salary-register    — employee salary structure (CTC)
 *   attendance-register— present/absent/working days per payroll row
 *   employee-master    — full employee master (identity + bank + personal)
 *   bank-transfer      — net pay + bank details for disbursement
 *
 * Data is read from Dataverse; identity/bank columns are optional (degrade if not
 * yet provisioned). Company header comes from Company Settings (never hardcoded).
 */
const ExcelJS = require('exceljs');
const d365 = require('./d365.service');
const companySvc = require('./company.service');

const E = d365.constructor.entities;
const PAYROLL = E.payroll;
const MONTHS = ['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const STATUS = { 123140000: 'Draft', draft: 'Draft', processed: 'Approved', paid: 'Released' };
const statusLabel = (s) => STATUS[s] || (s ? String(s) : '—');
const nameOf = (r) => r['_hr_hremployee_value@OData.Community.Display.V1.FormattedValue'] || '—';

function styleHeader(ws) {
  ws.getRow(1).font = { bold: true };
  ws.getRow(1).eachCell((c) => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD9E8FB' } }; });
  ws.views = [{ state: 'frozen', ySplit: 1 }];
}
function autoWidth(ws) {
  ws.columns.forEach((col) => {
    let max = col.header ? String(col.header).length : 10;
    col.eachCell({ includeEmpty: false }, (cell) => { const l = cell.value != null ? String(cell.value).length : 0; if (l > max) max = l; });
    col.width = Math.min(Math.max(max + 2, 10), 48);
  });
}
async function titledSheet(wb, name, company, subtitle) {
  const ws = wb.addWorksheet(name);
  return ws;
}

async function fetchEmployees() {
  const res = await d365.getListOptional(E.employee, {
    select: 'hr_hremployeeid,hr_hremployee1,hr_email,hr_phone,hr_department,hr_designation,hr_status,hr_joiningdate,hr_salary,hr_allowances,hr_deductions',
    optionalSelect: 'hr_pan,hr_aadhaar,hr_uan,hr_esic,hr_pfnumber,hr_bloodgroup,hr_emergencycontact,hr_emergencyphone,hr_bankname,hr_accountholder,hr_accountnumber,hr_ifsc,hr_branch',
    top: 5000, orderby: 'hr_hremployee1 asc',
  });
  return res.data || [];
}
async function fetchPayroll(year) {
  const res = await d365.getListOptional(PAYROLL, {
    select: 'hr_hrpayrollid,hr_month,hr_year,hr_basic,hr_allowances,hr_deductions,hr_netpay,hr_status,_hr_hremployee_value',
    optionalSelect: 'hr_gross,hr_overtime,hr_lop,hr_presentdays,hr_absentdays,hr_workingdays,hr_paydays,hr_approvedby,hr_releasedby',
    filter: year ? `hr_year eq ${year}` : undefined,
    orderby: 'hr_year desc,hr_month desc', top: 5000,
  });
  return res.data || [];
}

async function buildReport(type, { year, month } = {}) {
  const company = await companySvc.getCompany();
  const wb = new ExcelJS.Workbook();
  wb.creator = 'CRMONCE HRMS';

  if (type === 'payroll-register') {
    const rows = await fetchPayroll(year);
    const ws = await titledSheet(wb, 'Payroll Register', company);
    ws.columns = [
      { header: 'Employee', key: 'emp', width: 24 }, { header: 'Month', key: 'month', width: 8 },
      { header: 'Year', key: 'year', width: 8 }, { header: 'Basic', key: 'basic', width: 12 },
      { header: 'Allowances', key: 'allow', width: 12 }, { header: 'Overtime', key: 'ot', width: 10 },
      { header: 'Gross', key: 'gross', width: 12 }, { header: 'Deductions', key: 'ded', width: 12 },
      { header: 'Net Pay', key: 'net', width: 12 }, { header: 'Status', key: 'status', width: 12 },
    ];
    for (const r of rows) ws.addRow({
      emp: nameOf(r), month: MONTHS[r.hr_month] || r.hr_month, year: r.hr_year,
      basic: r.hr_basic || 0, allow: r.hr_allowances || 0, ot: r.hr_overtime || 0,
      gross: r.hr_gross != null ? r.hr_gross : (r.hr_basic || 0) + (r.hr_allowances || 0),
      ded: r.hr_deductions || 0, net: r.hr_netpay || 0, status: statusLabel(r.hr_status),
    });
    styleHeader(ws); autoWidth(ws);
  }

  else if (type === 'salary-register') {
    const emps = await fetchEmployees();
    const ws = await titledSheet(wb, 'Salary Register', company);
    ws.columns = [
      { header: 'Employee', key: 'name', width: 24 }, { header: 'Department', key: 'dept', width: 16 },
      { header: 'Designation', key: 'desig', width: 18 }, { header: 'Basic', key: 'basic', width: 12 },
      { header: 'Allowances', key: 'allow', width: 12 }, { header: 'Deductions', key: 'ded', width: 12 },
      { header: 'Gross (Basic+Allow)', key: 'gross', width: 16 }, { header: 'Net (approx)', key: 'net', width: 14 },
    ];
    for (const e of emps) {
      const basic = e.hr_salary || 0, allow = e.hr_allowances || 0, ded = e.hr_deductions || 0;
      ws.addRow({ name: e.hr_hremployee1, dept: e.hr_department || '—', desig: e.hr_designation || '—', basic, allow, ded, gross: basic + allow, net: basic + allow - ded });
    }
    styleHeader(ws); autoWidth(ws);
  }

  else if (type === 'attendance-register') {
    const rows = await fetchPayroll(year);
    const ws = await titledSheet(wb, 'Attendance Register', company);
    ws.columns = [
      { header: 'Employee', key: 'emp', width: 24 }, { header: 'Month', key: 'month', width: 8 },
      { header: 'Year', key: 'year', width: 8 }, { header: 'Present', key: 'present', width: 10 },
      { header: 'Absent', key: 'absent', width: 10 }, { header: 'Salary Working Days', key: 'wd', width: 18 },
      { header: 'Payable Days', key: 'pd', width: 12 },
    ];
    for (const r of rows) ws.addRow({
      emp: nameOf(r), month: MONTHS[r.hr_month] || r.hr_month, year: r.hr_year,
      present: r.hr_presentdays ?? '—', absent: r.hr_absentdays ?? '—', wd: r.hr_workingdays ?? '—', pd: r.hr_paydays ?? '—',
    });
    styleHeader(ws); autoWidth(ws);
  }

  else if (type === 'employee-master') {
    const emps = await fetchEmployees();
    const ws = await titledSheet(wb, 'Employee Master', company);
    ws.columns = [
      { header: 'Employee', key: 'name', width: 24 }, { header: 'Email', key: 'email', width: 24 },
      { header: 'Phone', key: 'phone', width: 14 }, { header: 'Department', key: 'dept', width: 16 },
      { header: 'Designation', key: 'desig', width: 18 }, { header: 'Joining Date', key: 'doj', width: 14 },
      { header: 'PAN', key: 'pan', width: 12 }, { header: 'Aadhaar', key: 'aadhaar', width: 14 },
      { header: 'UAN', key: 'uan', width: 14 }, { header: 'PF No', key: 'pf', width: 16 },
      { header: 'ESIC', key: 'esic', width: 14 }, { header: 'Blood Group', key: 'blood', width: 10 },
      { header: 'Emergency Contact', key: 'ec', width: 18 }, { header: 'Emergency Phone', key: 'ep', width: 14 },
      { header: 'Bank', key: 'bank', width: 18 }, { header: 'Account No', key: 'acc', width: 18 }, { header: 'IFSC', key: 'ifsc', width: 14 },
    ];
    for (const e of emps) ws.addRow({
      name: e.hr_hremployee1, email: e.hr_email || '—', phone: e.hr_phone || '—', dept: e.hr_department || '—',
      desig: e.hr_designation || '—', doj: (e.hr_joiningdate || '').slice(0, 10) || '—',
      pan: e.hr_pan || '—', aadhaar: e.hr_aadhaar || '—', uan: e.hr_uan || '—', pf: e.hr_pfnumber || '—',
      esic: e.hr_esic || '—', blood: e.hr_bloodgroup || '—', ec: e.hr_emergencycontact || '—', ep: e.hr_emergencyphone || '—',
      bank: e.hr_bankname || '—', acc: e.hr_accountnumber || '—', ifsc: e.hr_ifsc || '—',
    });
    styleHeader(ws); autoWidth(ws);
  }

  else if (type === 'bank-transfer') {
    const [rows, emps] = await Promise.all([fetchPayroll(year), fetchEmployees()]);
    const byId = new Map(emps.map((e) => [e.hr_hremployeeid, e]));
    const ws = await titledSheet(wb, 'Bank Transfer', company);
    ws.columns = [
      { header: 'Employee', key: 'emp', width: 24 }, { header: 'Month', key: 'month', width: 8 }, { header: 'Year', key: 'year', width: 8 },
      { header: 'Account Holder', key: 'holder', width: 22 }, { header: 'Bank', key: 'bank', width: 18 },
      { header: 'Account No', key: 'acc', width: 20 }, { header: 'IFSC', key: 'ifsc', width: 14 }, { header: 'Net Pay', key: 'net', width: 12 },
    ];
    const filtered = month ? rows.filter((r) => r.hr_month === month) : rows;
    for (const r of filtered) {
      const e = byId.get(r._hr_hremployee_value) || {};
      ws.addRow({
        emp: nameOf(r), month: MONTHS[r.hr_month] || r.hr_month, year: r.hr_year,
        holder: e.hr_accountholder || e.hr_hremployee1 || nameOf(r), bank: e.hr_bankname || '—',
        acc: e.hr_accountnumber || '—', ifsc: e.hr_ifsc || '—', net: r.hr_netpay || 0,
      });
    }
    styleHeader(ws); autoWidth(ws);
  }

  else {
    throw Object.assign(new Error(`Unknown report type: ${type}`), { status: 400 });
  }

  return wb;
}

module.exports = { buildReport };
