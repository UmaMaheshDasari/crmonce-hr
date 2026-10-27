/**
 * Monthly permission policy for Late Login and Early Logout (effective 2026-11-01).
 *
 * Applied SEPARATELY to each request type, per employee + calendar month, by counting the
 * employee's QUALIFYING events in that month (a rejected 3rd request and cancellations never
 * count). The Nth qualifying event decides the outcome:
 *   • 1st, 2nd  → auto_approved (no manager approval; employee notified)
 *   • 3rd       → manager_pending (warning + manager approval required)
 *   • 4th+       → 0.5-day Casual Leave debit if the balance allows; otherwise hr_review
 *                 (salary deduction is DEFERRED — the system has no authoritative late/early
 *                  minutes→money formula, so none is invented here).
 *
 * The 2-hour maximum on a permission REQUEST is enforced elsewhere (late-login.service) and is
 * independent of this tiering. This module is the policy brain + the idempotent CL debit; it
 * never inserts/modifies attendance punches.
 */
const leaveEngine = require('./leave-engine.service');

// Configuration (spec §4). Defaults live here; a future settings-backed override can replace
// POLICY without touching callers. Kept as ONE source of truth — no duplicate config system.
const POLICY = {
  effectiveFrom: process.env.PERMISSION_POLICY_EFFECTIVE_FROM || '2026-11-01',
  // Revised policy (no financial/leave penalty): EVERY qualifying event is auto-approved; only
  // the NOTIFICATION stage escalates. 1st–3rd: auto, no escalation email. 4th: HR warning. 5th:
  // Super Admin final warning. 6th+: HR/manager escalation (repeated, email-idempotent).
  hrWarningAt: 4,
  finalWarningAt: 5,
  escalationFrom: 6,
  // NOTE: no CL/salary deduction is ever applied by this policy. The clPerEvent/managerApproval
  // tiers were REMOVED; the ledger helpers below remain only to DETECT & report legacy penalties.
  clPerEvent: 0.5,   // retained solely so legacy-penalty detection/reporting keeps its unit
};

// Statuses a post-policy record can hold. Legacy ('submitted'/'completed'/…) are untouched.
const STATUS = {
  AUTO_APPROVED: 'auto_approved',
  MANAGER_PENDING: 'manager_pending',
  MANAGER_APPROVED: 'manager_approved',
  MANAGER_REJECTED: 'manager_rejected',
  CL_DEDUCTED: 'cl_deducted',
  HR_REVIEW: 'hr_review',
};
// A rejected 3rd event and cancellations do NOT count toward the monthly tally (spec §2.3).
const NON_QUALIFYING = new Set(['cancelled', 'rejected', STATUS.MANAGER_REJECTED]);
const isQualifying = (status) => !NON_QUALIFYING.has(String(status || ''));

/** Does the monthly policy apply to this event date? (Not retroactive before the effective date.) */
function effectiveFor(dateStr) {
  const ds = String(dateStr || '').slice(0, 10);
  return !!ds && ds >= POLICY.effectiveFrom;
}

/** The NOTIFICATION stage for the Nth qualifying event (PURE). No penalty is ever implied. */
function stageFor(n) {
  if (n === POLICY.hrWarningAt) return 'hr_warning';        // 4th
  if (n === POLICY.finalWarningAt) return 'final_warning';  // 5th
  if (n >= POLICY.escalationFrom) return 'escalation';      // 6th and every subsequent
  return null;                                              // 1st–3rd: auto-approved, no email stage
}

/**
 * Decide the outcome for the Nth qualifying event (PURE). `priorQualifying` = how many
 * qualifying events the employee already has this month for this type (0-based); N = that + 1.
 * Under the revised policy EVERY event is auto-approved with NO leave/salary penalty; only the
 * notification `stage` escalates. Returns { n, outcome:'auto_approved', stage }.
 */
function decide(priorQualifying) {
  const n = (Number(priorQualifying) || 0) + 1;
  return { n, outcome: 'auto_approved', stage: stageFor(n) };
}

// Stable idempotency key for an event's CL debit — ONE debit per (type, employee, DATE) ever,
// regardless of whether the event came from a permission request or an auto-detected punch, so
// the request path and the scanner can never both debit the same real-world event.
const clReason = (requestType, employeeId, date) => `PERMISSION_CL_PENALTY:${requestType}:${employeeId}:${String(date || '').slice(0, 10)}`;
const clReversalReason = (requestType, employeeId, date) => `PERMISSION_CL_REVERSAL:${requestType}:${employeeId}:${String(date || '').slice(0, 10)}`;
// Prefix for additional reconciliation rows (after the first debit/reversal) — each row is
// UNIQUE (append-only) so audit history is never rewritten, while the DELTA logic keeps the net
// correct across any number of attendance-correction flips.
const clReconPrefix = (requestType, employeeId, date) => `PERMISSION_CL_RECON:${requestType}:${employeeId}:${String(date || '').slice(0, 10)}:`;
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const rrn = (x) => String(x?.hr_reason || x?.reason || '');
// Every CL ledger row that belongs to ONE event (penalty, reversal, or recon).
function isEventCLRow(reason, requestType, employeeId, ds) {
  return reason === clReason(requestType, employeeId, ds)
    || reason === clReversalReason(requestType, employeeId, ds)
    || reason.startsWith(clReconPrefix(requestType, employeeId, ds));
}

