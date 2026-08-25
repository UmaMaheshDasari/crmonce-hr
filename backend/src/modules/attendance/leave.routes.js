const express = require('express');
const router = express.Router();
const d365 = require('../../services/d365.service');
const { requireRole, requirePermission } = require('../../middleware/auth.middleware');
const { notifyLeaveApproval, broadcast } = require('../../services/notification.service');
const { toValue, toLabel, labelsForList, labelsForEntity } = require('../../services/picklist');
const requestNotify = require('../../services/request-notify.service');
const { verifyApprovalToken } = require('../../services/approval-token');
const { resolveSender } = require('../../services/email/sender');
const time = require('../../services/time.util');
const { leaveSummary, resolveDays } = require('../../services/leave-summary.util');
const { rangeCounts } = require('../../services/attendance-summary.util');

// AUTHORITATIVE leave-day count: WORKING days only in [from, to] — excludes weekly-offs
// (attnCfg.weekOffDays) and company holidays (attnCfg.holidays, kept fresh from the
// hr_holidays calendar). The ONE calc the whole system uses; never a calendar-day span.
function leaveWorkingDays(from, to) {
  const f = String(from || '').slice(0, 10), t = String(to || '').slice(0, 10);
  if (!f || !t || t < f) return 0;
  try { return rangeCounts(f, t).working; } catch { return 0; }
}
const leaveEngine = require('../../services/leave-engine.service');
const { ensureLeaveLedgerTable } = require('../../services/provision-leave-ledger');
const payrollSettings = require('../../services/payroll-settings.service');
const { validateLeaveReason } = require('../../services/leave-reason.util');
const { ensureReasonLength } = require('../../services/provision-leave-columns');
const sickRun = require('../../services/sick-run.service');
const { validateSickLeaveDocumentRequirement } = require('../../services/sick-leave-week.util');
const compOffSvc = require('../../services/comp-off.service');
let activity; try { activity = require('../../services/activity.service'); } catch (_) { activity = null; }
const audit = (payload) => { try { activity?.record?.(payload); } catch (_) {} };

const ENTITY = d365.constructor.entities.leave;
const EMP_ENTITY = d365.constructor.entities.employee;
const DOC_ENTITY = d365.constructor.entities.document;
const HR_ROLES = ['super_admin', 'hr_manager'];

// ── Sick-leave Medical Certificate policy ────────────────────────────────────
// Configurable (Payroll Settings → medCert.required / medCert.afterDays); never
// hardcoded. A Sick Leave of MORE than `afterDays` consecutive days needs a
// certificate. Returns { required, threshold, message } for the given request.
async function medCertPolicy(typeLabel, days) {
  const fallback = { required: false, threshold: 2, message: '' };
  try {
    const { medCert } = await payrollSettings.getResolved();
    const afterDays = Number(medCert?.afterDays) || 1;
    const threshold = afterDays + 1;          // e.g. afterDays=1 → 2+ days
    const required = !!medCert?.required && String(typeLabel) === 'Sick Leave' && Number(days) > afterDays;
    return {
      required, threshold,
      message: `Medical Certificate is mandatory for Sick Leave of ${threshold} or more consecutive days.`,
    };
  } catch (_) { return fallback; }
}

// Approval guard: block approving a Sick Leave that needs a certificate but has no
// valid one (missing, rejected or awaiting re-upload). Throws a 400 the caller
// surfaces. Never blocks on a lookup failure (best-effort).
async function assertCertOkToApprove(leaveRecord) {
  try {
    const typeLabel = toLabel('hr_leave_type', leaveRecord.hr_leavetype);
    // Consecutive-working-day run (across history), not just this request's span.
    const runDays = await sickRun.sickLeaveRunDays(leaveRecord._hr_hremployee_value, leaveRecord.hr_fromdate, leaveRecord.hr_todate, { excludeLeaveId: leaveRecord.hr_hrleaveid });
    const policy = await medCertPolicy(typeLabel, runDays);
    if (!policy.required) return;
    const docId = leaveRecord.hr_medcertdocid;
    let ok = false;
    if (docId) {
      try {
        const doc = await d365.getByIdOptional(DOC_ENTITY, docId, { select: 'hr_hrdocumentid', optionalSelect: 'hr_status' });
        const st = doc?.hr_status || 'pending';
        ok = !!doc?.hr_hrdocumentid && !['rejected', 'reupload'].includes(st);   // pending/verified are acceptable
      } catch (_) { ok = false; }
    }
    if (!ok) {
      const e = new Error('Medical Certificate is required before approving this Sick Leave request.');
      e.status = 400; throw e;
    }
  } catch (e) { if (e.status) throw e; /* lookup failure — don't block */ }
}

// Comp-off leave usage: when a comp-off leave transitions to APPROVED, reduce the
// comp-off balance with a `comp_off_used` ledger entry (exactly once). Best-effort
// so it never blocks approval. `alreadyApproved` guards the HR-override re-approve
// path from double-deducting.
async function applyCompOffUsageOnApprove(current, { alreadyApproved = false } = {}) {
  try {
    if (current.hr_usecompoff !== 'true' || alreadyApproved) return;
    const days = resolveDays(current.hr_days, current.hr_fromdate, current.hr_todate);
    const yr = Number(String(current.hr_fromdate || '').slice(0, 4)) || new Date().getFullYear();
    await leaveEngine.addLedgerEntry({
      employeeId: current._hr_hremployee_value, employeeName: '', year: yr,
      kind: 'comp_off_used', category: 'compoff', days,
      effectiveDate: String(current.hr_fromdate || '').slice(0, 10), reason: 'Comp Off leave', createdBy: 'Leave',
    });
  } catch (e) { global.logger?.warn?.(`[leave] comp-off usage ledger skipped: ${e.message}`); }
}

// On leave approval: (1) write an audit entry (employee, dates, approver, attendance
// transition), and (2) surface payroll impact — if that month's payroll is already
// locked/processed it returns a "manual recalculation required" note; otherwise the
// change auto-reflects on the next (draft) payroll generation (payroll reads live).
async function auditAndPayrollImpactOnApprove(current, user, approvedDate) {
  const employeeId = current._hr_hremployee_value;
  const leaveFrom = String(current.hr_fromdate || '').slice(0, 10);
  const leaveTo = String(current.hr_todate || '').slice(0, 10);
  try {
    audit({
      category: 'Leave', type: 'leave_approved',
      title: 'Leave approved — attendance updated to On Leave',
      name: current['_hr_hremployee_value@OData.Community.Display.V1.FormattedValue'] || '',
      meta: { employeeId, leaveFrom, leaveTo, approvedBy: user?.name, approvedDate, previousAttendance: 'Absent / No record', updatedAttendance: 'Approved Leave' },
    });
  } catch (_) {}
  try {
    const [Y, M] = leaveFrom.split('-').map(Number);
    if (!Y || !M) return null;
    const { data } = await d365.getListOptional(d365.constructor.entities.payroll, {
      select: 'hr_hrpayrollid,hr_status', optionalSelect: 'hr_locked',
      filter: `_hr_hremployee_value eq '${employeeId}' and hr_month eq ${M} and hr_year eq ${Y}`, top: 1,
    });
    const row = data && data[0];
    if (!row) return null;   // no payroll yet → reflects on first generation
    const statusLabel = toLabel('hr_payroll_status', row.hr_status);
    const locked = row.hr_locked === 'true' || ['processed', 'paid'].includes(statusLabel);
    if (locked) {
      const message = 'Payroll already processed. Manual recalculation required.';
      broadcast('payroll:recalc_needed', { employeeId, month: `${M}/${Y}`, message });
      audit({ category: 'Payroll', type: 'payroll_recalc_needed', title: 'Payroll recalculation required (backdated leave approved)', meta: { employeeId, month: M, year: Y } });
      return { locked: true, message };
    }
    return { locked: false };
  } catch (_) { return null; }
}

