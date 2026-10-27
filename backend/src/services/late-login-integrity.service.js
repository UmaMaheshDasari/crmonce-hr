/**
 * READ-ONLY HR/Admin integrity report for the Late Login monthly policy + CL reconciliation.
 *
 * Composes existing read-only sources — it performs NO writes of any kind:
 *   • B/C (ledger-net discrepancies + unresolved flags): the existing reconciler in DRY-RUN mode
 *     (`reconcileRange({ dryRun:true })`), which never appends ledger rows, never reverses/deducts
 *     CL, never creates/cancels permission records, never touches attendance or sends notifications.
 *   • A (negative CL balances): the authoritative `leaveEngine.getBalance` per ACTIVE employee —
 *     a read-only, bounded, per-employee scan (documented cost + cap).
 *   • D (daily run health): run history is NOT persisted anywhere, so this is reported as
 *     UNAVAILABLE with the prerequisite — never a fabricated success/failure.
 *
 * The report surfaces CURRENT RECOMPUTED findings (not a durable historical queue) and requires
 * human HR review — it changes nothing on its own.
 */
const time = require('./time.util');
const reconciler = require('./late-login-reconciler.service');
const scanner = require('./late-login-scanner.service');
const leaveEngine = require('./leave-engine.service');
const runHistoryService = require('./late-login-run-history.service');

// Category D — daily run health from the INTERIM run-history store (single-host JSONL). When the
// store is unavailable (disabled / ephemeral FS / this host never ran the scheduler) it is
// reported as such — never fabricated as a success/failure.
function runHistorySummary() {
  try {
    const h = runHistoryService.list({ limit: 20 });
    if (!h.available) return { available: false, store: h.store, note: h.note };
    const latest = (t) => h.runs.find(r => r.jobType === t) || null;
    const brief = (r) => (r ? { status: r.status, finishedAt: r.finishedAt, window: r.window, errorCount: r.errorCount, partial: r.partial } : null);
    return { available: true, store: h.store, note: h.note, latestScanner: brief(latest('scanner')), latestReconciler: brief(latest('reconciler')), recentCount: h.total };
  } catch (e) {
    return { available: false, note: `Run history unreadable on this host: ${e.message}` };
  }
}

