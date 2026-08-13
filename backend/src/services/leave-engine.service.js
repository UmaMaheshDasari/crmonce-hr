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
const leaveOpening = require('./leave-opening.service');

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
// Entitlement-raising ledger credits: a manual HR 'adjustment' AND the annual
// 'carry_forward' (e.g. Casual Leave carried from last year) both add to entitlement.
function adjustmentsByCategory(ledger) {
  const adj = { casual: 0, sick: 0, compoff: 0 };
  for (const x of ledger) if ((x.kind === 'adjustment' || x.kind === 'carry_forward') && adj[x.category] !== undefined) adj[x.category] += x.days;
  return { casual: r2(adj.casual), sick: r2(adj.sick), compoff: r2(adj.compoff) };
}

// Default max CL days carried to the next year (overridable via Payroll Settings →
// leavePolicy.casualCarryForwardMax). Carry = MIN(clamp0(prev-year CL remaining), max).
const CASUAL_CARRY_FORWARD_MAX = 5;
/** Pure carry-forward formula: MIN(max(0, remaining), max). Negative → 0. */
function casualCarryForward(remaining, max = CASUAL_CARRY_FORWARD_MAX) {
  const r = clamp0(remaining);                 // never carry a negative balance
  return Math.min(r, Math.max(0, r2(max)));    // never carry more than the cap
}

/**
 * Full leave-balance picture for a year. Pure.
 *
 * `opening` folds in the historical (Excel-migrated) opening balance so that
 *   Current Used = Opening Used + in-system leaves.
 * @param {{leaves:Array, ledger:Array, policy:{casual:number,sick:number}, opening?:object}} p
 */
function computeBalance({ leaves = [], ledger = [], policy = {}, opening = {} }) {
  const adj = adjustmentsByCategory(ledger);
  const casualEnt = r2((policy.casual ?? 12) + adj.casual);
  const sickEnt = r2((policy.sick ?? 6) + adj.sick);
  const paidEnt = r2(casualEnt + sickEnt);

  const openCasual = r2(Number(opening.casualUsed) || 0);
  const openSick = r2(Number(opening.sickUsed) || 0);
  const openEarned = r2(Number(opening.earnedUsed) || 0);
  const openLop = r2(Number(opening.lopUsed) || 0);
  const openComp = r2(Number(opening.compOff) || 0);

  const casualUsed = r2(sumDays(leaves, 'casual') + openCasual);
  const sickUsed = r2(sumDays(leaves, 'sick') + openSick);
  const paidUsed = r2(casualUsed + sickUsed);
  const explicitLop = r2(sumDays(leaves, 'lop') + openLop);
  // Earned Leave is uncapped ('other', always paid) — opening earned used is folded
  // into the reported total for reports; it does not consume the CL/SL cap.
  const otherUsed = r2(sumDays(leaves, 'other') + openEarned);

  const casualLop = Math.max(0, casualUsed - casualEnt);
  const sickLop = Math.max(0, sickUsed - sickEnt);

  // Opening comp-off is credited as if earned; comp-off usage stays in the ledger.
  const compEarned = r2(sumLedger(ledger, 'comp_off_earned') + openComp);
  const compUsed = r2(sumLedger(ledger, 'comp_off_used'));

  return {
    casual: { entitled: casualEnt, used: casualUsed, remaining: clamp0(casualEnt - casualUsed), openingUsed: openCasual },
    sick: { entitled: sickEnt, used: sickUsed, remaining: clamp0(sickEnt - sickUsed), openingUsed: openSick },
    paid: { entitled: paidEnt, used: paidUsed, remaining: clamp0(paidEnt - paidUsed) },
    compOff: { earned: compEarned, used: compUsed, balance: clamp0(compEarned - compUsed) },
    lop: { fromLeave: r2(casualLop + sickLop + explicitLop) },
    otherPaidUsed: otherUsed,
    earned: { used: otherUsed, openingUsed: openEarned },
    opening: { casualUsed: openCasual, sickUsed: openSick, earnedUsed: openEarned, lopUsed: openLop, compOff: openComp },
    adjustments: adj,
  };
}

/**
 * Split ONE month's approved leave into paid vs LOP, honouring the annual paid
 * cap consumed by earlier months (chronological consumption). Pure.
 * @returns {{paidLeaveDays:number, lopLeaveDays:number}}
 */
