/**
 * Request-module adapters for the shared Request Lifecycle engine.
 *
 * Each adapter is a small config object telling the engine how to read/write ONE
 * module's records — how to find the owner, derive the canonical status, mark the
 * record cancelled, reset it for a resubmit, and who to notify. Adding a FUTURE
 * request module = add one adapter here (no engine change, no duplicated delete/
 * resubmit/cancel/audit/notify logic).
 *
 * Canonical status: pending | manager_approved | approved | rejected | cancelled
 */
const d365 = require('./d365.service');
const { toValue, toLabel } = require('./picklist');
const { registerAdapter } = require('./request-lifecycle.service');
const { rangeCounts } = require('./attendance-summary.util');   // working-days calc (weekends + holidays excluded)
const { validateLeaveReason } = require('./leave-reason.util');  // SAME 4000-char guard the create route uses

const E = d365.constructor.entities;
const EMP = E.employee;
const FV = '@OData.Community.Display.V1.FormattedValue';

// ── shared recipient/contact helpers ──────────────────────────────────────────
async function hrRecipients() {
  try {
    const { data } = await d365.getList(EMP, {
      select: 'hr_hremployeeid,hr_email',
      filter: `(hr_role eq ${toValue('hr_role', 'super_admin')} or hr_role eq ${toValue('hr_role', 'hr_manager')}) and hr_status eq ${toValue('hr_employee_status', 'active')}`,
    });
    return { emails: (data || []).map(e => e.hr_email).filter(Boolean), ids: (data || []).map(e => e.hr_hremployeeid) };
  } catch { return { emails: [], ids: [] }; }
}
async function managerRecipientsFor(employeeId) {
  try {
    const emp = await d365.getByIdOptional(EMP, employeeId, { select: 'hr_hremployeeid', optionalSelect: '_hr_manager_value' });
    const mid = emp?._hr_manager_value;
    if (!mid) return { emails: [], ids: [] };
    const mgr = await d365.getById(EMP, mid, { select: 'hr_email' });
    return { emails: [mgr?.hr_email].filter(Boolean), ids: [mid] };
  } catch { return { emails: [], ids: [] }; }
}
async function contactFor(employeeId) {
  try { const e = await d365.getById(EMP, employeeId, { select: 'hr_email,hr_hremployee1' }); return { email: e?.hr_email || '', name: e?.hr_hremployee1 || '' }; }
  catch { return {}; }
}
const mapEdits = (edits, map) => { const out = {}; for (const [k, f] of Object.entries(map)) if (edits[k] !== undefined) out[f] = String(edits[k]); return out; };

// ── 1. Leave (numeric picklist status + L1/L2 text approval) ──────────────────
registerAdapter({
  type: 'leave', label: 'Leave', entity: E.leave,
  // Uses the real leave date columns hr_fromdate/hr_todate (the same columns the
  // rest of the leave module reads/writes) — needed for the cancellation rule.
  async get(id) { return d365.getByIdOptional(E.leave, id, { select: 'hr_hrleaveid,hr_status,hr_fromdate,hr_todate,hr_leavetype,_hr_hremployee_value', optionalSelect: 'hr_l1status,hr_l2status,hr_reason' }); },
  ownerId: (r) => r._hr_hremployee_value,
  ownerName: (r) => r[`_hr_hremployee_value${FV}`] || '',
  status(r) {
    const s = toLabel('hr_leave_status', r.hr_status);
    if (s === 'cancelled') return 'cancelled';
    if (s === 'rejected') return 'rejected';
    if (s === 'approved') return 'approved';
    if (String(r.hr_l1status || '') === 'approved') return 'manager_approved';
    return 'pending';
  },
  // Approved-leave cancellation rule (future = always; today/past = only if the
  // employee was PRESENT on that date). Reuses the shared attendance status —
  // enforced by the engine on requestCancellation and surfaced as a capability.
  async canRequestCancellation(r) {
    return require('./leave-cancel.util').leaveCancellationStatus({
      employeeId: r._hr_hremployee_value, fromDate: r.hr_fromdate, toDate: r.hr_todate,
    });
  },
  cancelledPatch: () => ({ hr_status: toValue('hr_leave_status', 'cancelled') }),
  resubmitPatch: () => ({ hr_status: toValue('hr_leave_status', 'pending'), hr_l1status: 'pending', hr_l2status: '' }),
  // Editable while PENDING (or on resubmit): reason + dates. Leave TYPE stays fixed
  // (option-set) and status fields are never employee-editable. hr_days is ALWAYS
  // recomputed from the dates (working days only) — never trust a client day count.
  applyEdits: (e) => {
    // Editing/resubmitting a leave must honour the SAME 4000-char reason limit as
    // apply — the create route validates, so the edit path must too (no artificial
    // 100 cap, never truncated). Clean 400 message; the shared route maps err.status.
    if (e.reason !== undefined) {
      const chk = validateLeaveReason(e.reason);
      if (!chk.ok) { const err = new Error(chk.error); err.status = 400; throw err; }
    }
    const out = mapEdits(e, { reason: 'hr_reason', fromDate: 'hr_fromdate', toDate: 'hr_todate' });
    if (e.fromDate && e.toDate) {
      const f = String(e.fromDate).slice(0, 10), t = String(e.toDate).slice(0, 10);
      if (f && t && t >= f) out.hr_days = String(rangeCounts(f, t).working);
    }
    return out;
  },
  summary: (r) => `${toLabel('hr_leave_type', r.hr_leavetype) || 'Leave'} ${String(r.hr_fromdate || '').slice(0, 10)}→${String(r.hr_todate || '').slice(0, 10)}`,
  managerRecipients: (r) => managerRecipientsFor(r._hr_hremployee_value),
  hrRecipients,
  employeeContact: (r) => contactFor(r._hr_hremployee_value),
});

