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
const salaryStructureSvc = require('./salary-structure.service');

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

// Employee ID (EMP1039) = the eTime business ID — never the GUID.
const empId = (e) => e?.hr_employeeid || e?.hr_employeecode || e?.hr_etimecode || '';
const empCode = (e) => e?.hr_etimecode || '';   // device Empcode (40)

async function fetchEmployees() {
  const res = await d365.getListOptional(E.employee, {
    // Salary is NEVER read from the Employee record — the Salary Structure is the
    // single source of truth (see activeStructureMap + the salary-register builder).
    select: 'hr_hremployeeid,hr_hremployee1,hr_email,hr_phone,hr_department,hr_designation,hr_status,hr_joiningdate,hr_etimecode',
    optionalSelect: 'hr_employeeid,hr_employeecode,hr_pan,hr_aadhaar,hr_uan,hr_pfnumber,hr_bloodgroup,hr_emergencycontact,hr_emergencyphone,hr_bankname,hr_accountholder,hr_accountnumber,hr_ifsc,hr_branch',
    top: 5000, orderby: 'hr_hremployee1 asc',
  });
  return res.data || [];
}
// GUID → { id, code } map (for payroll-row reports that only carry the lookup value).
async function empInfoMap() {
  const emps = await fetchEmployees();
  return new Map(emps.map((e) => [e.hr_hremployeeid, { id: empId(e), code: empCode(e) }]));
}
async function fetchPayroll(year) {
  const res = await d365.getListOptional(PAYROLL, {
    select: 'hr_hrpayrollid,hr_month,hr_year,hr_basic,hr_allowances,hr_deductions,hr_netpay,hr_status,_hr_hremployee_value',
    optionalSelect: 'hr_gross,hr_overtime,hr_lop,hr_hourdeduction,hr_presentdays,hr_absentdays,hr_workingdays,hr_paydays,hr_approvedby,hr_releasedby',
    filter: year ? `hr_year eq ${year}` : undefined,
    orderby: 'hr_year desc,hr_month desc', top: 5000,
  });
  return res.data || [];
}

// employeeGuid → shaped active Salary Structure, effective as of `asOf`. ONE query
// for the whole company (not one per employee). Mirrors getActiveStructure's rule:
// the latest active revision effective on/before asOf, else the latest active revision.
async function activeStructureMap(asOf) {
  const res = await d365.getListOptional(E.salaryStructure, {
    select: salaryStructureSvc.SELECT,
    filter: `hr_status eq 'active'`,
    orderby: 'hr_effectivefrom desc,createdon desc', top: 5000,
  });
  const cut = String(asOf || '').slice(0, 10);
  const byEmp = new Map();   // employeeGuid → rows[] (already newest-first)
  for (const row of res.data || []) {
    const eid = row.hr_employeeid;
    if (!eid) continue;
    if (!byEmp.has(eid)) byEmp.set(eid, []);
    byEmp.get(eid).push(row);
  }
  const out = new Map();
  for (const [eid, list] of byEmp) {
    const effective = cut ? list.find((r) => (r.hr_effectivefrom || '').slice(0, 10) <= cut) : null;
    out.set(eid, salaryStructureSvc.shape(effective || list[0]));
  }
  return out;
}

