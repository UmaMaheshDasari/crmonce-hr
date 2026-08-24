/**
 * Leave Usage Report — per-employee leave taken vs remaining for a leave-year.
 *
 * REPORTING ONLY. This never writes, never changes a leave status, balance, or
 * opening record. It reuses the existing sources of truth:
 *   - Balances / entitlement  → leave-engine.computeBalance (pure, approved+opening)
 *   - Leave type → category    → leave-engine.categoryOfType
 *   - Day count / clamp        → leave-summary.util resolveDays + daysInclusive
 *   - Opening migration        → leave-opening.service
 *   - Unauthorised absence LOP  → persisted payroll hr_absentdays (the payroll
 *                                 engine is the only source of truth for LOP)
 *
 * Usage counted = APPROVED + PENDING (rejected/cancelled excluded). Multi-day
 * leaves crossing the year boundary are clamped to the in-year span. PENDING is
 * shown as taken/applied but is NOT deducted from Remaining (Remaining reflects
 * the real balance = allocation − (opening + approved)).
 *
 * Performance: one query per source (leaves, opening, ledger, employees,
 * payroll) — all joined & computed in memory. No per-employee round-trips.
 */
const d365 = require('./d365.service');
const { toValue, toLabel } = require('./picklist');
const { resolveDays, daysInclusive } = require('./leave-summary.util');
const leaveEngine = require('./leave-engine.service');
const openingSvc = require('./leave-opening.service');
const payrollSettings = require('./payroll-settings.service');

const E = d365.constructor.entities;
const LEAVE = E.leave;
const LEDGER = E.leaveLedger;
const EMP = E.employee;
const PAYROLL = E.payroll;

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const isTrue = (v) => v === true || v === 1 || String(v).toLowerCase() === 'true' || String(v) === '1';
// Business Employee ID (EMP1039 / device code) — never the GUID. Mirrors payroll-reports.
const empCodeOf = (e) => e?.hr_employeeid || e?.hr_employeecode || e?.hr_etimecode || '';

/** In-year working/day count for a leave, clamped to [year-01-01, year-12-31]. Pure.
 *  Reuses resolveDays (stored hr_days, else inclusive span). A leave fully inside
 *  the year returns its full day count; a boundary-crossing leave is prorated by
 *  the in-year calendar fraction (rare; keeps the engine's day math authoritative). */
function clampedDays(leave, year) {
  const from = String(leave.hr_fromdate || '').slice(0, 10);
  if (!from) return 0;
  const to = String(leave.hr_todate || '').slice(0, 10) || from;
  const ys = `${year}-01-01`, ye = `${year}-12-31`;
  if (to < ys || from > ye) return 0;                 // no overlap with the year
  const full = num(resolveDays(leave.hr_days, from, to));
  const cf = from < ys ? ys : from;
  const ct = to > ye ? ye : to;
  const totalCal = daysInclusive(from, to);
  const clampCal = daysInclusive(cf, ct);
  if (totalCal <= 0) return r2(full);
  if (clampCal >= totalCal) return r2(full);           // fully in-year
  return r2(full * clampCal / totalCal);               // boundary crosser → prorate
}

/** Leave → report category. Comp-off leaves (Earned + hr_usecompoff) are their own
 *  bucket; everything else follows the engine's categoryOfType. Pure. */
function leaveCategory(leave) {
  if (isTrue(leave.hr_usecompoff)) return 'compoff';
  return leaveEngine.categoryOfType(toLabel('hr_leave_type', leave.hr_leavetype)); // casual|sick|lop|other
}

/**
 * Pure per-employee usage row. No I/O — fully unit-testable.
 * @param {{employee:object, opening?:object, approvedLeaves?:Array, pendingLeaves?:Array,
 *          ledger?:Array, policy?:object, absentDays?:number, year:number}} p
 */