/**
 * Two-level leave approval flow:
 *
 * Employee applies → status = pending
 *   ↓
 * L1 (Direct Manager) approves/rejects → hr_l1status = approved/rejected
 *   ↓ (if L1 approved)
 * L2 (Manager's Manager) approves/rejects → hr_l2status = approved/rejected
 *   ↓ (if L2 approved)
 * Final status = approved
 *
 * If either L1 or L2 rejects → final status = rejected
 */

// Helper: get employee's manager chain
async function getManagerChain(employeeId) {
  const emp = await d365.getById(EMP_ENTITY, employeeId, {
    select: 'hr_hremployeeid,hr_hremployee1,_hr_manager_value',
  });

  const result = { employee: emp, l1Manager: null, l2Manager: null };

  if (emp._hr_manager_value) {
    const l1 = await d365.getById(EMP_ENTITY, emp._hr_manager_value, {
      select: 'hr_hremployeeid,hr_hremployee1,_hr_manager_value',
    });
    result.l1Manager = l1;

    if (l1._hr_manager_value) {
      const l2 = await d365.getById(EMP_ENTITY, l1._hr_manager_value, {
        select: 'hr_hremployeeid,hr_hremployee1',
      });
      result.l2Manager = l2;
    }
  }

  return result;
}

// GET /api/attendance/leave
router.get('/', async (req, res, next) => {
  try {
    const { status, employeeId, pending_for } = req.query;
    const filters = [];

    if (req.user.role === 'employee') {
      // Employees see: their own leaves + leaves pending their approval (as manager)
      if (pending_for === 'me') {
        // Show leaves where I am the L1 or L2 approver
        filters.push(`(hr_l1status eq 'pending' or hr_l2status eq 'pending_l2')`);
      } else {
        filters.push(`_hr_hremployee_value eq '${req.user.id}'`);
      }
    } else {
      if (employeeId) filters.push(`_hr_hremployee_value eq '${employeeId}'`);
    }

    if (status) filters.push(`hr_status eq ${toValue('hr_leave_status', status)}`);

    const result = await d365.getListOptional(ENTITY, {
      select: 'hr_hrleaveid,hr_leavetype,hr_fromdate,hr_todate,hr_days,hr_reason,hr_status,hr_remarks,_hr_hremployee_value,hr_l1status,hr_l1remarks,hr_l1approvedby,hr_l1date,hr_l2status,hr_l2remarks,hr_l2approvedby,hr_l2date,createdon',
      optionalSelect: 'hr_medcertdocid,hr_usecompoff',   // present once the leave columns are provisioned
      filter: filters.join(' and ') || undefined,
      orderby: 'createdon desc',
    });

    // For managers: filter to show only their reportees' leaves
    let data = result;
    if (req.user.role === 'employee' && pending_for === 'me') {
      // Filter: only leaves from my direct reports or their reports
      const { data: reportees } = await d365.getList(EMP_ENTITY, {
        filter: `_hr_manager_value eq '${req.user.id}'`,
        select: 'hr_hremployeeid',
      });
      const reporteeIds = new Set(reportees.map(r => r.hr_hremployeeid));

      // Also get skip-level reports (reportees' reportees)
      for (const r of reportees) {
        const { data: subReportees } = await d365.getList(EMP_ENTITY, {
          filter: `_hr_manager_value eq '${r.hr_hremployeeid}'`,
          select: 'hr_hremployeeid',
        });
        subReportees.forEach(sr => reporteeIds.add(sr.hr_hremployeeid));
      }

      data.data = data.data.filter(l => reporteeIds.has(l._hr_hremployee_value));
      data.count = data.data.length;
    }

    // Attach the linked Medical Certificate's verification status so any viewer
    // (incl. a reporting manager who cannot open the file) can see whether a valid
    // certificate exists — the UI uses this to gate approval. Best-effort.
    try {
      const withCert = (data.data || []).filter(l => l.hr_medcertdocid);
      if (withCert.length) {
        const pairs = await Promise.all(withCert.map(async (l) => {
          try {
            const doc = await d365.getByIdOptional(DOC_ENTITY, l.hr_medcertdocid, { select: 'hr_hrdocumentid', optionalSelect: 'hr_status' });
            return [l.hr_medcertdocid, doc?.hr_hrdocumentid ? (doc.hr_status || 'pending') : null];
          } catch (_) { return [l.hr_medcertdocid, null]; }
        }));
        const statusById = Object.fromEntries(pairs);
        for (const l of data.data) if (l.hr_medcertdocid) l.medCertStatus = statusById[l.hr_medcertdocid] || null;
      }
    } catch (_) { /* enrichment is best-effort */ }

    // Cancellation eligibility for the VIEWER's OWN approved leaves — drives the
    // "Request Cancellation" button + its disabled reason. Bounded to the caller's
    // own approved rows; best-effort (never fails or blocks the list). Runs on the
    // raw rows (numeric hr_status) before labelsForList; the added fields survive it.
    try {
      const cancelUtil = require('../../services/leave-cancel.util');
      for (const l of (data.data || [])) {
        if (l._hr_hremployee_value !== req.user.id) continue;
        const st = toLabel('hr_leave_status', l.hr_status);
        const isApproved = st === 'approved' || (st !== 'cancelled' && st !== 'rejected' && String(l.hr_l1status || '') === 'approved');
        if (!isApproved) continue;
        const el = await cancelUtil.leaveCancellationStatus({ employeeId: l._hr_hremployee_value, fromDate: l.hr_fromdate, toDate: l.hr_todate });
        l.cancelEligible = el.ok;
        if (!el.ok) l.cancelReason = el.reason;
      }
    } catch (_) { /* best-effort — backend still enforces on the cancellation action */ }

    res.json(labelsForList('hr_hrleaves', data));
  } catch (err) { next(err); }
});