async function buildReport(type, { year, month } = {}) {
  const company = await companySvc.getCompany();
  const wb = new ExcelJS.Workbook();
  wb.creator = 'CRMONCE HRMS';

  if (type === 'payroll-register') {
    const [rows, ids] = await Promise.all([fetchPayroll(year), empInfoMap()]);
    const ws = await titledSheet(wb, 'Payroll Register', company);
    ws.columns = [
      { header: 'Employee ID', key: 'eid', width: 12 }, { header: 'Employee', key: 'emp', width: 24 }, { header: 'Month', key: 'month', width: 8 },
      { header: 'Year', key: 'year', width: 8 }, { header: 'Basic', key: 'basic', width: 12 },
      { header: 'Allowances', key: 'allow', width: 12 }, { header: 'Overtime', key: 'ot', width: 10 },
      { header: 'Gross', key: 'gross', width: 12 }, { header: 'Deductions', key: 'ded', width: 12 },
      { header: 'Net Pay', key: 'net', width: 12 }, { header: 'Status', key: 'status', width: 12 },
    ];
    for (const r of rows) ws.addRow({
      eid: ids.get(r._hr_hremployee_value)?.id || '—', emp: nameOf(r), month: MONTHS[r.hr_month] || r.hr_month, year: r.hr_year,
      basic: r.hr_basic || 0, allow: r.hr_allowances || 0, ot: r.hr_overtime || 0,
      gross: r.hr_gross != null ? r.hr_gross : (r.hr_basic || 0) + (r.hr_allowances || 0),
      ded: r.hr_deductions || 0, net: r.hr_netpay || 0, status: statusLabel(r.hr_status),
    });
    styleHeader(ws); autoWidth(ws);
  }

  else if (type === 'salary-register') {
    // Basic / Allowances / Deductions / Gross / Net come from the employee's active
    // Salary Structure (the single source of truth) — NEVER the Employee record.
    // asOf = end of the requested month, else today, so the register reflects the
    // revision in force for that period.
    const asOf = (year && month)
      ? `${year}-${String(month).padStart(2, '0')}-${String(new Date(year, month, 0).getDate()).padStart(2, '0')}`
      : new Date().toISOString().slice(0, 10);
    const [emps, structures] = await Promise.all([fetchEmployees(), activeStructureMap(asOf)]);
    const ws = await titledSheet(wb, 'Salary Register', company);
    ws.columns = [
      { header: 'Employee ID', key: 'eid', width: 12 }, { header: 'Employee', key: 'name', width: 24 }, { header: 'Department', key: 'dept', width: 16 },
      { header: 'Designation', key: 'desig', width: 18 }, { header: 'Basic', key: 'basic', width: 12 },
      { header: 'Allowances', key: 'allow', width: 12 }, { header: 'Deductions', key: 'ded', width: 12 },
      { header: 'Gross', key: 'gross', width: 12 }, { header: 'Net Pay', key: 'net', width: 14 },
    ];
    for (const e of emps) {
      const base = { eid: empId(e) || '—', name: e.hr_hremployee1, dept: e.hr_department || '—', desig: e.hr_designation || '—' };
      const s = structures.get(e.hr_hremployeeid);
      if (s) {
        const allow = s.hra + s.special + s.medical + s.conveyance + s.otherAllowance;
        ws.addRow({ ...base, basic: s.basic, allow, ded: s.totalDeductions, gross: s.gross, net: s.netSalary });
      } else {
        // Flag clearly — no misleading ₹0 when no structure is assigned.
        ws.addRow({ ...base, basic: '—', allow: '—', ded: '—', gross: '—', net: 'No Salary Structure' });
      }
    }
    styleHeader(ws); autoWidth(ws);
  }

  else if (type === 'attendance-register') {
    const [rows, ids] = await Promise.all([fetchPayroll(year), empInfoMap()]);
    const ws = await titledSheet(wb, 'Attendance Register', company);
    ws.columns = [
      { header: 'Employee ID', key: 'eid', width: 12 }, { header: 'Employee', key: 'emp', width: 24 }, { header: 'Month', key: 'month', width: 8 },
      { header: 'Year', key: 'year', width: 8 }, { header: 'Present', key: 'present', width: 10 },
      { header: 'Absent', key: 'absent', width: 10 }, { header: 'Salary Working Days', key: 'wd', width: 18 },
      { header: 'Payable Days', key: 'pd', width: 12 },
      // Salary-affecting attendance deductions — read from the stored payroll row (no recompute).
      { header: 'Absent LOP (₹)', key: 'lop', width: 14 }, { header: 'Hourly Shortage Deduction (₹)', key: 'hrded', width: 26 },
      { header: 'Total Deduction (₹)', key: 'totded', width: 18 },
    ];
    for (const r of rows) {
      const gross = r.hr_gross != null ? Number(r.hr_gross) : (Number(r.hr_basic) || 0) + (Number(r.hr_allowances) || 0);
      const totalDed = Math.max(0, Math.round(gross - (Number(r.hr_netpay) || 0)));
      ws.addRow({
        eid: ids.get(r._hr_hremployee_value)?.id || '—', emp: nameOf(r), month: MONTHS[r.hr_month] || r.hr_month, year: r.hr_year,
        present: r.hr_presentdays ?? '—', absent: r.hr_absentdays ?? '—', wd: r.hr_workingdays ?? '—', pd: r.hr_paydays ?? '—',
        lop: r.hr_lop != null ? Number(r.hr_lop) : 0, hrded: r.hr_hourdeduction != null ? Number(r.hr_hourdeduction) : 0, totded: totalDed,
      });
    }
    styleHeader(ws); autoWidth(ws);
  }

  else if (type === 'employee-master') {
    const emps = await fetchEmployees();
    const ws = await titledSheet(wb, 'Employee Master', company);
    ws.columns = [
      { header: 'Employee ID', key: 'eid', width: 12 }, { header: 'Employee Code', key: 'code', width: 12 }, { header: 'Employee', key: 'name', width: 24 }, { header: 'Email', key: 'email', width: 24 },
      { header: 'Phone', key: 'phone', width: 14 }, { header: 'Department', key: 'dept', width: 16 },
      { header: 'Designation', key: 'desig', width: 18 }, { header: 'Joining Date', key: 'doj', width: 14 },
      { header: 'PAN', key: 'pan', width: 12 }, { header: 'Aadhaar', key: 'aadhaar', width: 14 },
      { header: 'UAN', key: 'uan', width: 14 }, { header: 'PF No', key: 'pf', width: 16 },
      { header: 'Blood Group', key: 'blood', width: 10 },
      { header: 'Emergency Contact', key: 'ec', width: 18 }, { header: 'Emergency Phone', key: 'ep', width: 14 },
      { header: 'Bank', key: 'bank', width: 18 }, { header: 'Account No', key: 'acc', width: 18 }, { header: 'IFSC', key: 'ifsc', width: 14 },
    ];
    for (const e of emps) ws.addRow({
      eid: empId(e) || '—', code: empCode(e) || '—', name: e.hr_hremployee1, email: e.hr_email || '—', phone: e.hr_phone || '—', dept: e.hr_department || '—',
      desig: e.hr_designation || '—', doj: (e.hr_joiningdate || '').slice(0, 10) || '—',
      pan: e.hr_pan || '—', aadhaar: e.hr_aadhaar || '—', uan: e.hr_uan || '—', pf: e.hr_pfnumber || '—',
      blood: e.hr_bloodgroup || '—', ec: e.hr_emergencycontact || '—', ep: e.hr_emergencyphone || '—',
      bank: e.hr_bankname || '—', acc: e.hr_accountnumber || '—', ifsc: e.hr_ifsc || '—',
    });
    styleHeader(ws); autoWidth(ws);
  }

  else if (type === 'bank-transfer') {
    const [rows, emps] = await Promise.all([fetchPayroll(year), fetchEmployees()]);
    const byId = new Map(emps.map((e) => [e.hr_hremployeeid, e]));
    const ws = await titledSheet(wb, 'Bank Transfer', company);
    ws.columns = [
      { header: 'Employee ID', key: 'eid', width: 12 }, { header: 'Employee', key: 'emp', width: 24 }, { header: 'Month', key: 'month', width: 8 }, { header: 'Year', key: 'year', width: 8 },
      { header: 'Account Holder', key: 'holder', width: 22 }, { header: 'Bank', key: 'bank', width: 18 },
      { header: 'Account No', key: 'acc', width: 20 }, { header: 'IFSC', key: 'ifsc', width: 14 }, { header: 'Net Pay', key: 'net', width: 12 },
    ];
    const filtered = month ? rows.filter((r) => r.hr_month === month) : rows;
    for (const r of filtered) {
      const e = byId.get(r._hr_hremployee_value) || {};
      ws.addRow({
        eid: empId(e) || '—', emp: nameOf(r), month: MONTHS[r.hr_month] || r.hr_month, year: r.hr_year,
        holder: e.hr_accountholder || e.hr_hremployee1 || nameOf(r), bank: e.hr_bankname || '—',
        acc: e.hr_accountnumber || '—', ifsc: e.hr_ifsc || '—', net: r.hr_netpay || 0,
      });
    }
    styleHeader(ws); autoWidth(ws);
  }

  else if (type === 'payslip-register') {
    const [rows, ids] = await Promise.all([fetchPayroll(year), empInfoMap()]);
    const ws = await titledSheet(wb, 'Payslip Register', company);
    ws.columns = [
      { header: 'Employee ID', key: 'eid', width: 12 }, { header: 'Employee', key: 'emp', width: 24 },
      { header: 'Month', key: 'month', width: 8 }, { header: 'Year', key: 'year', width: 8 },
      { header: 'Gross', key: 'gross', width: 12 }, { header: 'Deductions', key: 'ded', width: 12 },
      { header: 'Net Pay', key: 'net', width: 12 }, { header: 'Status', key: 'status', width: 12 },
    ];
    const filtered = month ? rows.filter((r) => r.hr_month === month) : rows;
    for (const r of filtered) ws.addRow({
      eid: ids.get(r._hr_hremployee_value)?.id || '—', emp: nameOf(r), month: MONTHS[r.hr_month] || r.hr_month, year: r.hr_year,
      gross: r.hr_gross != null ? r.hr_gross : (r.hr_basic || 0) + (r.hr_allowances || 0),
      ded: r.hr_deductions || 0, net: r.hr_netpay || 0, status: statusLabel(r.hr_status),
    });
    styleHeader(ws); autoWidth(ws);
  }

  else if (type === 'leave') {
    const { toLabel } = require('./picklist');
    const [{ data }, ids] = await Promise.all([
      d365.getList(E.leave, { select: 'hr_leavetype,hr_fromdate,hr_todate,hr_days,hr_status,_hr_hremployee_value', top: 5000 }),
      empInfoMap(),
    ]);
    const ws = await titledSheet(wb, 'Leave Report', company);
    ws.columns = [
      { header: 'Employee ID', key: 'eid', width: 12 }, { header: 'Employee', key: 'emp', width: 24 },
      { header: 'Leave Type', key: 'type', width: 16 }, { header: 'From', key: 'from', width: 12 },
      { header: 'To', key: 'to', width: 12 }, { header: 'Days', key: 'days', width: 8 }, { header: 'Status', key: 'status', width: 12 },
    ];
    const rows = (year ? (data || []).filter((l) => String(l.hr_fromdate || '').slice(0, 4) === String(year)) : (data || []));
    for (const l of rows) ws.addRow({
      eid: ids.get(l._hr_hremployee_value)?.id || '—', emp: l['_hr_hremployee_value@OData.Community.Display.V1.FormattedValue'] || '—',
      type: toLabel('hr_leave_type', l.hr_leavetype), from: String(l.hr_fromdate || '').slice(0, 10), to: String(l.hr_todate || '').slice(0, 10),
      days: l.hr_days || 0, status: toLabel('hr_leave_status', l.hr_status),
    });
    styleHeader(ws); autoWidth(ws);
  }

  else {
    throw Object.assign(new Error(`Unknown report type: ${type}`), { status: 400 });
  }

  return wb;
}

module.exports = { buildReport };