/**
 * Reconcile the CL ledger for ONE qualifying event to its DESIRED net (−0.5 when the final
 * authoritative outcome is a deduction, 0 otherwise) — the single source of truth for both the
 * forward debit and every correction/reversal. It SUMS all of the event's existing CL rows
 * (append-only audit), computes `delta = desiredNet − appliedNet`, and appends ONE compensating
 * adjustment only when delta ≠ 0. This is idempotent (a stable state writes nothing, so repeated
 * scans / repeated correction processing are no-ops) and multi-flip-safe (late→on-time→late→…
 * always converges to the correct net), NEVER reverses more than was debited (delta is exact),
 * NEVER double-debits, and NEVER drives the balance negative (a further debit is balance-checked).
 * Returns { outcome:'cl_deducted'|'hr_review'|'reversed'|'none', changed, appliedNet, delta }.
 */
async function reconcileEventCL({ employeeId, employeeName, date, requestType, desiredNet, createdBy }) {
  const ds = String(date || '').slice(0, 10);
  const year = Number(ds.slice(0, 4));
  const want = round2(desiredNet);
  try {
    const ledger = await leaveEngine.readLedger(employeeId, year).catch(() => []);
    const rows = (ledger || []).filter((x) => isEventCLRow(rrn(x), requestType, employeeId, ds));
    const appliedNet = round2(rows.reduce((s, x) => s + (Number(x.hr_days ?? x.days) || 0), 0));
    const delta = round2(want - appliedNet);
    const deducted = () => (appliedNet <= -POLICY.clPerEvent + 1e-9);
    if (Math.abs(delta) < 1e-9) {
      // Already at the desired net → no write (idempotent). Report the standing state.
      if (want < 0) return { outcome: deducted() ? 'cl_deducted' : 'hr_review', changed: false, appliedNet };
      return { outcome: rows.length ? 'reversed' : 'none', changed: false, appliedNet };
    }
    if (delta < 0) {
      // A further NET deduction is required → verify CL covers it (never go negative).
      const bal = await leaveEngine.getBalance(employeeId, year);
      const remaining = Number(bal?.casual?.remaining) || 0;
      if (remaining < Math.abs(delta)) return { outcome: 'hr_review', reason: 'insufficient_cl', remaining, changed: false, appliedNet };
    }
    // Pick the row's reason: the readable base keys for the FIRST debit / FIRST reversal, else a
    // unique recon row (so multi-flip never collides and audit stays append-only).
    let reason;
    if (delta < 0 && !rows.some((x) => rrn(x) === clReason(requestType, employeeId, ds))) reason = clReason(requestType, employeeId, ds);
    else if (delta > 0 && !rows.some((x) => rrn(x) === clReversalReason(requestType, employeeId, ds))) reason = clReversalReason(requestType, employeeId, ds);
    else reason = `${clReconPrefix(requestType, employeeId, ds)}${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
    await leaveEngine.addLedgerEntry({
      employeeId, employeeName, year,
      kind: 'adjustment', category: 'casual', days: delta,
      effectiveDate: ds, reason, createdBy: createdBy || 'Permission Policy',
    });
    const newNet = round2(appliedNet + delta);
    if (want < 0) return { outcome: 'cl_deducted', changed: true, delta, appliedNet: newNet };
    return { outcome: newNet === 0 ? 'reversed' : 'none', changed: true, delta, appliedNet: newNet };
  } catch (e) {
    global.logger?.warn?.(`[permission-policy] CL reconcile failed for ${employeeId}/${ds}: ${e.message}`);
    return { outcome: want < 0 ? 'hr_review' : 'error', reason: 'error', changed: false };
  }
}

/**
 * Forward CL debit for a 4th+ qualifying event (reconciles the event to a −0.5 net). Returns
 * { outcome:'cl_deducted'|'hr_review', days, already }. Balance-checked, idempotent, event-keyed
 * (employee+date+type) so the request path and the scanner can never double-debit one event.
 */
async function debitCasualHalfDay({ employeeId, employeeName, date, requestType, createdBy }) {
  const r = await reconcileEventCL({ employeeId, employeeName, date, requestType, desiredNet: -POLICY.clPerEvent, createdBy: createdBy || 'Permission Policy' });
  if (r.outcome === 'cl_deducted') return { outcome: 'cl_deducted', days: POLICY.clPerEvent, already: !r.changed };
  return { outcome: 'hr_review', reason: r.reason || 'insufficient_cl', remaining: r.remaining };
}

/**
 * Reverse an event's CL to a 0 net when the final authoritative attendance is on-time (correction
 * undid the lateness). Idempotent and exact (never over-reverses). Returns { reversed, already?, reason? }.
 */
async function reverseCasualHalfDay({ employeeId, employeeName, date, requestType, createdBy }) {
  const r = await reconcileEventCL({ employeeId, employeeName, date, requestType, desiredNet: 0, createdBy: createdBy || 'Permission Policy (reversal)' });
  if (r.outcome === 'error') return { reversed: false, reason: 'error' };
  if (r.changed) return { reversed: true, days: POLICY.clPerEvent };
  // No write needed: either nothing was ever debited, or it is already net-zero (already reversed).
  if (r.outcome === 'none') return { reversed: false, reason: 'no_debit' };
  return { reversed: true, already: true };
}

module.exports = { POLICY, STATUS, isQualifying, effectiveFor, decide, stageFor, reconcileEventCL, debitCasualHalfDay, reverseCasualHalfDay, clReason, clReversalReason, clReconPrefix, isEventCLRow };