// GET /api/attendance/leave/approvers — active HR Managers + Super Admins.
// Powers the required "Approver" (TO) dropdown on the Apply Leave form. Read
// dynamically from D365 — never hardcoded; inactive users drop off automatically.
router.get('/approvers', async (req, res, next) => {
  try {
    const approvers = await requestNotify.getApprovers();
    res.json({
      data: approvers.map(a => ({
        id: a.hr_hremployeeid,
        name: a.hr_hremployee1,
        email: a.hr_email,
        department: a.hr_department || '',
      })),
    });
  } catch (err) { next(err); }
});

// GET /api/attendance/leave/summary — dynamic Leave Summary stats for the dashboard
// cards (Pending Approval / Approved Leaves / Rejected Leaves / Total Leave Taken)
// over a [from, to] period. Reads leave records from hr_hrleaves (NOT attendance),
// scoped to the logged-in employee; Total Leave Taken = sum of Approved leave days.
router.get('/summary', async (req, res, next) => {
  try {
    // Only HR/Super Admin may view another employee; everyone else (incl. recruiter)
    // is locked to their own id — this route has no requirePermission gate.
    const targetId = HR_ROLES.includes(req.user.role) ? (req.query.employeeId || req.user.id) : req.user.id;
    // Period comes from the dashboard filter; default = current month.
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const from = req.query.from || `${now.getFullYear()}-${pad(now.getMonth() + 1)}-01`;
    const to = req.query.to || `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate())}`;
    // hr_todate is needed so we can recover the day count when hr_days is blank.
    const { data } = await d365.getList(ENTITY, {
      select: 'hr_days,hr_fromdate,hr_todate,hr_status',
      filter: `_hr_hremployee_value eq '${targetId}'`,
    });
    const rows = (data || []).map(l => ({
      days: resolveDays(l.hr_days, l.hr_fromdate, l.hr_todate),   // hr_days, else from→to span
      fromDate: String(l.hr_fromdate || '').slice(0, 10),
      status: toLabel('hr_leave_status', l.hr_status),
    }));
    const summary = leaveSummary(rows, { from, to });
    // Diagnostic logging (checklist #9): who, how many records, and the computed total.
    res.json(summary);
  } catch (err) { next(err); }
});

// GET /api/attendance/leave/cc-candidates — active employees for the CC field.
// All active employees EXCEPT the caller, straight from D365 (not the restricted
// /employees directory). Inactive/placeholder/no-email are excluded automatically.
router.get('/cc-candidates', async (req, res, next) => {
  try {
    const { data } = await d365.getList(EMP_ENTITY, {
      filter: `hr_status eq ${toValue('hr_employee_status', 'active')}`,
      select: 'hr_hremployeeid,hr_hremployee1,hr_email,hr_department',
      orderby: 'hr_hremployee1 asc',
      top: 1000,
    });
    const list = (data || [])
      .filter(e => e.hr_hremployeeid !== req.user.id)                              // exclude self
      .filter(e => e.hr_email && !requestNotify.isPlaceholderEmail(e.hr_email))    // need a real mailbox to CC
      .map(e => ({ id: e.hr_hremployeeid, name: e.hr_hremployee1, email: e.hr_email, department: e.hr_department || '' }));
    res.json({ data: list });
  } catch (err) { next(err); }
});

// Shared HR/Super-Admin override decision — used by BOTH the PATCH /:id route
// (UI override) and the POST /:id/email-action route (email button). Keeps a
// single source of truth for the override logic (no duplication).
//   enforcePending=true  → refuse if the request is already finalised
//                          (prevents duplicate approvals / replay via email links).
async function applyHrOverride(user, id, status, remarks, { enforcePending = false } = {}) {
  const current = await d365.getByIdOptional(ENTITY, id, {
    select: 'hr_hrleaveid,_hr_hremployee_value,hr_status,hr_fromdate,hr_todate,hr_days,hr_ccrecipients,hr_leavetype',
    optionalSelect: 'hr_medcertdocid,hr_usecompoff',
  });
  const wasApproved = toLabel('hr_leave_status', current.hr_status) === 'approved';

  // Approved-leave cancellation rule enforced on the DIRECT API too (defence in
  // depth): a past/today leave date is only cancellable when the employee has a
  // Present attendance record for that date; future leave is always cancellable.
  if (status === 'cancelled' && wasApproved) {
    const el = await require('../../services/leave-cancel.util').leaveCancellationStatus({
      employeeId: current._hr_hremployee_value, fromDate: current.hr_fromdate, toDate: current.hr_todate,
    });
    if (!el.ok) { const e = new Error(el.reason); e.status = 400; throw e; }
  }

  if (enforcePending) {
    const label = toLabel('hr_leave_status', current.hr_status);
    if (['approved', 'rejected', 'cancelled'].includes(label)) {
      const e = new Error(`This request is already ${label}`);
      e.status = 409;
      throw e;
    }
  }

  // Medical-Certificate guard (req 5): never approve a Sick Leave that needs a
  // valid certificate but has none. Rejections are always allowed.
  if (status === 'approved') await assertCertOkToApprove(current);

  const now = new Date().toISOString().split('T')[0];
  const leave = await d365.update(ENTITY, id, {
    hr_status: toValue('hr_leave_status', status),
    hr_remarks: remarks || `${status} by ${user.name} (HR Override)`,
    hr_l1status: status === 'approved' ? 'approved' : 'rejected',
    hr_l1approvedby: user.name,
    hr_l1date: now,
    hr_l2status: 'not_required',
  });

  // Comp-off leave: deduct the comp-off balance once, on transition to approved.
  if (status === 'approved') await applyCompOffUsageOnApprove(current, { alreadyApproved: wasApproved });
  // Audit + payroll-impact (attendance auto-updates via the read-time overlay).
  if (status === 'approved' && !wasApproved) {
    const impact = await auditAndPayrollImpactOnApprove(current, user, now);
    if (impact?.locked) leave._payrollNote = impact.message;
  }

  const employeeId = leave._hr_hremployee_value || current._hr_hremployee_value;
  if (employeeId) {
    // In-app notification + employee decision email — EMPLOYEE ONLY (no HR/manager CC).
    await notifyLeaveApproval(employeeId, status, { from: current.hr_fromdate, to: current.hr_todate });
    requestNotify.emailDecisionToEmployee({
      type: 'leave', employeeId, decision: status,
      approver: { name: user.name, email: user.email, role: user.role },
      remarks: remarks || '', status,
      fromDate: current.hr_fromdate, toDate: current.hr_todate,
      leaveType: toLabel('hr_leave_type', current.hr_leavetype),
      requestDays: resolveDays(current.hr_days, current.hr_fromdate, current.hr_todate),
    });
  }

  broadcast('leave:updated', { leaveId: id, action: status, level: 'HR' });
  return leave;
}

// GET /api/attendance/leave/working-days?from=&to= — the eligible working-day count for
// a range (weekends + company holidays excluded). The SAME calc the create uses, so the
// form's live preview always matches what the backend will store.
router.get('/working-days', requirePermission('attendance:read'), (req, res) => {
  const from = String(req.query.from || '').slice(0, 10);
  const to = String(req.query.to || '').slice(0, 10);
  const rc = (from && to && to >= from) ? rangeCounts(from, to) : { calendar: 0, holidays: 0, weeklyOff: 0, working: 0 };
  res.json({ from, to, workingDays: rc.working, calendarDays: rc.calendar, holidays: rc.holidays, weeklyOff: rc.weeklyOff });
});