function computeUsageRow({ employee = {}, opening = {}, approvedLeaves = [], pendingLeaves = [], ledger = [], policy = {}, absentDays = 0, year }) {
  // Authoritative balance (approved + opening; the existing engine logic, unchanged).
  const bal = leaveEngine.computeBalance({
    leaves: leaveEngine.normalizeLeaves(approvedLeaves, year),
    ledger: leaveEngine.normalizeLedger(ledger),
    policy,
    opening,
  });

  // Year-clamped applied days by category (approved and pending kept separate).
  const acc = { casual: 0, sick: 0, other: 0, lop: 0, compoff: 0 };
  const pend = { casual: 0, sick: 0, other: 0, lop: 0, compoff: 0 };
  let approvedApplied = 0, pendingApplied = 0;
  for (const l of approvedLeaves) { const d = clampedDays(l, year); if (!d) continue; acc[leaveCategory(l)] += d; approvedApplied += d; }
  for (const l of pendingLeaves) { const d = clampedDays(l, year); if (!d) continue; pend[leaveCategory(l)] += d; pendingApplied += d; }

  const openCasual = num(opening.casualUsed), openSick = num(opening.sickUsed);
  const openEarned = num(opening.earnedUsed), openLop = num(opening.lopUsed);

  // Taken = opening-migrated used + approved + pending (per own type; additive → no
  // overflow double-count). LOP here = explicit LOP-type leave only; unauthorised
  // absence is a separate column sourced from payroll.
  const casualTaken = r2(openCasual + acc.casual + pend.casual);
  const sickTaken = r2(openSick + acc.sick + pend.sick);
  const earnedTaken = r2(openEarned + acc.other + pend.other);
  const lopTaken = r2(openLop + acc.lop + pend.lop);
  const compOffTaken = r2(acc.compoff + pend.compoff);
  const absent = r2(num(absentDays));
  const totalTaken = r2(casualTaken + sickTaken + earnedTaken + lopTaken + compOffTaken + absent);

  // Remaining = real balance (allocation − opening − approved). Pending NOT deducted.
  const casualRemaining = bal.casual.remaining;
  const sickRemaining = bal.sick.remaining;
  const totalRemaining = r2(casualRemaining + sickRemaining); // = paid (CL+SL) remaining

  return {
    employeeId: employee.hr_hremployeeid || '',
    employeeName: employee.hr_hremployee1 || '',
    employeeCode: empCodeOf(employee),
    // Allocation ("opening" balance for the year). Earned is uncapped → null.
    openingCasual: bal.casual.entitled,
    openingSick: bal.sick.entitled,
    openingEarned: null,
    casualTaken, sickTaken, earnedTaken, lopTaken, compOffTaken,
    casualRemaining, sickRemaining, earnedRemaining: null,
    totalTaken, totalRemaining,
    pendingLeaveDays: r2(pendingApplied),
    approvedLeaveDays: r2(approvedApplied),
    absentDays: absent,
    compOffBalance: bal.compOff.balance,
  };
}

/** Least-taken first; ties alphabetical by employee name. */
function sortRows(rows) {
  return rows.slice().sort((a, b) =>
    (a.totalTaken - b.totalTaken) ||
    String(a.employeeName || '').localeCompare(String(b.employeeName || ''), undefined, { sensitivity: 'base' })
  );
}

async function getPolicy() {
  try { return (await payrollSettings.getResolved()).leavePolicy || {}; }
  catch { return { paidPerYear: 18, casual: 12, sick: 6 }; }
}

/** Active employees, one query → array (with business-id fields). */
async function fetchEmployees() {
  const res = await d365.getListOptional(EMP, {
    select: 'hr_hremployeeid,hr_hremployee1,hr_status',
    optionalSelect: 'hr_employeeid,hr_employeecode,hr_etimecode',
    filter: `hr_status eq ${toValue('hr_employee_status', 'active')}`,
    orderby: 'hr_hremployee1 asc', top: 5000,
  });
  return res.data || [];
}

/** All approved+pending leaves that can touch `year`, one query → grouped by employee. */
async function fetchLeaves(year) {
  const approved = toValue('hr_leave_status', 'approved');
  const pending = toValue('hr_leave_status', 'pending');
  const lo = `${Number(year) - 1}-01-01`, hi = `${year}-12-31`;
  const { data } = await d365.getList(LEAVE, {
    select: 'hr_days,hr_fromdate,hr_todate,hr_status,hr_leavetype,hr_usecompoff,_hr_hremployee_value',
    filter: `(hr_status eq ${approved} or hr_status eq ${pending}) and hr_fromdate ge ${lo} and hr_fromdate le ${hi}`,
    top: 5000,
  });
  const byEmp = new Map();  // guid → { approved:[], pending:[] }
  for (const l of data || []) {
    const id = l._hr_hremployee_value;
    if (!id) continue;
    if (!byEmp.has(id)) byEmp.set(id, { approved: [], pending: [] });
    const label = toLabel('hr_leave_status', l.hr_status);
    if (label === 'approved') byEmp.get(id).approved.push(l);
    else if (label === 'pending') byEmp.get(id).pending.push(l);
  }
  return byEmp;
}

/** All ledger rows for the year, one query → grouped by employee id. Never throws. */
async function fetchLedger(year) {
  try {
    const { data } = await d365.getList(LEDGER, {
      select: 'hr_kind,hr_category,hr_days,hr_effectivedate,hr_reason,hr_createdby,hr_employeeid,hr_year',
      filter: `hr_year eq '${year}'`, top: 5000,
    });
    const byEmp = new Map();
    for (const x of data || []) {
      const id = x.hr_employeeid;
      if (!id) continue;
      if (!byEmp.has(id)) byEmp.set(id, []);
      byEmp.get(id).push(x);
    }
    return byEmp;
  } catch { return new Map(); }  // ledger table not provisioned → no adjustments
}

