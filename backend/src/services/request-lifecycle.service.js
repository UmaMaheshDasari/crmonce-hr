/**
 * Request Lifecycle — ONE reusable engine for every employee-request module
 * (Leave, Late Login, Attendance Correction, Comp Off, Document Verification,
 * Goals, and any future module). Modules DO NOT duplicate delete/resubmit/cancel/
 * audit/notify logic — they register a small adapter (see request-adapters.js) and
 * this engine enforces the common status rules, writes the shared audit trail and
 * fires the email + in-app notifications.
 *
 * Canonical status (derived by each adapter from its own fields):
 *   pending | manager_approved | approved | rejected | cancelled
 *
 * Rules (enforced centrally):
 *   pending           → employee may EDIT / DELETE (delete = permanent) / request cancel
 *   rejected          → employee may DELETE or EDIT & RESUBMIT (new cycle, history kept)
 *   manager_approved  → employee may ONLY request cancellation
 *   approved          → employee may ONLY request cancellation (manager → HR)
 *   cancelled         → view only
 *
 * On cancellation APPROVED the adapter marks its record 'cancelled'; because leave
 * balance, the late-login attendance overlay, dashboard counts and (unlocked)
 * payroll are all DERIVED from record status, they self-restore — no manual
 * balance/attendance/payroll surgery here.
 */
const d365 = require('./d365.service');
const { AUDIT_SET, CANCEL_SET } = require('./provision-request-lifecycle');
let notif; try { notif = require('./notification.service'); } catch (_) { notif = null; }