// POST /api/attendance/leave — Employee applies for leave
router.post('/', async (req, res, next) => {
  try {
    // approverId (required) + cc (optional) are business inputs, not D365 columns
    // that should be blindly written — pull them out and resolve them server-side.
    const { approverId, cc, medCertDocId, halfDay, ...rest } = req.body;
    const body = { ...rest };
    const isHalfDay = halfDay === true || halfDay === 'true';   // 0.5-day leave (single day)

    // Reason may be a full enterprise-length explanation (no artificial 100-char
    // cap). Reject ONLY beyond the Dataverse column max, with a clear message — the
    // text is never truncated. Backend + frontend + Dataverse all share this limit.
    const reasonCheck = validateLeaveReason(body.hr_reason);
    if (!reasonCheck.ok) return res.status(400).json({ error: reasonCheck.error });

    // Dynamic sender = the applicant's own company mailbox. Validate it up front
    // (empty / format / must be @crmonce.com) — no silent fallback later.
    const employeeSender = resolveSender({ email: req.user.email, label: 'Employee' });
    if (!employeeSender.ok) {
      return res.status(400).json({ error: employeeSender.reason });
    }

    // Dates: future leave is unrestricted; backdated leave is allowed only within the
    // configured window (Payroll Settings → Maximum Backdated Leave Days, default 30).
    const fromDate = String(body.hr_fromdate || '').slice(0, 10);
    const toDate = String(body.hr_todate || '').slice(0, 10);
    if (!fromDate || !toDate) {
      return res.status(400).json({ error: 'From date and To date are required' });
    }
    if (toDate < fromDate) {
      return res.status(400).json({ error: 'To date cannot be before From date.' });   // invalid range (req 5)
    }
    const today = time.istDateStr();   // "today" in the app timezone (Asia/Kolkata)
    let maxBackdated = 30;
    try { maxBackdated = Number((await payrollSettings.getResolved()).maxBackdatedLeaveDays) || 30; } catch (_) {}
    const earliest = (() => { const d = new Date(`${today}T00:00:00Z`); d.setUTCDate(d.getUTCDate() - maxBackdated); return d.toISOString().slice(0, 10); })();
    if (fromDate < earliest) {
      return res.status(400).json({ error: `You can apply backdated leave only within the last ${maxBackdated} days.` });
    }

    // AUTHORITATIVE day count — recompute WORKING days from the dates and IGNORE any
    // client-supplied hr_days (weekends + company holidays never count). A range with
    // no working day is rejected. Every downstream check (Comp Off balance, medical
    // certificate, stored hr_days) uses this value.
    const workingDays = leaveWorkingDays(fromDate, toDate);
    if (workingDays <= 0) {
      return res.status(400).json({ error: 'No working days in the selected range. Please select at least one working day — weekends and company holidays do not count.' });
    }
    // Half-day leave = exactly 0.5 day, and only for a single working day (any leave
    // type — Casual/Sick/Comp Off). This is what lets a 0.5-day Comp Off balance be
    // used: hr_days becomes 0.5, so the Comp Off balance guard (0.5 ≤ 0.5) passes and
    // approval consumes exactly 0.5 via the existing comp_off_used ledger entry.
    if (isHalfDay && workingDays !== 1) {
      return res.status(400).json({ error: 'Half-day leave can be applied for a single working day only.' });
    }
    body.hr_days = isHalfDay ? 0.5 : workingDays;

    // Balance guard (req 6): block a fully-exhausted Casual/Sick leave. The UI also
    // blocks it, but never trust the client. Best-effort — a lookup failure never
    // blocks a legitimate application. Uses the leave engine (approved leaves only).
    const typeLabel = String(body.hr_leavetype || '');
    if (typeLabel === 'Casual Leave' || typeLabel === 'Sick Leave') {
      try {
        const yr = Number(String(fromDate).slice(0, 4)) || new Date().getFullYear();
        const balance = await leaveEngine.getBalance(req.user.id, yr);
        const rem = typeLabel === 'Casual Leave' ? balance.casual?.remaining : balance.sick?.remaining;
        if (typeof rem === 'number' && rem <= 0) {
          return res.status(400).json({ error: `You have exhausted your ${typeLabel} balance.` });
        }
      } catch (_) { /* engine unavailable — don't block */ }
    }

    // Comp Off leave — paid from the comp-off balance, never LOP. Stored as a paid
    // 'Earned Leave' (the engine already treats it as paid, not vs the CL/SL cap)
    // plus a flag; on approval a `comp_off_used` ledger entry reduces the balance.
    if (typeLabel === 'Comp Off') {
      const coDays = resolveDays(body.hr_days, fromDate, toDate);
      // Expire this employee's overdue comp-off FIRST so expired credits can never be
      // used to apply leave, then check the (now accurate) balance.
      try { await compOffSvc.sweepExpired(req.user.id); } catch (_) {}
      try {
        const yr = Number(String(fromDate).slice(0, 4)) || new Date().getFullYear();
        const bal = await leaveEngine.getBalance(req.user.id, yr);
        if ((bal.compOff?.balance || 0) < coDays) {
          return res.status(400).json({ error: `Insufficient Comp Off balance. Available: ${bal.compOff?.balance || 0} day(s), requested ${coDays}.` });
        }
      } catch (_) { /* balance unavailable — don't hard-block */ }
      body.hr_usecompoff = 'true';
      body.hr_leavetype = 'Earned Leave';   // placeholder: paid, not counted vs CL/SL, never LOP
    }

    // Medical Certificate gate (req 1) — mandatory when the CONSECUTIVE working-day
    // Sick-Leave run (across the employee's history, ignoring weekly-offs/holidays)
    // reaches the configured threshold. Enforced on the backend regardless of the UI.
    const leaveDays = resolveDays(body.hr_days, fromDate, toDate);
    const runDays = typeLabel === 'Sick Leave'
      ? await sickRun.sickLeaveRunDays(req.user.id, fromDate, toDate)
      : leaveDays;
    const certPolicy = await medCertPolicy(typeLabel, runDays);
    // A supporting document is required when EITHER (a) the consecutive-day Medical
    // Certificate rule applies, OR (b) this is the 2nd+ valid Sick Leave in the same
    // calendar week (new rule). Both reuse the SAME hr_medcertdocid attachment.
    let docRequired = certPolicy.required;
    let docMessage = certPolicy.message;
    if (typeLabel === 'Sick Leave' && !docRequired) {
      const weekly = await validateSickLeaveDocumentRequirement(req.user.id, fromDate, toDate);
      if (weekly.required) { docRequired = true; docMessage = weekly.apiError; }
    }
    if (docRequired && !medCertDocId) {
      return res.status(400).json({ error: docMessage });
    }
    if (medCertDocId) {
      // Validate the referenced document belongs to the applicant (never trust the client).
      try {
        const cd = await d365.getByIdOptional(DOC_ENTITY, medCertDocId, { select: 'hr_hrdocumentid,_hr_hremployee_value' });
        if (cd?.hr_hrdocumentid && cd._hr_hremployee_value === req.user.id) {
          body.hr_medcertdocid = medCertDocId;
        }
      } catch (_) { /* invalid id — ignore, doc simply not linked */ }
      if (docRequired && !body.hr_medcertdocid) {
        return res.status(400).json({ error: docMessage });
      }
    }

    if (body.hr_leavetype) body.hr_leavetype = toValue('hr_leave_type', body.hr_leavetype);

    // Set initial approval status
    body.hr_status = toValue('hr_leave_status', 'pending');
    body.hr_l1status = 'pending';
    body.hr_l2status = '';

    // Employee lookup is owned solely by the backend — always bind to the
    // authenticated user; never trust a client-supplied lookup.
    body['hr_hremployee@odata.bind'] = `/hr_hremployees(${req.user.id})`;

    // ── Approver (required, exactly one) — resolved & validated on the backend ──
    if (!approverId) {
      return res.status(400).json({ error: 'An approver is required' });
    }
    let approver;
    try {
      approver = await d365.getById(EMP_ENTITY, approverId, {
        select: 'hr_hremployeeid,hr_hremployee1,hr_email,hr_role,hr_status',
      });
    } catch (_) {
      return res.status(400).json({ error: 'Selected approver not found' });
    }
    const approverRole = toLabel('hr_role', approver.hr_role);
    const approverActive = approver.hr_status === toValue('hr_employee_status', 'active');
    if (!['super_admin', 'hr_manager'].includes(approverRole) || !approverActive) {
      return res.status(400).json({ error: 'Selected approver must be an active HR Manager or Super Admin' });
    }
    // Approver must have a company mailbox — they will be the SENDER of the
    // approval/rejection email, so the same @crmonce.com rule applies.
    const approverSender = resolveSender({ email: approver.hr_email, label: 'Approver' });
    if (!approverSender.ok) {
      return res.status(400).json({ error: approverSender.reason });
    }

    // ── CC recipients (optional) — resolve server-side; skip inactive/placeholder ──
    const ccIds = Array.isArray(cc) ? cc.filter(Boolean) : [];
    const ccRecipients = [];
    const ACTIVE_STATUS = toValue('hr_employee_status', 'active');
    for (const cid of ccIds) {
      try {
        const c = await d365.getById(EMP_ENTITY, cid, { select: 'hr_hremployeeid,hr_hremployee1,hr_email,hr_status,hr_role' });
        if (c?.hr_email && c.hr_status === ACTIVE_STATUS && !requestNotify.isPlaceholderEmail(c.hr_email)) {
          // Capture the CC's role so the notifier can decide actionable-vs-FYI. A CC with
          // an authorized HR/Admin role gets Approve/Reject; everyone else gets FYI only.
          ccRecipients.push({ id: c.hr_hremployeeid, name: c.hr_hremployee1, email: c.hr_email, role: toLabel('hr_role', c.hr_role) });
        }
      } catch (_) { /* skip invalid id */ }
    }

    // Persist approver + CC with the leave (new hr_hrleave fields).
    body.hr_approverid = approver.hr_hremployeeid;
    body.hr_approveremail = approver.hr_email;
    body.hr_approvername = approver.hr_hremployee1;
    body.hr_ccrecipients = JSON.stringify(ccRecipients);

    // Resilient create — strip hr_medcertdocid and retry if the column is not yet
    // provisioned, so leave apply never breaks on a missing certificate column. Also
    // self-heals a stale 100-char hr_reason column: widen it to 4000 and retry ONCE,
    // never truncating the user's text (requirement).
    let leave, widenTried = false;
    {
      let payload = { ...body };
      for (let i = 0; i < 5; i++) {
        try { leave = await d365.create(ENTITY, payload); break; }
        catch (err) {
          if (d365._isMissingProperty?.(err)) {
            const prop = d365._missingPropertyName?.(err);
            if (prop && Object.prototype.hasOwnProperty.call(payload, prop)) { delete payload[prop]; continue; }
          }
          // Dataverse column still capped below the reason length → widen hr_reason to
          // 4000 and retry once. If the widen can't be applied (e.g. the Dataverse app
          // user lacks customization privilege), surface a clear, actionable error —
          // the user's reason is NEVER shortened or dropped.
          if (!widenTried && d365._isColumnLengthError?.(err) && d365._columnLengthName?.(err) === 'hr_reason') {
            widenTried = true;
            const w = await ensureReasonLength(global.logger || console).catch((e) => ({ status: 'failed', reason: e.message }));
            if (w.status === 'updated' || w.status === 'ok') continue;   // column now supports 4000 → retry the create
            return res.status(400).json({
              error: 'Your reason is longer than the leave system currently accepts. An administrator must widen the Leave "Reason" field (Dataverse hr_reason) to 4000 characters. Your text was not saved or shortened — please retry once this is done.',
              detail: w.reason || 'the hr_reason column widen could not be applied',
            });
          }
          throw err;
        }
      }
    }

    if (body.hr_medcertdocid) {
      audit({ category: 'Leave', type: 'medcert_uploaded', title: 'Medical Certificate attached to Sick Leave',
        name: req.user.name, meta: { leaveId: leave.hr_hrleaveid, employeeId: req.user.id, docId: body.hr_medcertdocid, days: leaveDays } });
    }

    // Immediate acknowledgement to the employee (best-effort, non-blocking).
    requestNotify.emailApplyAcknowledgement({
      type: 'leave',
      toEmail: req.user.email,
      employeeName: req.user.name,
      approverName: approver.hr_hremployee1,
    });

    // Notify ONLY the selected approver (in-app + email w/ Approve/Reject buttons),
    // plus an informational (button-less) email to any CC recipients. Fire-and-
    // forget so mail/socket issues never block or fail Leave Apply.
    requestNotify.notifyNewRequest({
      type: 'leave',
      recordId: leave.hr_hrleaveid,
      actor: req.user,
      details: [
        ['Leave Type', toLabel('hr_leave_type', req.body.hr_leavetype)],
        ['From Date', time.fmtDate(req.body.hr_fromdate)],   // DD-MM-YYYY (global format)
        ['To Date', time.fmtDate(req.body.hr_todate)],
        ['Number of Days', req.body.hr_days],
        ['Reason', req.body.hr_reason],
      ],
      applyTime: new Date().toISOString(),
      approver: { id: approver.hr_hremployeeid, name: approver.hr_hremployee1, email: approver.hr_email },
      cc: ccRecipients,
    });

    // Notify L1 manager
    try {
      const chain = await getManagerChain(req.user.id);
      if (chain.l1Manager) {
        broadcast('leave:pending', {
          leaveId: leave.hr_hrleaveid,
          employeeName: req.user.name,
          type: req.body.hr_leavetype,
          from: req.body.hr_fromdate,
          to: req.body.hr_todate,
          approverName: chain.l1Manager.hr_hremployee1,
          level: 'L1',
        });
      }
    } catch (_) {}

    res.status(201).json(labelsForEntity('hr_hrleaves', leave));
  } catch (err) { next(err); }
});

