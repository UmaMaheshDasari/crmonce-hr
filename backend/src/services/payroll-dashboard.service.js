/**
 * Payroll Dashboard aggregation — PURE (no I/O, unit-tested). The route fetches
 * payroll rows + employees + approved leaves and hands them here; this computes
 * the cards, the department/monthly/LOP/leave/advance series, and the status
 * pipeline, honouring the month / department / employee filters.
 */
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const n = (v) => Number(v) || 0;

// One payroll row's pipeline state. Locked takes precedence (it's a terminal lock
// on top of any status), so a row is counted once.
function stateOf(row) {
  if (row.locked) return 'locked';
  const s = row.status;
  if (s === 'paid') return 'paid';
  if (s === 'processed') return 'approved';
  return 'draft';
}
const isFinalised = (row) => ['approved', 'paid', 'locked'].includes(stateOf(row));

/**
 * @param {object} p
 * @param {Array}  p.rows       payroll rows: { month, gross, net, lop, advance, status, locked, employeeId }
 * @param {Array}  p.employees  active employees: { id, department }
 * @param {Array}  p.leaves     approved leaves in the year: { month, days, employeeId, department }
 * @param {object} p.filters    { month, department, employeeId }
 */
function aggregate({ rows = [], employees = [], leaves = [], filters = {} } = {}) {
  const { month, department, employeeId } = filters;

  // Employee-scope: department / employee filters apply everywhere.
  const empMatch = (id, dept) =>
    (!department || dept === department) && (!employeeId || id === employeeId);

  const deptOf = new Map(employees.map((e) => [e.id, e.department || 'Unassigned']));
  const scopedRows = rows.filter((r) => empMatch(r.employeeId, r.department || deptOf.get(r.employeeId)));
  const scopedLeaves = leaves.filter((l) => empMatch(l.employeeId, l.department || deptOf.get(l.employeeId)));

  // Period rows = scoped, and month-limited when a month is chosen (cards, dept,
  // status). Trends always span all 12 months (month filter ignored there).
  const periodRows = month ? scopedRows.filter((r) => r.month === Number(month)) : scopedRows;

  // ── Cards ──
  const totalEmployees = employees.filter((e) => !department || e.department === department).length;
  const processedPayroll = periodRows.filter(isFinalised).length;
  const pendingPayroll = periodRows.filter((r) => stateOf(r) === 'draft').length;
  const totalGross = periodRows.reduce((s, r) => s + n(r.gross), 0);
  const totalNet = periodRows.reduce((s, r) => s + n(r.net), 0);
  const totalDeductions = periodRows.reduce((s, r) => s + Math.max(0, n(r.gross) - n(r.net)), 0);

  // ── Department Salary (period) ──
  const deptMap = new Map();
  for (const r of periodRows) {
    const d = r.department || deptOf.get(r.employeeId) || 'Unassigned';
    const cur = deptMap.get(d) || { department: d, gross: 0, net: 0 };
    cur.gross += n(r.gross); cur.net += n(r.net);
    deptMap.set(d, cur);
  }
  const departmentSalary = [...deptMap.values()]
    .map((x) => ({ ...x, gross: Math.round(x.gross), net: Math.round(x.net) }))
    .sort((a, b) => b.net - a.net);

  // ── Monthly series (all 12 months, scoped but NOT month-limited) ──
  const blank = () => MONTHS.map((label, i) => ({ month: i + 1, label, gross: 0, net: 0, deductions: 0, lop: 0, leave: 0, advance: 0 }));
  const series = blank();
  for (const r of scopedRows) {
    const idx = (Number(r.month) || 1) - 1;
    if (idx < 0 || idx > 11) continue;
    series[idx].gross += n(r.gross);
    series[idx].net += n(r.net);
    series[idx].deductions += Math.max(0, n(r.gross) - n(r.net));
    series[idx].lop += n(r.lop);
    series[idx].advance += n(r.advance);
  }
  for (const l of scopedLeaves) {
    const idx = (Number(l.month) || 1) - 1;
    if (idx >= 0 && idx <= 11) series[idx].leave += n(l.days);
  }
  for (const s of series) { s.gross = Math.round(s.gross); s.net = Math.round(s.net); s.deductions = Math.round(s.deductions); s.lop = Math.round(s.lop); s.advance = Math.round(s.advance); s.leave = Math.round(s.leave * 10) / 10; }

  // ── Status pipeline (period) ──
  const statusPipeline = { draft: 0, processing: 0, approved: 0, locked: 0, paid: 0 };
  for (const r of periodRows) statusPipeline[stateOf(r)] += 1;

  return {
    cards: { totalEmployees, processedPayroll, pendingPayroll, totalGross: Math.round(totalGross), totalDeductions: Math.round(totalDeductions), totalNet: Math.round(totalNet) },
    departmentSalary,
    monthly: series,
    statusPipeline,
  };
}

module.exports = { aggregate, stateOf, isFinalised, MONTHS };
