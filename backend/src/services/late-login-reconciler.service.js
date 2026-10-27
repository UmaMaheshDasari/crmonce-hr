/**
 * LEDGER-DRIVEN Late Login CL reconciliation (closes the gaps the forward scanner cannot:
 * out-of-window drift, on-time orphans, residual debits on cancelled/rejected events, and
 * over-debits whose record status isn't `cl_deducted`).
 *
 * It discovers policy CL events from their DURABLE ledger reason keys
 * (`PERMISSION_CL_{PENALTY,REVERSAL,RECON}:<type>:<employee>:<date>`), bounded to a configurable
 * effective-date window, then reconciles each event's CL net toward the net implied by the
 * CURRENT authoritative attendance + permission record — using the existing delta-based,
 * append-only `reconcileEventCL`. It NEVER creates a permission record from ambiguous evidence
 * and NEVER auto-reverses a legitimate employee-submitted deduction; ambiguous/inconsistent
 * cases are reported (counters + structured logs) without touching the balance.
 *
 * NOT a substitute for atomic coordination: it provides eventual consistency on a bounded window,
 * single-instance + sequential (see scheduler integration). Cross-worker atomicity still needs a
 * shared coordinator / schema key (documented in the report).
 */
const d365 = require('./d365.service');
const time = require('./time.util');
const PP = require('./permission-policy.service');
const detect = require('./permission-attendance.util');
const lateLogin = require('./late-login.service');
const shiftHistory = require('./shift-history.service');