/** Persisted payroll absence (LOP) days summed over the year, per employee. Never throws. */
async function fetchAbsence(year) {
  try {
    const res = await d365.getListOptional(PAYROLL, {
      select: 'hr_month,hr_year,_hr_hremployee_value',
      optionalSelect: 'hr_absentdays,hr_lop',
      filter: `hr_year eq ${year}`, top: 5000,
    });
    const byEmp = new Map();
    for (const p of res.data || []) {
      const id = p._hr_hremployee_value;
      if (!id) continue;
      const abs = num(p.hr_absentdays);
      byEmp.set(id, r2((byEmp.get(id) || 0) + abs));
    }
    return byEmp;
  } catch { return new Map(); }  // no payroll generated yet → absence unknown (0)
}

/**
 * Build the per-employee leave-usage report for a year. Sorted least-taken first
 * (ties alphabetical). Batched I/O, computed in memory.
 * @returns {Promise<Array>}
 */
async function buildSummary({ year } = {}) {
  const y = Number(year) || new Date().getFullYear();
  const [employees, leavesByEmp, ledgerByEmp, absenceByEmp, policy, openingRows] = await Promise.all([
    fetchEmployees(),
    fetchLeaves(y),
    fetchLedger(y),
    fetchAbsence(y),
    getPolicy(),
    openingSvc.list({ year: y }).catch(() => []),
  ]);
  const openingByEmp = new Map(openingRows.map((o) => [o.employeeId, o]));

  const rows = employees.map((employee) => {
    const id = employee.hr_hremployeeid;
    const lv = leavesByEmp.get(id) || { approved: [], pending: [] };
    const o = openingByEmp.get(id);
    return computeUsageRow({
      employee,
      opening: o ? { casualUsed: o.casualUsed, sickUsed: o.sickUsed, earnedUsed: o.earnedUsed, lopUsed: o.lopUsed, compOff: o.compOff } : {},
      approvedLeaves: lv.approved,
      pendingLeaves: lv.pending,
      ledger: ledgerByEmp.get(id) || [],
      policy,
      absentDays: absenceByEmp.get(id) || 0,
      year: y,
    });
  });
  return sortRows(rows);
}

/** Build an ExcelJS workbook of the usage report (sorted least-taken first). */
async function buildWorkbook({ year } = {}) {
  const ExcelJS = require('exceljs');
  const y = Number(year) || new Date().getFullYear();
  const rows = await buildSummary({ year: y });

  const wb = new ExcelJS.Workbook();
  wb.creator = 'CRMONCE HRMS';
  const ws = wb.addWorksheet(`Leave Usage ${y}`);
  const dash = (v) => (v == null ? '—' : v);
  ws.columns = [
    { header: 'Employee', key: 'name', width: 24 },
    { header: 'Employee ID', key: 'code', width: 14 },
    { header: 'Opening Casual', key: 'ocl', width: 14 },
    { header: 'Casual Taken', key: 'clt', width: 13 },
    { header: 'Casual Remaining', key: 'clr', width: 16 },
    { header: 'Opening Sick', key: 'osl', width: 13 },
    { header: 'Sick Taken', key: 'slt', width: 11 },
    { header: 'Sick Remaining', key: 'slr', width: 15 },
    { header: 'Opening Earned', key: 'oel', width: 15 },
    { header: 'Earned Taken', key: 'elt', width: 13 },
    { header: 'Earned Remaining', key: 'elr', width: 16 },
    { header: 'LOP', key: 'lop', width: 8 },
    { header: 'Comp Off', key: 'comp', width: 10 },
    { header: 'Total Leave Taken', key: 'tot', width: 17 },
    { header: 'Total Remaining', key: 'totr', width: 15 },
    { header: 'Pending Leave', key: 'pend', width: 13 },
    { header: 'Approved Leave', key: 'appr', width: 14 },
    { header: 'Absent/Unauthorized Days', key: 'absent', width: 22 },
  ];
  for (const r of rows) ws.addRow({
    name: r.employeeName || '—', code: r.employeeCode || '—',
    ocl: dash(r.openingCasual), clt: r.casualTaken, clr: dash(r.casualRemaining),
    osl: dash(r.openingSick), slt: r.sickTaken, slr: dash(r.sickRemaining),
    oel: dash(r.openingEarned), elt: r.earnedTaken, elr: dash(r.earnedRemaining),
    lop: r.lopTaken, comp: r.compOffTaken, tot: r.totalTaken, totr: r.totalRemaining,
    pend: r.pendingLeaveDays, appr: r.approvedLeaveDays, absent: r.absentDays,
  });
  // Header style + auto width (mirrors payroll-reports).
  ws.getRow(1).font = { bold: true };
  ws.getRow(1).eachCell((c) => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD9E8FB' } }; });
  ws.views = [{ state: 'frozen', ySplit: 1 }];
  ws.columns.forEach((col) => {
    let max = col.header ? String(col.header).length : 10;
    col.eachCell({ includeEmpty: false }, (cell) => { const l = cell.value != null ? String(cell.value).length : 0; if (l > max) max = l; });
    col.width = Math.min(Math.max(max + 2, 10), 48);
  });
  return wb;
}

module.exports = {
  // pure
  clampedDays, leaveCategory, computeUsageRow, sortRows,
  // async
  buildSummary, buildWorkbook,
};