// ── 2. Late Login (text status + hr_managerstatus) ────────────────────────────
registerAdapter({
  type: 'late_login', label: 'Late Login', entity: E.lateLogin,
  async get(id) { return d365.getByIdOptional(E.lateLogin, id, { select: 'hr_lateloginid,hr_employeeid,hr_employeename,hr_status,hr_managerstatus,hr_date', optionalSelect: '' }); },
  ownerId: (r) => r.hr_employeeid,
  ownerName: (r) => r.hr_employeename || '',
  status(r) {
    const s = r.hr_status;
    if (s === 'cancelled') return 'cancelled';
    if (s === 'rejected') return 'rejected';
    if (s === 'approved') return 'approved';
    if (String(r.hr_managerstatus || '') === 'approved') return 'manager_approved';
    return 'pending';
  },
  cancelledPatch: () => ({ hr_status: 'cancelled' }),
  resubmitPatch: () => ({ hr_status: 'pending', hr_managerstatus: 'pending', hr_approvedby: '', hr_approveddate: '' }),
  applyEdits: (e) => mapEdits(e, { reason: 'hr_reason', remarks: 'hr_remarks', expectedTime: 'hr_expectedtime', actualTime: 'hr_actualtime', date: 'hr_date' }),
  summary: (r) => `Late Login ${String(r.hr_date || '').slice(0, 10)}`,
  managerRecipients: (r) => managerRecipientsFor(r.hr_employeeid),
  hrRecipients,
  employeeContact: (r) => contactFor(r.hr_employeeid),
});

// ── 3. Comp Off (text status; balance is a STORED ledger) ─────────────────────
registerAdapter({
  type: 'comp_off', label: 'Comp Off', entity: E.compOff,
  async get(id) { return d365.getById(E.compOff, id, { select: 'hr_compoffid,hr_employeeid,hr_employeename,hr_status,hr_workeddate,hr_days,hr_ledgerlinked' }); },
  ownerId: (r) => r.hr_employeeid,
  ownerName: (r) => r.hr_employeename || '',
  status(r) {
    const s = r.hr_status;
    if (s === 'cancelled' || s === 'expired') return 'cancelled';
    if (s === 'rejected') return 'rejected';
    if (s === 'approved') return 'approved';
    return 'pending';
  },
  cancelledPatch: () => ({ hr_status: 'cancelled', hr_ledgerlinked: 'false' }),
  // Cancellation OWNS the effect: reverse the ledger credit AND set the status.
  async onCancelled({ id, approver, remarks }) { return require('./comp-off.service').cancel(id, approver, remarks); },
  resubmitPatch: () => ({ hr_status: 'pending', hr_approvedby: '', hr_approveddate: '' }),
  applyEdits: (e) => mapEdits(e, { reason: 'hr_reason', remarks: 'hr_remarks' }),
  summary: (r) => `Comp Off ${String(r.hr_workeddate || '').slice(0, 10)}`,
  managerRecipients: (r) => managerRecipientsFor(r.hr_employeeid),
  hrRecipients,
  employeeContact: (r) => contactFor(r.hr_employeeid),
});