const LEDGER = d365.constructor.entities.leaveLedger;
const ATT = d365.constructor.entities.attendance;
const ATT_SELECT = 'hr_hrattendanceid,hr_date,hr_allpunches,hr_intime,hr_outtime,hr_punchcount,_hr_hremployee_value';
const esc = (v) => String(v ?? '').replace(/'/g, "''");
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const addDays = (dateStr, days) => { const d = new Date(`${dateStr}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + Number(days)); return d.toISOString().slice(0, 10); };

const MAX_RECONCILE_WINDOW = 95;   // a bounded discovery horizon (~a quarter); never the whole history
const DISCOVERY_CAP = 20000;       // max ledger rows per getAll query (matches the cap passed below)
function resolveWindow(days) {
  const raw = Number(days != null ? days : process.env.LATE_LOGIN_RECONCILE_DAYS);
  if (!Number.isFinite(raw)) return 35;                                   // default ~a month + buffer
  return Math.min(MAX_RECONCILE_WINDOW, Math.max(1, Math.trunc(raw)));
}

// Query the policy CL ledger rows for [from, to]. getAll returns { data (capped), count (TOTAL
// matched via @odata.count) }, so truncation = count > returned length.
async function queryLedgerWindow(from, to) {
  const res = await d365.getAll(LEDGER, {
    select: 'hr_reason,hr_days,hr_effectivedate,hr_employeeid',
    filter: `startswith(hr_reason,'PERMISSION_CL_') and hr_effectivedate ge '${esc(from)}' and hr_effectivedate le '${esc(to)}'`,
    orderby: 'hr_effectivedate asc',
  }, DISCOVERY_CAP);
  const rows = res.data || [];
  const total = Number(res.count);
  const truncated = Number.isFinite(total) ? total > rows.length : rows.length >= DISCOVERY_CAP;
  return { rows, total: Number.isFinite(total) ? total : rows.length, truncated };
}

// Discover all policy CL rows in [from, to]. If the aggregate query truncates at the cap, fall
// back to BOUNDED per-day sub-queries (≤ window days, ≤ MAX_RECONCILE_WINDOW) so the whole range
// is processed. `partial` is true only if a SINGLE day still exceeds the cap (pathological) — the
// run then explicitly reports partial completion rather than claiming full reconciliation.
async function discoverRows(from, to) {
  const first = await queryLedgerWindow(from, to);
  if (!first.truncated) return { rows: first.rows, truncated: false, partial: false, subdivided: false };
  global.logger?.warn?.(`[late-login-reconcile] discovery cap reached for ${from}..${to} (${first.rows.length}/${first.total}) → subdividing per day`);
  const rows = []; let partial = false; let dayCount = 0;
  for (let d = from; d <= to && dayCount <= MAX_RECONCILE_WINDOW; d = addDays(d, 1), dayCount++) {
    const q = await queryLedgerWindow(d, d);
    rows.push(...q.rows);
    if (q.truncated) { partial = true; global.logger?.error?.(`[late-login-reconcile] single-day cap reached ${d} (${q.rows.length}/${q.total}) — PARTIAL`); }
  }
  return { rows, truncated: true, partial, subdivided: true };
}

// Parse a policy CL ledger reason into its durable event identity. null when not a policy row
// or malformed (validated: known kind, type, parseable employee, real date).
const REASON_RE = /^PERMISSION_CL_(PENALTY|REVERSAL|RECON):([a-z_]+):(.+):(\d{4}-\d{2}-\d{2})(?::.*)?$/;
function parseEventReason(reason) {
  const m = REASON_RE.exec(String(reason || ''));
  if (!m) return null;
  const [, , requestType, employeeId, date] = m;
  if (!employeeId || (requestType !== 'late_login' && requestType !== 'early_logout')) return null;
  // real calendar date?
  const dt = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(dt.getTime()) || dt.toISOString().slice(0, 10) !== date) return null;
  return { requestType, employeeId, date };
}

/**
 * PURE classification for ONE discovered event, from its summed CL ledger `net` (PURE, READ-ONLY).
 * The revised policy applies NO leave/salary penalty, so the reconciler NEVER writes the ledger.
 * A non-zero residual net can ONLY be a LEGACY penalty from the old policy → flag it for an
 * approved remediation plan (never auto-reverse). A zero net needs no action.
 */
function classifyEvent(net) {
  return Math.abs(Number(net) || 0) > 1e-9
    ? { action: 'flag', flag: 'legacy_penalty_requires_review' }
    : { action: 'noop' };
}

/**
 * Scan discovered policy CL ledger rows in [from, to] and REPORT legacy penalty residuals.
 * READ-ONLY: it never debits, reverses, or otherwise mutates the ledger or any record (the new
 * policy has no penalty). Bounded, paginated, cap-visible, per-event isolated. `dryRun` is
 * accepted for API compatibility but the function is read-only either way. Returns a summary +
 * a structured `report` (consumed by the integrity report).
 */
async function reconcileRange({ from, to, dryRun = false } = {}) {
  const summary = { from, to, dryRun: !!dryRun, readOnly: true, events: 0, legacyPenalties: 0, flagged: 0, invalidReason: 0, errors: 0, truncated: false, partial: false, totalMatched: 0, flags: {}, report: [] };
  // 1. Bounded, paginated, cap-visible discovery (ALL employees) with per-day fallback.
  let discovery;
  try { discovery = await discoverRows(from, to); }
  catch (e) { global.logger?.error?.(`[late-login-reconcile] ledger discovery failed: ${e.message}`); summary.errors++; return summary; }
  summary.truncated = discovery.truncated; summary.partial = discovery.partial;

  // 2. Group rows into events + net; dedupe events within the run.
  const events = new Map();   // key → { requestType, employeeId, date, net }
  for (const r of discovery.rows) {
    const ev = parseEventReason(r.hr_reason);
    if (!ev) { summary.invalidReason++; continue; }
    if (!PP.effectiveFor(ev.date)) continue;   // never touch pre-effective events
    const key = `${ev.requestType}:${ev.employeeId}:${ev.date}`;
    const cur = events.get(key) || { ...ev, net: 0 };
    cur.net = round2(cur.net + (Number(r.hr_days) || 0));
    events.set(key, cur);
  }
  summary.totalMatched = events.size;

  // 3. Classify each event (read-only). One failure never aborts the run.
  for (const ev of events.values()) {
    summary.events++;
    try {
      const decision = classifyEvent(ev.net);
      if (decision.action === 'flag') {
        summary.flagged++; summary.legacyPenalties++;
        summary.flags[decision.flag] = (summary.flags[decision.flag] || 0) + 1;
        summary.report.push({ kind: decision.flag, requestType: ev.requestType, employeeId: ev.employeeId, date: ev.date, net: ev.net, needsApprovedRemediation: true });
        global.logger?.warn?.(`[late-login-reconcile] LEGACY PENALTY (net ${ev.net}) needs approved remediation: ${ev.requestType} ${ev.employeeId} ${ev.date}`);
      }
    } catch (e) {
      summary.errors++;
      global.logger?.warn?.(`[late-login-reconcile] ${ev.requestType} ${ev.employeeId} ${ev.date}: ${e.message}`);
    }
  }
  global.logger?.[summary.partial ? 'error' : 'info']?.(`[late-login-reconcile] ${from}..${to}: events ${summary.events}, legacy-penalties ${summary.legacyPenalties}, invalid ${summary.invalidReason}, errors ${summary.errors}, truncated ${summary.truncated}, completion ${summary.partial ? 'PARTIAL' : 'FULL'} (READ-ONLY — no ledger writes)`);
  return summary;
}

/** Daily entry point — scan a bounded recent window ending today (company TZ) for legacy penalties. */
async function runDaily({ endDate, days } = {}) {
  const end = String(endDate || time.istDateStr()).slice(0, 10);
  const from = addDays(end, -(resolveWindow(days) - 1));
  return reconcileRange({ from, to: end });
}

module.exports = { reconcileRange, runDaily, classifyEvent, parseEventReason, resolveWindow, MAX_RECONCILE_WINDOW };