const esc = (v) => String(v ?? '').replace(/'/g, "''");
const nowIso = () => new Date().toISOString();

// ── adapter registry ──────────────────────────────────────────────────────────
const adapters = new Map();
/** Register a module adapter. See request-adapters.js for the shape + examples. */
function registerAdapter(a) { adapters.set(a.type, a); return a; }
function getAdapter(type) { const a = adapters.get(type); if (!a) { const e = new Error(`Unknown request type '${type}'`); e.status = 400; throw e; } return a; }
function knownTypes() { return [...adapters.keys()]; }

// ── audit trail (shared across all modules) ───────────────────────────────────
async function writeAudit({ employeeId, employeeName, requestId, requestType, action, performedBy, detail }) {
  try {
    await d365.create(AUDIT_SET, {
      hr_name: `${employeeName || employeeId || ''} · ${requestType} · ${action}`.slice(0, 250),
      hr_employeeid: String(employeeId || ''), hr_employeename: employeeName || '',
      hr_requestid: String(requestId || ''), hr_requesttype: requestType, hr_action: action,
      hr_performedby: performedBy || '', hr_at: nowIso(), hr_detail: detail || '',
    });
  } catch (e) { global.logger?.warn?.(`[lifecycle] audit skipped: ${e.message}`); }
}

async function getAudit({ type, id }) {
  try {
    const { data } = await d365.getList(AUDIT_SET, {
      select: 'hr_requestauditid,hr_employeename,hr_action,hr_performedby,hr_at,hr_detail,createdon',
      filter: `hr_requesttype eq '${esc(type)}' and hr_requestid eq '${esc(id)}'`,
      orderby: 'createdon desc', top: 200,
    });
    return (data || []).map(r => ({
      id: r.hr_requestauditid, action: r.hr_action, performedBy: r.hr_performedby,
      at: r.hr_at || r.createdon, detail: r.hr_detail || '', employeeName: r.hr_employeename || '',
    }));
  } catch { return []; }
}

// ── notifications (email + in-app) ────────────────────────────────────────────
async function email(to, subject, html) { try { if (to && notif?.sendEmail) await notif.sendEmail(to, subject, html, { meta: { type: 'lifecycle' } }); } catch (e) { global.logger?.warn?.(`[lifecycle] email skipped: ${e.message}`); } }
function ping(ids, event, payload) { try { for (const id of ids || []) notif?.notifyUser?.(id, event, payload); notif?.broadcast?.(event, payload); } catch (_) {} }
async function notifyMany(recipients, event, subject, html, payload) {
  const emails = [...new Set((recipients?.emails || []).filter(Boolean))];
  for (const to of emails) await email(to, subject, html);
  ping(recipients?.ids || [], event, payload);
}

// ── cancellation store (shared) ───────────────────────────────────────────────
const cShape = (r) => ({
  id: r.hr_cancellationrequestid, employeeId: r.hr_employeeid, employeeName: r.hr_employeename,
  requestId: r.hr_requestid, requestType: r.hr_requesttype, requestTypeLabel: adapters.get(r.hr_requesttype)?.label || r.hr_requesttype,
  reason: r.hr_reason || '', status: r.hr_status || 'pending', managerStatus: r.hr_managerstatus || 'pending',
  approvedBy: r.hr_approvedby || '', approvedDate: r.hr_approveddate || '', remarks: r.hr_remarks || '', createdOn: r.createdon,
});
async function activeCancellation(type, id) {
  try {
    const { data } = await d365.getList(CANCEL_SET, {
      select: 'hr_cancellationrequestid,hr_employeeid,hr_employeename,hr_requestid,hr_requesttype,hr_reason,hr_status,hr_managerstatus,hr_approvedby,hr_approveddate,hr_remarks,createdon',
      filter: `hr_requesttype eq '${esc(type)}' and hr_requestid eq '${esc(id)}' and hr_status eq 'pending'`, orderby: 'createdon desc', top: 1,
    });
    return data && data[0] ? cShape(data[0]) : null;
  } catch { return null; }
}
async function getCancellationRaw(cancellationId) {
  const { data } = await d365.getList(CANCEL_SET, {
    select: 'hr_cancellationrequestid,hr_employeeid,hr_employeename,hr_requestid,hr_requesttype,hr_reason,hr_status,hr_managerstatus,hr_approvedby,hr_approveddate,hr_remarks,createdon',
    filter: `hr_cancellationrequestid eq ${cancellationId}`, top: 1,
  });
  return data && data[0] ? cShape(data[0]) : null;
}

// ── the canonical request view (adapter-resolved) ─────────────────────────────
async function view({ type, id }) {
  const adapter = getAdapter(type);
  const raw = await adapter.get(id);
  if (!raw) { const e = new Error(`${adapter.label} request not found`); e.status = 404; throw e; }
  const canonical = adapter.status(raw);
  const cancellation = ['approved', 'manager_approved'].includes(canonical) ? await activeCancellation(type, id) : null;
  return {
    adapter, raw, canonical,
    ownerId: adapter.ownerId(raw), ownerName: adapter.ownerName(raw),
    summary: adapter.summary ? adapter.summary(raw) : '',
    cancellation,
  };
}

// Assert the caller owns the request (HR bypasses).
function assertOwner(v, user) {
  const isHR = ['super_admin', 'hr_manager'].includes(user.role);
  if (!isHR && v.ownerId !== user.id) { const e = new Error('Access denied'); e.status = 403; throw e; }
}

// ── operations ────────────────────────────────────────────────────────────────

/** DELETE — permanent removal. Allowed only for pending or rejected requests. */
async function remove({ type, id, user }) {
  const v = await view({ type, id }); assertOwner(v, user);
  if (v.adapter.canDelete === false) { const e = new Error(`${v.adapter.label} requests cannot be deleted here.`); e.status = 400; throw e; }
  if (!['pending', 'rejected'].includes(v.canonical)) {
    const e = new Error(`A ${v.canonical} request cannot be deleted. Request a cancellation instead.`); e.status = 400; throw e;
  }
  await v.adapter.delete(id);
  await writeAudit({ employeeId: v.ownerId, employeeName: v.ownerName, requestId: id, requestType: type, action: 'deleted', performedBy: user.name || user.email, detail: v.summary });
  const rec = await v.adapter.managerRecipients(v.raw).catch(() => ({}));
  const hr = await v.adapter.hrRecipients().catch(() => ({}));
  const subj = `${v.adapter.label} request deleted`;
  const html = `<p>${v.ownerName || 'An employee'} deleted a ${v.adapter.label} request${v.summary ? ` (${v.summary})` : ''}.</p>`;
  await notifyMany({ emails: [...(rec.emails || []), ...(hr.emails || [])], ids: [...(rec.ids || []), ...(hr.ids || [])] }, 'request:deleted', subj, html, { type, id });
  return { deleted: true };
}

/** EDIT & RESUBMIT — rejected → new pending cycle (audit history preserved). */
async function resubmit({ type, id, edits, user }) {
  const v = await view({ type, id }); assertOwner(v, user);
  if (v.adapter.canResubmit === false) { const e = new Error(`${v.adapter.label} requests cannot be resubmitted here.`); e.status = 400; throw e; }
  if (v.canonical !== 'rejected') { const e = new Error('Only a rejected request can be resubmitted.'); e.status = 400; throw e; }
  const patch = { ...v.adapter.applyEdits(edits || {}), ...v.adapter.resubmitPatch() };
  await d365.update(v.adapter.entity, id, patch);
  await writeAudit({ employeeId: v.ownerId, employeeName: v.ownerName, requestId: id, requestType: type, action: 'resubmitted', performedBy: user.name || user.email, detail: v.summary });
  const rec = await v.adapter.managerRecipients(v.raw).catch(() => ({}));
  const hr = await v.adapter.hrRecipients().catch(() => ({}));
  const subj = `${v.adapter.label} request resubmitted`;
  const html = `<p>${v.ownerName || 'An employee'} resubmitted a ${v.adapter.label} request${v.summary ? ` (${v.summary})` : ''} for a fresh approval.</p>`;
  await notifyMany({ emails: [...(rec.emails || []), ...(hr.emails || [])], ids: [...(rec.ids || []), ...(hr.ids || [])] }, 'request:resubmitted', subj, html, { type, id });
  return v.adapter.get(id);
}

/** REQUEST CANCELLATION — approved / manager_approved → employee asks to cancel. */
async function requestCancellation({ type, id, reason, user }) {
  const v = await view({ type, id }); assertOwner(v, user);
  if (v.adapter.canCancel === false) { const e = new Error(`${v.adapter.label} requests do not support cancellation.`); e.status = 400; throw e; }
  if (!['approved', 'manager_approved'].includes(v.canonical)) {
    const e = new Error('Only an approved request can be cancelled via a cancellation request.'); e.status = 400; throw e;
  }
  if (v.cancellation) { const e = new Error('A cancellation request is already pending for this request.'); e.status = 400; throw e; }
  await d365.create(CANCEL_SET, {
    hr_name: `${v.ownerName || v.ownerId} · ${v.adapter.label} cancel · ${id}`.slice(0, 250),
    hr_employeeid: String(v.ownerId || ''), hr_employeename: v.ownerName || '',
    hr_requestid: String(id), hr_requesttype: type, hr_reason: reason || '',
    hr_status: 'pending', hr_managerstatus: 'pending',
  });
  await writeAudit({ employeeId: v.ownerId, employeeName: v.ownerName, requestId: id, requestType: type, action: 'cancellation_requested', performedBy: user.name || user.email, detail: reason || v.summary });
  const rec = await v.adapter.managerRecipients(v.raw).catch(() => ({}));
  const hr = await v.adapter.hrRecipients().catch(() => ({}));
  const subj = `${v.adapter.label} cancellation requested`;
  const html = `<p>${v.ownerName || 'An employee'} requested cancellation of an APPROVED ${v.adapter.label} request${v.summary ? ` (${v.summary})` : ''}.</p>${reason ? `<p><b>Reason:</b> ${reason}</p>` : ''}<p>Please review in the HR portal.</p>`;
  await notifyMany({ emails: [...(rec.emails || []), ...(hr.emails || [])], ids: [...(rec.ids || []), ...(hr.ids || [])] }, 'request:cancellation_requested', subj, html, { type, id });
  return activeCancellation(type, id);
}

async function notifyEmployeeCancellation(v, id, action, remarks) {
  let emp = {};
  try { if (v.adapter.employeeContact) emp = await v.adapter.employeeContact(v.raw) || {}; } catch (_) {}
  const subj = `${v.adapter.label} cancellation ${action}`;
  const html = `<p>Your request to cancel a ${v.adapter.label} request${v.summary ? ` (${v.summary})` : ''} has been <b>${action}</b>.</p>${remarks ? `<p><b>Remarks:</b> ${remarks}</p>` : ''}`;
  if (emp.email) await email(emp.email, subj, html);
  ping([v.ownerId], `request:cancellation_${action}`, { type: v.adapter.type, id });
}

/** Manager step of a cancellation. action = approved | rejected. */
async function cancellationManagerDecide({ type, id, action, approver, remarks }) {
  const v = await view({ type, id });
  const c = v.cancellation || await activeCancellation(type, id);
  if (!c) { const e = new Error('No pending cancellation request.'); e.status = 404; throw e; }
  const patch = { hr_managerstatus: action };
  if (action === 'rejected') { patch.hr_status = 'rejected'; patch.hr_approvedby = approver?.name || 'Manager'; patch.hr_approveddate = nowIso(); if (remarks) patch.hr_remarks = remarks; }
  await d365.update(CANCEL_SET, c.id, patch);
  if (action === 'rejected') {
    await writeAudit({ employeeId: c.employeeId, employeeName: c.employeeName, requestId: id, requestType: type, action: 'cancellation_rejected', performedBy: approver?.name, detail: `Manager rejected${remarks ? ': ' + remarks : ''}` });
    await notifyEmployeeCancellation(v, id, 'rejected', remarks);
  } else {
    // Awaiting HR — notify HR queue.
    const hr = await v.adapter.hrRecipients().catch(() => ({}));
    await notifyMany(hr, 'request:cancellation_manager_approved', `${v.adapter.label} cancellation — HR review`, `<p>A ${v.adapter.label} cancellation for ${c.employeeName || 'an employee'} was approved by the manager and awaits HR.</p>`, { type, id });
  }
  return getCancellationRaw(c.id);
}

/** HR step of a cancellation. On approve → mark the original record cancelled. */
async function cancellationHrDecide({ type, id, action, approver, remarks }) {
  const v = await view({ type, id });
  const c = v.cancellation || await activeCancellation(type, id);
  if (!c) { const e = new Error('No pending cancellation request.'); e.status = 404; throw e; }
  const patch = { hr_status: action, hr_approvedby: approver?.name || 'HR', hr_approveddate: nowIso() };
  if (action === 'approved') patch.hr_managerstatus = 'approved';
  if (remarks) patch.hr_remarks = remarks;
  await d365.update(CANCEL_SET, c.id, patch);
  if (action === 'approved') {
    // Effect: cancel the underlying request. An adapter with onCancelled OWNS the
    // effect (e.g. Comp Off reverses its ledger AND sets the status); otherwise we
    // just mark the record cancelled — balance/attendance/dashboard/(unlocked)
    // payroll all derive from status and self-restore.
    if (v.adapter.onCancelled) await v.adapter.onCancelled({ id, raw: v.raw, approver, remarks });
    else await d365.update(v.adapter.entity, id, v.adapter.cancelledPatch());
    await writeAudit({ employeeId: c.employeeId, employeeName: c.employeeName, requestId: id, requestType: type, action: 'cancellation_approved', performedBy: approver?.name, detail: remarks || v.summary });
    await notifyEmployeeCancellation(v, id, 'approved', remarks);
  } else {
    await writeAudit({ employeeId: c.employeeId, employeeName: c.employeeName, requestId: id, requestType: type, action: 'cancellation_rejected', performedBy: approver?.name, detail: `HR rejected${remarks ? ': ' + remarks : ''}` });
    await notifyEmployeeCancellation(v, id, 'rejected', remarks);
  }
  return getCancellationRaw(c.id);
}

/** Pending cancellation requests across all modules (HR/manager queue). */
async function listCancellations({ status = 'pending' } = {}) {
  try {
    const { data } = await d365.getList(CANCEL_SET, {
      select: 'hr_cancellationrequestid,hr_employeeid,hr_employeename,hr_requestid,hr_requesttype,hr_reason,hr_status,hr_managerstatus,hr_approvedby,hr_approveddate,hr_remarks,createdon',
      filter: status ? `hr_status eq '${esc(status)}'` : undefined, orderby: 'createdon desc', top: 500,
    });
    return (data || []).map(cShape);
  } catch { return []; }
}

module.exports = {
  registerAdapter, getAdapter, knownTypes,
  view, remove, resubmit, requestCancellation,
  cancellationManagerDecide, cancellationHrDecide,
  getAudit, listCancellations, writeAudit,
};
