/**
 * Leave Engine — leave balances, comp-off, and the paid-vs-LOP split that feeds
 * Payroll.
 *
 * Company policy (from Payroll Settings, never hardcoded):
 *   12 Casual + 6 Sick = 18 Paid Leaves / year. Beyond that → Loss of Pay (LOP).
 *
 * Sources of truth:
 *   - Leave USAGE  → hr_hrleaves (approved), categorised by leave type.
 *   - Comp-off + manual ADJUSTMENTS → hr_leaveledgers (this module's ledger).
 *   - Entitlements → Payroll Settings resolve().leavePolicy.
 *
 * The pure functions (computeBalance / computeMonthSplit) take already-fetched
 * data so they're unit-testable with no network.
 */
const d365 = require('./d365.service');
const { toValue, toLabel } = require('./picklist');
const { resolveDays } = require('./leave-summary.util');
const payrollSettings = require('./payroll-settings.service');

const LEAVE = d365.constructor.entities.leave;
const LEDGER = d365.constructor.entities.leaveLedger;
const EMP = d365.constructor.entities.employee;

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const clamp0 = (n) => Math.max(0, r2(n));

// Leave-type label → engine category.
function categoryOfType(typeLabel) {
  switch (String(typeLabel || '')) {
    case 'Casual Leave': return 'casual';
    case 'Sick Leave': return 'sick';
    case 'LOP': return 'lop';
    default: return 'other';   // Earned / Maternity / Paternity — paid, own policy, not vs the 18
  }
}

/** Raw hr_hrleaves rows → normalized { category, days, month, date }. */
function normalizeLeaves(rows, year) {
  const out = [];
  for (const l of rows || []) {
    const from = String(l.hr_fromdate || '').slice(0, 10);
    if (year && from.slice(0, 4) !== String(year)) continue;
    out.push({
      category: categoryOfType(toLabel('hr_leave_type', l.hr_leavetype)),
      days: Number(resolveDays(l.hr_days, l.hr_fromdate, l.hr_todate)) || 0,
      month: Number(from.slice(5, 7)) || 0,
      date: from,
    });
  }
  return out;
}

/** Raw hr_leaveledgers rows → normalized { kind, category, days }. */
function normalizeLedger(rows) {
  return (rows || []).map((x) => ({
    kind: x.hr_kind || '',
    category: x.hr_category || '',
    days: Number(x.hr_days) || 0,
    date: String(x.hr_effectivedate || '').slice(0, 10),
    reason: x.hr_reason || '',
    createdBy: x.hr_createdby || '',
  }));
}

const sumDays = (leaves, cat) => leaves.filter((l) => l.category === cat).reduce((s, l) => s + l.days, 0);
const sumLedger = (ledger, kind) => ledger.filter((x) => x.kind === kind).reduce((s, x) => s + x.days, 0);
function adjustmentsByCategory(ledger) {
  const adj = { casual: 0, sick: 0, compoff: 0 };
  for (const x of ledger) if (x.kind === 'adjustment' && adj[x.category] !== undefined) adj[x.category] += x.days;
  return { casual: r2(adj.casual), sick: r2(adj.sick), compoff: r2(adj.compoff) };
}

/**
 * Full leave-balance picture for a year. Pure.
 * @param {{leaves:Array, ledger:Array, policy:{casual:number,sick:number}}} p
 */
function computeBalance({ leaves = [], ledger = [], policy = {} }) {
  const adj = adjustmentsByCategory(ledger);
  const casualEnt = r2((policy.casual ?? 12) + adj.casual);
  const sickEnt = r2((policy.sick ?? 6) + adj.sick);
  const paidEnt = r2(casualEnt + sickEnt);

  const casualUsed = r2(sumDays(leaves, 'casual'));
  const sickUsed = r2(sumDays(leaves, 'sick'));
  const paidUsed = r2(casualUsed + sickUsed);
  const explicitLop = r2(sumDays(leaves, 'lop'));
  const otherUsed = r2(sumDays(leaves, 'other'));

  const casualLop = Math.max(0, casualUsed - casualEnt);
  const sickLop = Math.max(0, sickUsed - sickEnt);

  const compEarned = r2(sumLedger(ledger, 'comp_off_earned'));
  const compUsed = r2(sumLedger(ledger, 'comp_off_used'));

  return {
    casual: { entitled: casualEnt, used: casualUsed, remaining: clamp0(casualEnt - casualUsed) },
    sick: { entitled: sickEnt, used: sickUsed, remaining: clamp0(sickEnt - sickUsed) },
    paid: { entitled: paidEnt, used: paidUsed, remaining: clamp0(paidEnt - paidUsed) },
    compOff: { earned: compEarned, used: compUsed, balance: clamp0(compEarned - compUsed) },
    lop: { fromLeave: r2(casualLop + sickLop + explicitLop) },
    otherPaidUsed: otherUsed,
    adjustments: adj,
  };
}

/**
 * Split ONE month's approved leave into paid vs LOP, honouring the annual paid
 * cap consumed by earlier months (chronological consumption). Pure.
 * @returns {{paidLeaveDays:number, lopLeaveDays:number}}
 */