// ── 4. Attendance Correction (text status; no manager stage) ──────────────────
// Cancellation of an APPROVED correction is disabled — an approved correction has
// already inserted a punch + recomputed the day, so it is a factual record. Delete
// (pending/rejected) and Edit & Resubmit (rejected) apply.
registerAdapter({
  type: 'attendance_correction', label: 'Attendance Correction', entity: E.attendanceRequest,
  canCancel: false,
  async get(id) { return d365.getById(E.attendanceRequest, id, { select: 'hr_attendancerequestid,hr_employeeid,hr_employeename,hr_status,hr_date' }); },
  ownerId: (r) => r.hr_employeeid,
  ownerName: (r) => r.hr_employeename || '',
  status(r) {
    const s = r.hr_status;
    if (s === 'rejected') return 'rejected';
    if (s === 'approved') return 'approved';
    return 'pending';
  },
  cancelledPatch: () => ({ hr_status: 'rejected' }),
  resubmitPatch: () => ({ hr_status: 'pending' }),
  // Editable while PENDING (or on resubmit): the correction content itself.
  applyEdits: (e) => mapEdits(e, { reason: 'hr_reason', remarks: 'hr_remarks', date: 'hr_attendancedate', punchType: 'hr_punchtype', requestedTime: 'hr_requestedtime', adjustmentHours: 'hr_adjustmenthours' }),
  summary: (r) => `Attendance Correction ${String(r.hr_date || '').slice(0, 10)}`,
  managerRecipients: (r) => managerRecipientsFor(r.hr_employeeid),
  hrRecipients,
  employeeContact: (r) => contactFor(r.hr_employeeid),
});

// ── 6. Historical Attendance (text status; pending / approved / rejected / more_info) ──
// An APPROVED request has already upserted the day's attendance record, so it is a
// factual record — cancellation is off. Delete (pending/rejected) and Edit (pending) /
// Edit & Resubmit (rejected) apply. more_info is treated as still-pending (editable).
registerAdapter({
  type: 'historical_attendance', label: 'Historical Attendance', entity: 'hr_histattendances',
  canCancel: false,
  async get(id) { return d365.getById('hr_histattendances', id, { select: 'hr_histattendanceid,hr_employeeid,hr_employeename,hr_status,hr_date' }); },
  ownerId: (r) => r.hr_employeeid,
  ownerName: (r) => r.hr_employeename || '',
  status(r) {
    const s = r.hr_status;
    if (s === 'rejected') return 'rejected';
    if (s === 'approved') return 'approved';
    return 'pending';   // pending or more_info → still editable
  },
  cancelledPatch: () => ({ hr_status: 'rejected' }),
  resubmitPatch: () => ({ hr_status: 'pending' }),
  applyEdits: (e) => mapEdits(e, { reason: 'hr_reason', comments: 'hr_comments', date: 'hr_date', inTime: 'hr_intime', outTime: 'hr_outtime' }),
  summary: (r) => `Historical Attendance ${String(r.hr_date || '').slice(0, 10)}`,
  managerRecipients: (r) => managerRecipientsFor(r.hr_employeeid),
  hrRecipients,
  employeeContact: (r) => contactFor(r.hr_employeeid),
});

// ── 5. Document Verification (text status; own upload/reupload flow) ───────────
// Delete applies (a non-verified doc); "resubmit" is a file re-upload handled by
// the documents module, and a verified doc is not "cancelled" — so both are off.
registerAdapter({
  type: 'document', label: 'Document', entity: E.document,
  canResubmit: false, canCancel: false,
  async get(id) { return d365.getByIdOptional(E.document, id, { select: 'hr_hrdocumentid,hr_name,_hr_hremployee_value', optionalSelect: 'hr_status' }); },
  ownerId: (r) => r._hr_hremployee_value,
  ownerName: (r) => r[`_hr_hremployee_value${FV}`] || '',
  status(r) {
    const s = r.hr_status || 'pending';
    if (s === 'verified') return 'approved';
    if (s === 'superseded') return 'cancelled';
    if (s === 'rejected' || s === 'reupload') return 'rejected';
    return 'pending';
  },
  cancelledPatch: () => ({ hr_status: 'superseded' }),
  resubmitPatch: () => ({ hr_status: 'pending' }),
  applyEdits: () => ({}),
  summary: (r) => `Document ${r.hr_name || ''}`.trim(),
  managerRecipients: (r) => managerRecipientsFor(r._hr_hremployee_value),
  hrRecipients,
  employeeContact: (r) => contactFor(r._hr_hremployee_value),
});

// NOTE: Goals are HR/manager-ASSIGNED, not an employee approval request, so they do
// not join the request lifecycle (spec: "Goals — if applicable"). A future
// employee-raised request module registers its adapter here the same way.

module.exports = { hrRecipients, managerRecipientsFor, contactFor };