function computeMonthSplit({ leaves = [], policy = {}, adjustments = {}, month, opening = {} }) {
  const paidEnt = r2((policy.casual ?? 12) + (policy.sick ?? 6) + (adjustments.casual || 0) + (adjustments.sick || 0));
  const paidLeaves = leaves
    .filter((l) => l.category === 'casual' || l.category === 'sick')
    .sort((a, b) => String(a.date).localeCompare(String(b.date)));

  // Opening (historical) CL+SL already consumed part of the annual paid cap.
  let consumed = r2((Number(opening.casualUsed) || 0) + (Number(opening.sickUsed) || 0));
  let monthPaid = 0, monthLop = 0;
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

/**
 * PENDING leave working-days for one employee/month. A pending (undecided) leave is
 * NOT paid yet and must NOT be auto-converted to LOP while approval is pending — it is
 * held out of BOTH Payable and LOP until the decision (approved → paid, rejected → LOP).
 * Never throws (payroll must not be blocked by the leave engine).
 */
async function pendingMonthDays(employeeId, { year, month }) {
  try {
    const pending = toValue('hr_leave_status', 'pending');
    const { data } = await d365.getList(LEAVE, {
      select: 'hr_days,hr_fromdate,hr_todate,hr_status,hr_leavetype',
      filter: `_hr_hremployee_value eq '${employeeId}' and hr_status eq ${pending}`,
      top: 500,
    });
    let days = 0;
    for (const l of normalizeLeaves(data, year)) if (l.month === month) days += l.days;
    return r2(days);
  } catch { return 0; }
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
    const [leaves, ledger, policy, opening] = await Promise.all([
      fetchApprovedLeaves(employeeId, y).catch(() => []),
      fetchLedger(employeeId, y),
      getPolicy(),
      leaveOpening.getOpening(employeeId, y).catch(() => ({})),
    ]);
    return { employeeId, year: Number(y), ...computeBalance({ leaves, ledger, policy, opening }) };
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
    const [leaves, ledger, policy, opening] = await Promise.all([
      fetchApprovedLeaves(employeeId, year),
      fetchLedger(employeeId, year),
      getPolicy(),
      leaveOpening.getOpening(employeeId, year).catch(() => ({})),
    ]);
    const adjustments = adjustmentsByCategory(ledger);
    return computeMonthSplit({ leaves, policy, adjustments, month: Number(month), opening });
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

// ── Casual Leave annual carry-forward ─────────────────────────────────────────

/** Has a CL carry-forward ledger entry already been written for this employee/year?
 *  This is the idempotency guard — a re-run must never double-credit. */
async function carryForwardExists(employeeId, year) {
  try {
    const { data } = await d365.getList(LEDGER, {
      select: 'hr_leaveledgerid',
      filter: `hr_employeeid eq '${employeeId}' and hr_year eq '${year}' and hr_kind eq 'carry_forward' and hr_category eq 'casual'`,
      top: 1,
    });
    return !!(data && data[0]);
  } catch { return false; }   // table not provisioned / read failed → treat as "not yet" (guard is best-effort)
}

/**
 * Year-end Casual Leave carry-forward for ALL active employees:
 *   carry = MIN(clamp0(prev-year CL remaining), casualCarryForwardMax)   [default max 5]
 * Written as ONE ledger row (kind 'carry_forward', category 'casual') dated
 * toYear-01-01, which raises next year's CL entitlement (12 + carry) via
 * adjustmentsByCategory. IDEMPOTENT: an employee who already has a carry_forward row
 * for toYear is skipped, so running twice never adds days twice. Never throws.
 */
async function rollCasualLeaveForward({ fromYear, toYear, createdBy = 'Year-End Rollover', employees } = {}) {
  const fy = Number(fromYear);
  const ty = Number(toYear || fy + 1);
  if (!fy || !ty) { const e = new Error('fromYear (and toYear) are required'); e.status = 400; throw e; }
  const policy = await getPolicy();
  const max = Number(policy.casualCarryForwardMax) || CASUAL_CARRY_FORWARD_MAX;

  let emps = employees;
  if (!emps) {
    try {
      const { data } = await d365.getList(EMP, {
        select: 'hr_hremployeeid,hr_hremployee1',
        filter: `hr_status eq ${toValue('hr_employee_status', 'active')}`,
        top: 5000,
      });
      emps = data || [];
    } catch (e) { global.logger?.error?.(`[leave-carryforward] employee read failed: ${e.message}`); return { fromYear: fy, toYear: ty, max, processed: 0, carried: 0, skipped: 0, totalDays: 0 }; }
  }

  let carried = 0, skipped = 0, totalDays = 0;
  for (const emp of emps) {
    const id = emp.hr_hremployeeid;
    if (!id) continue;
    try {
      if (await carryForwardExists(id, ty)) { skipped++; continue; }          // already processed → idempotent
      const bal = await getBalance(id, fy);
      const days = casualCarryForward(bal?.casual?.remaining, max);
      if (days <= 0) continue;                                                 // nothing to carry (0 is a no-op)
      await addLedgerEntry({
        employeeId: id, employeeName: emp.hr_hremployee1, year: ty,
        kind: 'carry_forward', category: 'casual', days,
        effectiveDate: `${ty}-01-01`, reason: `Casual Leave carry-forward from ${fy} (max ${max})`, createdBy,
      });
      carried++; totalDays = r2(totalDays + days);
    } catch (e) { global.logger?.warn?.(`[leave-carryforward] ${id} failed: ${e.message}`); }
  }
  global.logger?.info?.(`[leave-carryforward] ${fy}→${ty}: processed ${emps.length}, carried ${carried}, skipped(existing) ${skipped}, days ${totalDays}`);
  return { fromYear: fy, toYear: ty, max, processed: emps.length, carried, skipped, totalDays };
}

module.exports = {
  // pure
  categoryOfType, normalizeLeaves, normalizeLedger, adjustmentsByCategory,
  computeBalance, computeMonthSplit, casualCarryForward, CASUAL_CARRY_FORWARD_MAX,
  // async
  getBalance, splitMonthLeave, pendingMonthDays, addLedgerEntry, readLedger,
  carryForwardExists, rollCasualLeaveForward,
};
