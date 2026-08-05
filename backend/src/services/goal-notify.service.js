/**
 * Goal Assignment notifications.
 *
 * Fired AFTER a goal is successfully created in Dataverse (never before, never on
 * failure). Best-effort and non-throwing: an email/notification failure NEVER
 * rolls back or fails the goal — the goal stays assigned.
 *
 * Does three things:
 *   1. Email the employee (TO), CC the reporting manager + optional HR mailbox.
 *   2. Create an in-app notification (Socket.io → the notification bell).
 *   3. Add a Recent Activity entry ("X assigned a new goal to Y").
 * Then writes an audit trail back onto the goal record (Email Sent / time /
 * Notification Created), best-effort.
 *
 * Reuses the existing infrastructure: notification.service (Graph sendMail +
 * Socket.io), email/templates, email/sender, activity.service, d365.service.
 */
const d365 = require('./d365.service');
const { sendEmail, notifyUser, verifyMailbox, GRAPH_SENDER } = require('./notification.service');
const { resolveSender, isPlaceholder } = require('./email/sender');
const activity = require('./activity.service');
const T = require('./email/templates');
const ecfg = require('./email/config');

const EMP = d365.constructor.entities.employee;
const GOAL = d365.constructor.entities.goal;

// Guard against double-sends for the same goal within a process (idempotency —
// "no duplicate emails"). A goal is created once, so this only matters if the
// notify path is somehow re-entered.
const emailedGoals = new Set();

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 'YYYY-MM-DD' → '31-Dec-2026' (returns the input unchanged if unparseable). */
function fmtDate(d) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(d || ''));
  if (!m) return d || '—';
  return `${m[3]}-${MONTHS[Number(m[2]) - 1] || m[2]}-${m[1]}`;
}
const cap = (s) => (s ? String(s).charAt(0).toUpperCase() + String(s).slice(1) : s);

/**
 * Send the assignment email with a bounded retry so a TRANSIENT Graph failure
 * (timeout / 429 / 5xx) is retried instead of silently lost. Permanent failures
 * (no recipient) are not retried. Returns the final { success } from sendEmail.
 */
async function sendWithRetry(to, subject, html, opts, { attempts = 3, delayMs = 800 } = {}) {
  let last = { success: false, error: 'not attempted' };
  for (let i = 1; i <= attempts; i++) {
    last = await sendEmail(to, subject, html, opts);
    if (last?.success) return { ...last, attempts: i };
    // 'no recipients' is permanent — don't burn retries on it.
    if (/no recipients/i.test(last?.error || '')) break;
    if (i < attempts) {
      global.logger?.warn(`[goal] assignment email attempt ${i}/${attempts} failed (${last?.error}) — retrying in ${delayMs}ms`);
      await sleep(delayMs);
    }
  }
  return { ...last, attempts };
}

/**
 * Notify the employee that a goal was assigned.
 * @param {object} p
 * @param {object} p.goal      the created goal record (hr_hrgoalid, hr_hrgoal1, …)
 * @param {object} p.assigner  { name, email }  — the logged-in HR/manager
 * @param {string} p.employeeId  the employee GUID
 * @returns {Promise<{emailSent:boolean, emailSentTime:string|null, notificationCreated:boolean, cc:string[]}>}
 */