function computeMonthSplit({ leaves = [], policy = {}, adjustments = {}, month }) {
  const paidEnt = r2((policy.casual ?? 12) + (policy.sick ?? 6) + (adjustments.casual || 0) + (adjustments.sick || 0));
  const paidLeaves = leaves
    .filter((l) => l.category === 'casual' || l.category === 'sick')
    .sort((a, b) => String(a.date).localeCompare(String(b.date)));

  let consumed = 0, monthPaid = 0, monthLop = 0;
  for (const l of paidLeaves) {
    const remaining = Math.max(0, paidEnt - consumed);
    const paidPart = Math.min(l.days, remaining);
    consumed += paidPart;
    if (l.month === month) { monthPaid += paidPart; monthLop += l.days - paidPart; }
  }
  // Explicit LOP-type leave in the month is entirely LOP.
  for (const l of leaves) if (l.category === 'lop' && l.month === month) monthLop += l.days;
  // Earned/Maternity/Paternity ('other') stay fully paid (their own policy, not vs 18).
  for (const l of leaves) if (l.category === 'other' && l.month === month) monthPaid += l.days;

  return { paidLeaveDays: r2(monthPaid), lopLeaveDays: r2(monthLop) };
}

// ── Async data access ─────────────────────────────────────────────

async function fetchApprovedLeaves(employeeId, year) {
  const approved = toValue('hr_leave_status', 'approved');
  const { data } = await d365.getList(LEAVE, {
    select: 'hr_days,hr_fromdate,hr_todate,hr_status,hr_leavetype',
    filter: `_hr_hremployee_value eq '${employeeId}' and hr_status eq ${approved}`,
    top: 500,
  });
  return normalizeLeaves(data, year);
}

async function fetchLedger(employeeId, year) {
  try {
    const { data } = await d365.getList(LEDGER, {
      select: 'hr_kind,hr_category,hr_days,hr_effectivedate,hr_reason,hr_createdby,hr_year',
      filter: `hr_employeeid eq '${employeeId}' and hr_year eq '${year}'`,
      top: 500,
    });
    return normalizeLedger(data);
  } catch { return []; }   // table not provisioned yet → no ledger entries
}

async function getPolicy() {
  try { return (await payrollSettings.getResolved()).leavePolicy; }
  catch { return { paidPerYear: 18, casual: 12, sick: 6 }; }
}

/** Full balance for an employee/year (for the dashboard). Never throws. */
async function getBalance(employeeId, year) {
  const y = year || new Date().getFullYear();
  try {
    const [leaves, ledger, policy] = await Promise.all([
      fetchApprovedLeaves(employeeId, y).catch(() => []),
      fetchLedger(employeeId, y),
      getPolicy(),
    ]);
    return { employeeId, year: Number(y), ...computeBalance({ leaves, ledger, policy }) };
  } catch (e) {
    global.logger?.warn?.(`[leave-engine] getBalance failed for ${employeeId}: ${e.message}`);
    const policy = await getPolicy();
    return { employeeId, year: Number(y), ...computeBalance({ leaves: [], ledger: [], policy }) };
  }
}

/**
 * Paid-vs-LOP split for payroll (one employee/month). Falls back to "all leave
 * paid" (legacy behaviour) if anything is unavailable — never throws, so payroll
 * is never blocked or broken by the leave engine.
 */
async function splitMonthLeave(employeeId, { year, month }) {
  try {
    const [leaves, ledger, policy] = await Promise.all([
      fetchApprovedLeaves(employeeId, year),
      fetchLedger(employeeId, year),
      getPolicy(),
    ]);
    const adjustments = adjustmentsByCategory(ledger);
    return computeMonthSplit({ leaves, policy, adjustments, month: Number(month) });
  } catch (e) {
    global.logger?.warn?.(`[leave-engine] splitMonthLeave fallback for ${employeeId}: ${e.message}`);
    // Legacy fallback: sum approved leave in the month, all treated as paid.
    try {
      const leaves = await fetchApprovedLeaves(employeeId, year);
      const paid = leaves.filter((l) => l.month === Number(month)).reduce((s, l) => s + l.days, 0);
      return { paidLeaveDays: r2(paid), lopLeaveDays: 0 };
    } catch { return { paidLeaveDays: 0, lopLeaveDays: 0 }; }
  }
}

/** Append a ledger entry (comp-off grant/usage or manual adjustment). */
async function addLedgerEntry({ employeeId, employeeName, year, kind, category, days, effectiveDate, reason, createdBy }) {
  const body = {
    hr_name: `${employeeName || employeeId} · ${kind} · ${effectiveDate || ''}`.slice(0, 250),
    hr_employeeid: String(employeeId),
    hr_employeename: employeeName || '',
    hr_year: String(year),
    hr_kind: kind,
    hr_category: category || 'compoff',
    hr_days: String(days),
    hr_effectivedate: effectiveDate || '',
    hr_reason: reason || '',
    hr_createdby: createdBy || '',
  };
  return d365.create(LEDGER, body);
}

async function readLedger(employeeId, year) {
  const ledger = await fetchLedger(employeeId, year);
  return ledger;
}

module.exports = {
  // pure
  categoryOfType, normalizeLeaves, normalizeLedger, adjustmentsByCategory,
  computeBalance, computeMonthSplit,
  // async
  getBalance, splitMonthLeave, addLedgerEntry, readLedger,
};