const MAX_RANGE_DAYS = 95;            // bounded discovery horizon (matches the reconciler)
const BALANCE_SCAN_EMPLOYEE_CAP = 1500;   // refuse an unbounded balance scan beyond this many employees
const addDays = (dateStr, days) => { const d = new Date(`${dateStr}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + Number(days)); return d.toISOString().slice(0, 10); };
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')) && !Number.isNaN(new Date(`${s}T00:00:00Z`).getTime());

// Which recomputed categories need HR action vs. are informational (auto-reconciles next run).
// Categories needing HR action. Under the revised (no-penalty) policy the reconciler only emits
// `legacy_penalty_requires_review` (old-policy CL residuals awaiting an approved remediation plan);
// negative_cl_balance comes from the balance scan. (The former CL-refund categories no longer occur.)
const ACTION_CATEGORIES = new Set(['legacy_penalty_requires_review', 'negative_cl_balance']);

/** Validate + bound the requested window. Returns { from, to } or throws a 400-shaped error. */
function resolveRange({ from, to } = {}) {
  const today = time.istDateStr();
  let end = to && isDate(to) ? to : today;
  let start = from && isDate(from) ? from : addDays(end, -34);   // default ~last 35 days
  if (start > end) { const e = new Error('`from` must be on or before `to`.'); e.status = 400; throw e; }
  // Clamp an over-long range to the max horizon (keeps the scan bounded).
  if (addDays(start, MAX_RANGE_DAYS) < end) start = addDays(end, -(MAX_RANGE_DAYS - 1));
  return { from: start, to: end };
}

/** Negative CL balances across ACTIVE employees (read-only; bounded + capped). */
async function negativeBalances() {
  const year = Number(time.istDateStr().slice(0, 4));
  let emps = [];
  try { emps = await scanner.activeEmployees(); } catch { emps = []; }
  if (emps.length > BALANCE_SCAN_EMPLOYEE_CAP) {
    return { available: false, scanned: 0, findings: [], note: `Balance scan skipped: ${emps.length} active employees exceeds the ${BALANCE_SCAN_EMPLOYEE_CAP} cap (would be an excessively expensive employee-wide scan). Run on a narrower employee set or add a balance index.` };
  }
  const findings = [];
  let scanned = 0, errors = 0;
  for (const e of emps) {
    try {
      const bal = await leaveEngine.getBalance(e.hr_hremployeeid, year);
      scanned++;
      const remaining = Number(bal?.casual?.remaining);
      if (Number.isFinite(remaining) && remaining < 0) {
        findings.push({ category: 'negative_cl_balance', needsAction: true, employeeId: e.hr_hremployeeid, employeeName: e.hr_hremployee1 || '', currentBalance: remaining, year });
      }
    } catch { errors++; }
  }
  return { available: true, scanned, errors, findings, note: `Per-employee read via leaveEngine.getBalance (year ${year}); O(active employees) cost — intended for on-demand HR use.` };
}

/**
 * Build the full integrity report. `opts`: { from, to, eventType, category, page, pageSize,
 * includeBalances }. Pure of side effects (dry-run reconcile + read-only balance scan).
 */
async function buildReport(opts = {}) {
  const { from, to } = resolveRange(opts);
  const page = Math.max(1, Math.trunc(Number(opts.page) || 1));
  const pageSize = Math.min(200, Math.max(1, Math.trunc(Number(opts.pageSize) || 50)));
  const eventType = (opts.eventType === 'late_login' || opts.eventType === 'early_logout') ? opts.eventType : undefined;
  const wantCategory = opts.category ? String(opts.category) : undefined;

  // B/C — dry-run reconciliation (READ-ONLY). Names fetched once for display.
  let employeesById = null;
  try { const emps = await scanner.activeEmployees(); employeesById = new Map((emps || []).map(e => [e.hr_hremployeeid, e])); } catch { /* names optional */ }
  const dry = await reconciler.reconcileRange({ from, to, employeesById, dryRun: true });

  const nameOf = (id) => employeesById?.get?.(id)?.hr_hremployee1 || '';
  let findings = (dry.report || []).map((r) => ({
    category: r.kind,
    needsAction: ACTION_CATEGORIES.has(r.kind),
    employeeId: r.employeeId,
    employeeName: nameOf(r.employeeId),
    date: r.date,
    eventType: r.requestType,
    currentNet: r.net,
    expectedNet: r.desiredNet != null ? r.desiredNet : null,
    expectedNetNote: r.desiredNet == null ? 'Expected net cannot be determined (ambiguous tier / needs attendance finalisation)' : undefined,
    status: r.status,
  }));

  // A — negative balances (optional; default on).
  let balances = { available: false, scanned: 0, findings: [], note: 'Not requested.' };
  if (opts.includeBalances !== false && !eventType) {
    balances = await negativeBalances();
    findings = findings.concat(balances.findings);
  }

  // Filters (balances already excluded when eventType is set — includeBalances is gated on !eventType).
  if (eventType) findings = findings.filter(f => f.eventType === eventType);
  if (wantCategory) findings = findings.filter(f => f.category === wantCategory);

  // Summary (before pagination).
  const byCategory = {};
  for (const f of findings) byCategory[f.category] = (byCategory[f.category] || 0) + 1;
  const total = findings.length;
  const pageItems = findings.slice((page - 1) * pageSize, page * pageSize);

  return {
    generatedAt: new Date().toISOString(),
    range: { from, to },
    summary: {
      total,
      needsAction: findings.filter(f => f.needsAction).length,
      byCategory,
      truncated: !!dry.truncated,
      partial: !!dry.partial,
    },
    findings: pageItems,
    page, pageSize, totalFindings: total,
    balances: { available: balances.available, scanned: balances.scanned, note: balances.note },
    runHistory: runHistorySummary(),
    dataSources: {
      discrepanciesAndFlags: 'reconcileRange(dryRun:true) — read-only recomputation of CURRENT findings, not a durable historical queue',
      negativeBalances: 'leaveEngine.getBalance per active employee (read-only, bounded)',
    },
    readOnly: true,
  };
}

module.exports = { buildReport, resolveRange, negativeBalances, MAX_RANGE_DAYS, BALANCE_SCAN_EMPLOYEE_CAP, ACTION_CATEGORIES };