async function notifyGoalAssigned({ goal, assigner, employeeId }) {
  const audit = { emailSent: false, emailSentTime: null, notificationCreated: false, cc: [] };
  try {
    const goalId = goal?.hr_hrgoalid;
    const goalTitle = goal?.hr_hrgoal1 || 'New Goal';
    const assignedBy = assigner?.name || assigner?.email || 'HR';
    const assignedOn = fmtDate(goal?.hr_assigneddate || new Date().toISOString().slice(0, 10));

    // ── Resolve the employee (TO) + reporting manager (CC) ──
    let emp;
    try { emp = await d365.getById(EMP, employeeId, { select: 'hr_hremployee1,hr_email,_hr_manager_value' }); }
    catch (e) { global.logger?.warn(`[goal] employee lookup failed for ${employeeId}: ${e.message}`); }
    const employeeName = emp?.hr_hremployee1 || goal?.hr_employeename || 'Employee';
    const toEmail = emp?.hr_email;

    // ── In-app notification (bell) — unread until opened. Do this regardless of
    //    email so the employee is always notified in-app. ──
    try {
      notifyUser(employeeId, 'goal:assigned', {
        id: goalId, title: goalTitle, assignedBy, assignedDate: assignedOn,
      });
      audit.notificationCreated = true;
    } catch (e) { global.logger?.warn(`[goal] in-app notification failed: ${e.message}`); }

    // ── Recent Activity: "X assigned a new goal to Y" ──
    try {
      activity.record({
        category: 'Performance', type: 'goal_assigned', title: 'Goal Assigned',
        name: assignedBy, meta: `${assignedBy} assigned a new goal to ${employeeName}`,
      });
    } catch (e) { global.logger?.warn(`[goal] activity record failed: ${e.message}`); }

    // ── Email the employee ──
    if (!toEmail || isPlaceholder(toEmail)) {
      global.logger?.warn(`[goal] assignment email skipped — employee ${employeeName} has no valid email`);
    } else if (goalId && emailedGoals.has(goalId)) {
      global.logger?.info(`[goal] assignment email already sent for goal ${goalId} — skipping duplicate`);
      audit.emailSent = true;   // already sent earlier
    } else {
      // FROM = the logged-in assigner's OWN company mailbox when usable; otherwise
      // fall back to info@crmonce.com (GRAPH_SENDER). App-only Graph can send AS
      // any real tenant mailbox.
      let from = GRAPH_SENDER;
      const s = resolveSender({ email: assigner?.email, label: 'Assigner' });
      if (s.ok) {
        const v = await verifyMailbox(s.sender);
        if (v.ok) from = s.sender;
        else global.logger?.warn(`[goal] assigner mailbox ${s.sender} unusable (${v.reason}) — sending from ${GRAPH_SENDER}`);
      } else {
        global.logger?.info(`[goal] assigner mailbox not usable (${s.reason}) — sending from ${GRAPH_SENDER}`);
      }

      // CC: reporting manager (if any) + optional HR mailbox (env GOAL_CC_HR).
      const ccSet = new Set();
      if (emp?._hr_manager_value) {
        try {
          const mgr = await d365.getById(EMP, emp._hr_manager_value, { select: 'hr_email' });
          if (mgr?.hr_email && !isPlaceholder(mgr.hr_email)) ccSet.add(mgr.hr_email.toLowerCase());
        } catch { /* manager email optional */ }
      }
      const hrMailbox = process.env.GOAL_CC_HR;   // optional HR mailbox
      if (hrMailbox && !isPlaceholder(hrMailbox)) ccSet.add(hrMailbox.toLowerCase());
      ccSet.delete(String(toEmail).toLowerCase());   // never CC the primary recipient
      audit.cc = [...ccSet];

      const { subject, html } = T.goalAssigned({
        employeeName, goalTitle,
        description: goal?.hr_description,
        quarter: goal?.hr_quarter,
        financialYear: goal?.hr_financialyear,
        priority: cap(goal?.hr_priority),
        weightage: goal?.hr_weightage ?? 0,
        dueDate: fmtDate(goal?.hr_duedate),
        assignedBy, assignedOn,
        viewUrl: `${ecfg.brand.appUrl}/goals`,
      });

      const r = await sendWithRetry(toEmail, subject, html, {
        from, cc: audit.cc, meta: { type: 'goal_assigned' },
      });
      audit.emailSent = !!r?.success;
      audit.emailSentTime = r?.success ? new Date().toISOString() : null;
      if (r?.success && goalId) emailedGoals.add(goalId);

      global.logger?.[r?.success ? 'info' : 'error'](
        `[goal] assignment email FROM ${from} → ${toEmail} (cc: ${audit.cc.join(', ') || 'none'}): ` +
        `${r?.success ? `sent in ${r.attempts} attempt(s)` : `FAILED after ${r?.attempts} attempt(s) — ${r?.error}. Goal remains assigned; retry later.`}`);
    }

    // ── Durable audit onto the goal record (best-effort; never fails the flow) ──
    if (goalId) {
      try {
        await d365.update(GOAL, goalId, {
          hr_emailsent: audit.emailSent ? 'sent' : 'failed',
          hr_emailsenttime: audit.emailSentTime || '',
          hr_notificationcreated: audit.notificationCreated ? 'true' : 'false',
        });
      } catch (e) { global.logger?.warn(`[goal] audit write skipped: ${e.message}`); }
    }

    global.logger?.info(`GOAL_AUDIT ${JSON.stringify({
      goalId, assignedBy, assignedOn,
      emailSent: audit.emailSent, emailSentTime: audit.emailSentTime,
      notificationCreated: audit.notificationCreated, cc: audit.cc,
    })}`);
  } catch (err) {
    // Absolute backstop — a notification error must never surface to the caller.
    global.logger?.error(`notifyGoalAssigned failed: ${err.message}`);
  }
  return audit;
}

/**
 * A goal was RE-ASSIGNED to a different employee. Notify BOTH:
 *   - the NEW employee (full assignment email + in-app + activity), and
 *   - the OLD employee (their goal was moved away).
 * Best-effort, never throws.
 */
async function notifyGoalReassigned({ goal, assigner, oldEmployeeId, newEmployeeId }) {
  try {
    // New assignee — the standard assignment flow (email + bell + activity).
    if (newEmployeeId) {
      emailedGoals.delete(goal?.hr_hrgoalid);   // allow the reassignment email through
      await notifyGoalAssigned({ goal, assigner, employeeId: newEmployeeId }).catch(() => {});
    }
    // Old assignee — inform them the goal was reassigned.
    if (oldEmployeeId && oldEmployeeId !== newEmployeeId) {
      const title = goal?.hr_hrgoal1 || 'Goal';
      const by = assigner?.name || assigner?.email || 'HR';
      notifyUser(oldEmployeeId, 'goal:reassigned', { title, assignedBy: by });
      try {
        const emp = await d365.getById(EMP, oldEmployeeId, { select: 'hr_hremployee1,hr_email' });
        if (emp?.hr_email && !isPlaceholder(emp.hr_email)) {
          const content =
            `<p style="margin:0 0 12px;font-size:15px;color:#111827;">Hello ${T._esc(emp.hr_hremployee1 || 'there')},</p>` +
            `<p style="margin:0 0 4px;color:#374151;">The goal <strong>${T._esc(title)}</strong> previously assigned to you has been re-assigned by ${T._esc(by)}. No further action is needed from you.</p>` +
            T.banner('If you believe this is a mistake, please contact HR.');
          await sendEmail(emp.hr_email, `Goal Re-assigned — ${title}`, T.layout({ title: 'Goal Re-assigned', preheader: 'A goal was reassigned', content }), { meta: { type: 'goal_reassigned' } });
        }
      } catch (e) { global.logger?.warn?.(`[goal] old-assignee notify failed: ${e.message}`); }
    }
  } catch (err) { global.logger?.error(`notifyGoalReassigned failed: ${err.message}`); }
}

module.exports = { notifyGoalAssigned, notifyGoalReassigned, _fmtDate: fmtDate, _emailedGoals: emailedGoals };