// PATCH /api/attendance/leave/:id/l1 — L1 (Manager) approval
router.patch('/:id/l1', async (req, res, next) => {
  try {
    const { action, remarks } = req.body; // action: 'approved' or 'rejected'
    const leaveRecord = await d365.getByIdOptional(ENTITY, req.params.id, {
      select: 'hr_hrleaveid,_hr_hremployee_value,hr_status,hr_l1status,hr_l2status,hr_fromdate,hr_todate,hr_days,hr_ccrecipients,hr_leavetype',
      optionalSelect: 'hr_medcertdocid,hr_usecompoff',
    });

    // Verify this user is the L1 manager of the leave employee
    const chain = await getManagerChain(leaveRecord._hr_hremployee_value);
    const isL1 = chain.l1Manager && chain.l1Manager.hr_hremployeeid === req.user.id;
    const isSuperAdmin = req.user.role === 'super_admin';
    const isHR = req.user.role === 'hr_manager';

    if (!isL1 && !isSuperAdmin && !isHR) {
      return res.status(403).json({ error: 'You are not the reporting manager for this employee' });
    }

    const now = new Date().toISOString().split('T')[0];
    const updatePayload = {
      hr_l1status: action,
      hr_l1remarks: remarks || '',
      hr_l1approvedby: req.user.name,
      hr_l1date: now,
    };

    if (action === 'rejected') {
      // L1 rejected → final status = rejected
      updatePayload.hr_status = toValue('hr_leave_status', 'rejected');
      updatePayload.hr_remarks = `Rejected by ${req.user.name} (Manager)`;
    } else if (action === 'approved') {
      // Check if L2 is needed
      if (chain.l2Manager) {
        updatePayload.hr_l2status = 'pending_l2';
        // Notify L2 manager
        broadcast('leave:pending', {
          leaveId: leaveRecord.hr_hrleaveid,
          employeeName: chain.employee.hr_hremployee1,
          approverName: chain.l2Manager.hr_hremployee1,
          level: 'L2',
        });
      } else {
        // No L2 manager → final approval. Enforce the Medical-Certificate guard.
        await assertCertOkToApprove(leaveRecord);
        updatePayload.hr_status = toValue('hr_leave_status', 'approved');
        updatePayload.hr_l2status = 'not_required';
        updatePayload.hr_remarks = `Approved by ${req.user.name} (Manager)`;
      }
    }

    const leave = await d365.update(ENTITY, req.params.id, updatePayload);

    // Comp-off leave: deduct on final L1 approval (pending → approved) EXACTLY once.
    // Guard against a repeated approval re-deducting (idempotent — same as HR override).
    if (updatePayload.hr_status === toValue('hr_leave_status', 'approved')) {
      const wasApproved = toLabel('hr_leave_status', leaveRecord.hr_status) === 'approved';
      await applyCompOffUsageOnApprove(leaveRecord, { alreadyApproved: wasApproved });
      if (!wasApproved) await auditAndPayrollImpactOnApprove(leaveRecord, req.user, now);
    }

    // Notify employee (only when L1 produced a FINAL decision)
    if (action === 'rejected' || (!chain.l2Manager && action === 'approved')) {
      const finalStatus = action === 'approved' ? 'approved' : 'rejected';
      await notifyLeaveApproval(leaveRecord._hr_hremployee_value, finalStatus, {
        from: leaveRecord.hr_fromdate,
        to: leaveRecord.hr_todate,
      });
      requestNotify.emailDecisionToEmployee({
        type: 'leave', employeeId: leaveRecord._hr_hremployee_value,
        decision: finalStatus,
        approver: { name: req.user.name, email: req.user.email, role: req.user.role },
        remarks: updatePayload.hr_remarks, status: finalStatus,
        fromDate: leaveRecord.hr_fromdate, toDate: leaveRecord.hr_todate,
        leaveType: toLabel('hr_leave_type', leaveRecord.hr_leavetype),
        requestDays: resolveDays(leaveRecord.hr_days, leaveRecord.hr_fromdate, leaveRecord.hr_todate),
      });
    }

    broadcast('leave:updated', { leaveId: req.params.id, action, level: 'L1' });
    res.json(labelsForEntity('hr_hrleaves', leave));
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

// PATCH /api/attendance/leave/:id/l2 — L2 (Manager's Manager) approval
router.patch('/:id/l2', async (req, res, next) => {
  try {
    const { action, remarks } = req.body;
    const leaveRecord = await d365.getByIdOptional(ENTITY, req.params.id, {
      select: 'hr_hrleaveid,_hr_hremployee_value,hr_status,hr_l1status,hr_l2status,hr_fromdate,hr_todate,hr_days,hr_ccrecipients,hr_leavetype',
      optionalSelect: 'hr_medcertdocid,hr_usecompoff',
    });

    if (leaveRecord.hr_l1status !== 'approved') {
      return res.status(400).json({ error: 'L1 approval is required before L2' });
    }

    // Verify this user is the L2 manager
    const chain = await getManagerChain(leaveRecord._hr_hremployee_value);
    const isL2 = chain.l2Manager && chain.l2Manager.hr_hremployeeid === req.user.id;
    const isSuperAdmin = req.user.role === 'super_admin';
    const isHR = req.user.role === 'hr_manager';

    if (!isL2 && !isSuperAdmin && !isHR) {
      return res.status(403).json({ error: 'You are not the skip-level manager for this employee' });
    }

    const now = new Date().toISOString().split('T')[0];
    const updatePayload = {
      hr_l2status: action,
      hr_l2remarks: remarks || '',
      hr_l2approvedby: req.user.name,
      hr_l2date: now,
    };

    if (action === 'approved') {
      await assertCertOkToApprove(leaveRecord);   // Medical-Certificate guard (final approval)
      updatePayload.hr_status = toValue('hr_leave_status', 'approved');
      updatePayload.hr_remarks = `Approved by ${req.user.name} (L2 Manager)`;
    } else {
      updatePayload.hr_status = toValue('hr_leave_status', 'rejected');
      updatePayload.hr_remarks = `Rejected by ${req.user.name} (L2 Manager)`;
    }

    const leave = await d365.update(ENTITY, req.params.id, updatePayload);

    // Comp-off leave: deduct on final L2 approval EXACTLY once (guard re-approval).
    if (action === 'approved') {
      const wasApproved = toLabel('hr_leave_status', leaveRecord.hr_status) === 'approved';
      await applyCompOffUsageOnApprove(leaveRecord, { alreadyApproved: wasApproved });
      if (!wasApproved) await auditAndPayrollImpactOnApprove(leaveRecord, req.user, new Date().toISOString().split('T')[0]);
    }

    // Notify employee of final decision (in-app + email)
    const l2Final = action === 'approved' ? 'approved' : 'rejected';
    await notifyLeaveApproval(leaveRecord._hr_hremployee_value, l2Final, {
      from: leaveRecord.hr_fromdate,
      to: leaveRecord.hr_todate,
    });
    requestNotify.emailDecisionToEmployee({
      type: 'leave', employeeId: leaveRecord._hr_hremployee_value,
      decision: l2Final,
      approver: { name: req.user.name, email: req.user.email, role: req.user.role },
      remarks: updatePayload.hr_remarks, status: l2Final,
      fromDate: leaveRecord.hr_fromdate, toDate: leaveRecord.hr_todate,
      leaveType: toLabel('hr_leave_type', leaveRecord.hr_leavetype),
      requestDays: resolveDays(leaveRecord.hr_days, leaveRecord.hr_fromdate, leaveRecord.hr_todate),
    });

    broadcast('leave:updated', { leaveId: req.params.id, action, level: 'L2' });
    res.json(labelsForEntity('hr_hrleaves', leave));
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

// PATCH /api/attendance/leave/:id — Single-step approval (HR / Super-Admin override, from the UI)
router.patch('/:id', requireRole('super_admin', 'hr_manager'), async (req, res, next) => {
  try {
    const { status, remarks } = req.body;
    // UI override keeps existing behaviour (no pending-only guard).
    const leave = await applyHrOverride(req.user, req.params.id, status, remarks);
    res.json(labelsForEntity('hr_hrleaves', leave));
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

// POST /api/attendance/leave/:id/email-action — Approve/Reject from an email button.
// Security (backend is the only source of truth — frontend permission never trusted):
//   1. authenticateToken (mounted globally) → valid login JWT + logged-in user
//   2. requireRole → only Super Admin / HR may act on the emailed link
//   3. verifyApprovalToken → link is authentic and NOT expired
//   4. token {type,id} must match the URL → no tampering
//   5. enforcePending inside applyHrOverride → blocks duplicate approvals / replay
//      / already-finalised requests
router.post('/:id/email-action', requireRole('super_admin', 'hr_manager'), async (req, res, next) => {
  try {
    const { action, token, remarks } = req.body;
    if (!token) return res.status(400).json({ error: 'Approval token required' });

    let claim;
    try { claim = verifyApprovalToken(token); }
    catch (_) { return res.status(401).json({ error: 'Approval link is invalid or has expired' }); }

    if (claim.type !== 'leave' || claim.id !== req.params.id) {
      return res.status(400).json({ error: 'Approval link does not match this request' });
    }

    const decision = action || claim.action;
    if (!['approved', 'rejected'].includes(decision)) {
      return res.status(400).json({ error: 'Invalid action' });
    }

    // Authorization (single shared rule): the ASSIGNED approver may act, and so may any
    // user with an authorized HR/Admin approval role (super_admin/hr_manager) — e.g. a
    // CC'd Super Admin or HR Manager, whose email carried real Approve/Reject buttons.
    // CC membership alone grants nothing: a normal CC user is already blocked by the
    // requireRole gate above (→ 403) and fails this rule too. Status is enforced by
    // applyHrOverride(enforcePending) below.
    const rec = await d365.getById(ENTITY, req.params.id, { select: 'hr_approverid' });
    if (!requestNotify.canActOnApproval({ role: req.user.role, userId: req.user.id, approverId: rec.hr_approverid })) {
      return res.status(403).json({ error: 'You are not authorized to approve this request.' });
    }

    const leave = await applyHrOverride(req.user, req.params.id, decision, remarks, { enforcePending: true });
    res.json(labelsForEntity('hr_hrleaves', leave));
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

// GET /api/attendance/leave/pending-approvals — Leaves pending my approval
router.get('/pending-approvals', async (req, res, next) => {
  try {
    // Get my direct reports
    const { data: reportees } = await d365.getList(EMP_ENTITY, {
      filter: `_hr_manager_value eq '${req.user.id}'`,
      select: 'hr_hremployeeid',
    });
    const reporteeIds = reportees.map(r => r.hr_hremployeeid);

    if (reporteeIds.length === 0) {
      return res.json({ data: [], count: 0 });
    }

    // Get all pending leaves for my reportees
    const orFilter = reporteeIds.map(id => `_hr_hremployee_value eq '${id}'`).join(' or ');
    const result = await d365.getList(ENTITY, {
      select: 'hr_hrleaveid,hr_leavetype,hr_fromdate,hr_todate,hr_days,hr_reason,hr_status,hr_remarks,_hr_hremployee_value,hr_l1status,hr_l1remarks,hr_l1approvedby,hr_l1date,hr_l2status,hr_l2remarks,hr_l2approvedby,hr_l2date',
      filter: `(${orFilter}) and hr_l1status eq 'pending'`,
      orderby: 'createdon desc',
    });

    // Also check if I'm L2 for any leaves (my reportees' reportees)
    const { data: subReportees } = await d365.getList(EMP_ENTITY, {
      filter: reporteeIds.map(id => `_hr_manager_value eq '${id}'`).join(' or '),
      select: 'hr_hremployeeid',
    });
    const subIds = subReportees.map(r => r.hr_hremployeeid);

    if (subIds.length > 0) {
      const subFilter = subIds.map(id => `_hr_hremployee_value eq '${id}'`).join(' or ');
      const l2Result = await d365.getList(ENTITY, {
        select: 'hr_hrleaveid,hr_leavetype,hr_fromdate,hr_todate,hr_days,hr_reason,hr_status,hr_remarks,_hr_hremployee_value,hr_l1status,hr_l1remarks,hr_l1approvedby,hr_l1date,hr_l2status,hr_l2remarks,hr_l2approvedby,hr_l2date',
        filter: `(${subFilter}) and hr_l2status eq 'pending_l2'`,
        orderby: 'createdon desc',
      });
      result.data = [...result.data, ...l2Result.data];
      result.count = result.data.length;
    }

    res.json(labelsForList('hr_hrleaves', result));
  } catch (err) { next(err); }
});

// ════════════════════════════════════════════════════════════════════════
//  LEAVE ENGINE — balances, comp-off, manual adjustments (Phase 3)
//  Mounted under /api/attendance/leave. Additive — the existing apply/approve
//  flow above is untouched.
// ════════════════════════════════════════════════════════════════════════

// GET /medcert-policy — the current Sick-Leave certificate policy (so the Apply UI
// knows the threshold without hardcoding it). Configurable in Payroll Settings.
router.get('/medcert-policy', async (req, res, next) => {
  try {
    const { medCert } = await payrollSettings.getResolved();
    const afterDays = Number(medCert?.afterDays) || 1;
    res.json({ required: !!medCert?.required, afterDays, threshold: afterDays + 1 });
  } catch (_) {
    res.json({ required: false, afterDays: 1, threshold: 2 });
  }
});

// GET /medcert-check?from=&to=  — is a certificate required for THIS Sick-Leave
// request, given the employee's consecutive-run history? Powers the Apply UI.
router.get('/medcert-check', async (req, res, next) => {
  try {
    const from = String(req.query.from || '').slice(0, 10);
    const to = String(req.query.to || from).slice(0, 10);
    const excludeLeaveId = req.query.excludeLeaveId || undefined;   // set while EDITING (don't count self)
    if (!from) return res.json({ required: false, runDays: 0, threshold: 2 });
    const runDays = await sickRun.sickLeaveRunDays(req.user.id, from, to, { excludeLeaveId });
    const policy = await medCertPolicy('Sick Leave', runDays);
    // Consecutive-day Medical Certificate rule OR the new weekly-repeat rule.
    let required = policy.required, message = policy.message, reason = policy.required ? 'consecutive_days' : null;
    if (!required) {
      const weekly = await validateSickLeaveDocumentRequirement(req.user.id, from, to, { excludeLeaveId });
      if (weekly.required) { required = true; message = weekly.message; reason = 'weekly_repeat'; }
    }
    res.json({ required, runDays, threshold: policy.threshold, message, reason });
  } catch (_) {
    res.json({ required: false, runDays: 0, threshold: 2 });
  }
});

// GET /balance  — full leave-balance picture (dashboard). Self, or HR ?employeeId.
router.get('/balance', async (req, res, next) => {
  try {
    const isHR = HR_ROLES.includes(req.user.role);
    const employeeId = isHR ? (req.query.employeeId || req.user.id) : req.user.id;
    const year = Number(req.query.year) || new Date().getFullYear();
    const balance = await leaveEngine.getBalance(employeeId, year);
    // Enrich for the dashboard: nearest comp-off expiry + Earned Leave (only surfaced
    // when enabled in Payroll Settings). Best-effort — never breaks the balance read.
    try {
      balance.compOff = balance.compOff || {};
      balance.compOff.nextExpiry = await compOffSvc.nextExpiry(employeeId);
      const resolved = await payrollSettings.getResolved();
      const earnedLeave = resolved.earnedLeave;
      const allocated = Number(earnedLeave?.allocated) || 0;
      const used = Number(balance.earned?.used) || 0;
      balance.earnedLeave = { enabled: !!earnedLeave?.enabled, allocated, used, remaining: Math.max(0, allocated - used) };
      balance.maxBackdatedLeaveDays = Number(resolved.maxBackdatedLeaveDays) || 30;   // backdated-apply window
    } catch (_) { /* enrichment optional */ }
    res.json(balance);
  } catch (err) { next(err); }
});

// GET /ledger  — comp-off + adjustment transactions. Self, or HR ?employeeId.
router.get('/ledger', async (req, res, next) => {
  try {
    const isHR = HR_ROLES.includes(req.user.role);
    const employeeId = isHR ? (req.query.employeeId || req.user.id) : req.user.id;
    const year = Number(req.query.year) || new Date().getFullYear();
    const ledger = await leaveEngine.readLedger(employeeId, year);
    res.json({ data: ledger, count: ledger.length });
  } catch (err) { next(err); }
});

// Shared helper for the two write endpoints: resolve employee name + persist a
// ledger entry (self-provisioning the table on first use).
async function writeLedger(req, res, { kind, category, days, reason }) {
  const employeeId = req.body.employeeId;
  if (!employeeId || !/^[0-9a-fA-F-]{36}$/.test(String(employeeId))) {
    return res.status(400).json({ error: 'A valid employee is required.' });
  }
  const n = Number(days);
  if (!Number.isFinite(n) || n === 0) return res.status(400).json({ error: 'Days must be a non-zero number.' });

  const effectiveDate = String(req.body.date || new Date().toISOString().slice(0, 10)).slice(0, 10);
  const year = Number(effectiveDate.slice(0, 4)) || new Date().getFullYear();
  let employeeName = '';
  try { const emp = await d365.getById(EMP_ENTITY, employeeId, { select: 'hr_hremployee1' }); employeeName = emp?.hr_hremployee1 || ''; } catch {}

  const doWrite = () => leaveEngine.addLedgerEntry({
    employeeId, employeeName, year, kind, category, days: n,
    effectiveDate, reason, createdBy: req.user?.name || req.user?.email || 'HR',
  });
  try {
    await doWrite();
  } catch (err) {
    if (/Resource not found for the segment|does not exist|Could not find/i.test(err.message)) {
      await ensureLeaveLedgerTable(global.logger || console).catch(() => {});
      await doWrite();
    } else { throw err; }
  }
  const balance = await leaveEngine.getBalance(employeeId, year);
  res.status(201).json({ message: 'Saved', balance });
}

// POST /compoff  — grant ('earn') or consume ('use') comp-off (HR / Super Admin).
router.post('/compoff', requireRole('super_admin', 'hr_manager'), async (req, res, next) => {
  try {
    const action = req.body.action === 'use' ? 'use' : 'earn';
    const kind = action === 'use' ? 'comp_off_used' : 'comp_off_earned';
    await writeLedger(req, res, { kind, category: 'compoff', days: Math.abs(Number(req.body.days)), reason: req.body.reason });
  } catch (err) {
    console.error('[leave/compoff] FAILED:', err.message);
    res.status(err.status || 400).json({ error: err.message || 'Failed to save comp-off' });
  }
});

// POST /adjust  — manual balance adjustment, signed days (HR / Super Admin).
router.post('/adjust', requireRole('super_admin', 'hr_manager'), async (req, res, next) => {
  try {
    const category = ['casual', 'sick', 'compoff'].includes(req.body.category) ? req.body.category : 'casual';
    await writeLedger(req, res, { kind: 'adjustment', category, days: Number(req.body.days), reason: req.body.reason });
  } catch (err) {
    console.error('[leave/adjust] FAILED:', err.message);
    res.status(err.status || 400).json({ error: err.message || 'Failed to adjust balance' });
  }
});

// POST /carry-forward — run the Casual Leave YEAR-END carry-forward for all active
// employees (HR / Super Admin). carry = MIN(prev-year CL remaining, max — default 5).
// IDEMPOTENT: re-running never double-credits. ?fromYear=2026[&toYear=2027] (toYear
// defaults to fromYear+1). Reuses the existing leave ledger — no parallel balance system.
router.post('/carry-forward', requireRole('super_admin', 'hr_manager'), async (req, res, next) => {
  try {
    const fromYear = Number(req.query.fromYear || req.body?.fromYear);
    const toYear = Number(req.query.toYear || req.body?.toYear) || (fromYear ? fromYear + 1 : 0);
    if (!fromYear) return res.status(400).json({ error: 'fromYear is required (e.g. ?fromYear=2026).' });
    const result = await leaveEngine.rollCasualLeaveForward({ fromYear, toYear, createdBy: req.user?.name || req.user?.email || 'HR' });
    res.json(result);
  } catch (err) { if (err.status) return res.status(err.status).json({ error: err.message }); next(err); }
});

module.exports = router;
