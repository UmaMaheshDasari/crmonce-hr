/**
 * Automated reminders — Profile/Document completion, Passport deadline, and Goal due dates.
 *
 * Confirmed business rules:
 *   A. Profile/documents — email each active employee their OWN outstanding items
 *      (profile.computeCompletion is the single source of truth; a required doc counts
 *      only when VERIFIED). Repeat every N days (default 3) until complete; stop the
 *      moment it's complete; never ask for an already-complete item.
 *   B. Passport — "complete" = the hr_passport number is filled. Remind every N days
 *      leading up to the 2026-11-01 deadline AND after it (then the message is overdue),
 *      until filled. No historical backfill — at most ONE send per day.
 *   C. Goals — remind at due−7 / due−3 / due−1, on the due date, then every N days after
 *      the due date, until the goal is completed/exceeded/missed (or deleted). Uses the
 *      real goal name, due date and status.
 *
 * Email routing (confirmed): From HR@ (hrSender), To the employee ONLY, CC info@ (§E).
 * Every send goes through the notification ledger (sendOnce), so a job that runs twice —
 * or multiple PM2 workers — never sends a duplicate, and sends are only recorded on
 * Graph success. Inactive employees and completed items are excluded before sending.
 * Pure decision helpers (goalPhase / isPassportComplete / dueByInterval) are unit-tested.
 */
const d365 = require('./d365.service');
const { toValue } = require('./picklist');
const ledger = require('./notification-ledger.service');
const profile = require('./profile.service');
const { hrSender, infoSender, mergeCc } = require('./email/sender');
const T = require('./email/templates');
let ecfg; try { ecfg = require('./email/config'); } catch (_) { ecfg = { brand: { appUrl: '' } }; }
let time; try { time = require('./time.util'); } catch (_) { time = null; }

const EMP = d365.constructor.entities.employee;
const DOC = d365.constructor.entities.document;      // hr_hrdocuments
const GOAL = d365.constructor.entities.goal;         // hr_hrgoals

// ── config ────────────────────────────────────────────────────────────────────
// The reminder cadence (how many days between recurring reminders) is a COMPANY
// SETTING — company.service `hr_reminderintervaldays`, editable in Company Settings —
// resolved at run time. It is NEVER hardcoded in the reminder logic.
const PASSPORT_DEADLINE = String(process.env.PASSPORT_DEADLINE || '2026-11-01').slice(0, 10);
const GOAL_CLOSED = new Set(['completed', 'exceeded', 'missed']);   // stop reminding (+ deleted/absent)

// Goal reminder milestones (Company-configurable; keyed off each goal's DUE DATE).
// Default: every milestone ON, overdue cadence 3 days. Exact-date semantics — a
// milestone fires on the day `today` equals its target date (so a newly-created goal
// never gets blasted with milestones whose dates are already in the past).
const DEFAULT_GOAL_SETTINGS = Object.freeze({ m3: true, m2: true, m1: true, d15: true, d7: true, d3: true, d1: true, due: true, overdue: true, overdueInterval: 3 });

/** The configured reminder interval (days) read from Company Settings. */
async function resolveIntervalDays() {
  try {
    const c = await require('./company.service').getCompany();
    const n = parseInt(c?.hr_reminderintervaldays, 10);
    if (Number.isFinite(n) && n >= 1) return n;
  } catch (_) { /* fall through to the seeded company-settings default */ }
  const def = parseInt(require('./company.service').COMPANY_DEFAULTS?.hr_reminderintervaldays, 10);
  return Number.isFinite(def) && def >= 1 ? def : 3;   // last-resort guard (never the primary path)
}

const TYPE = { profile: 'PROFILE_REMINDER', passport: 'PASSPORT_REMINDER', goal: 'GOAL_REMINDER' };
const esc = (v) => String(v ?? '').replace(/'/g, "''");
const ds10 = (d) => String(d ?? '').slice(0, 10);
const filled = (v) => v !== undefined && v !== null && String(v).trim() !== '';
const appUrl = (ecfg && ecfg.brand && ecfg.brand.appUrl) || '';
function today() { try { return time?.istDateStr ? time.istDateStr() : new Date().toISOString().slice(0, 10); } catch { return new Date().toISOString().slice(0, 10); } }

/** Whole-day difference (to − from) for 'YYYY-MM-DD' strings; null if unparseable. */
function daysBetween(fromDs, toDs) {
  const a = Date.parse(`${ds10(fromDs)}T00:00:00Z`); const b = Date.parse(`${ds10(toDs)}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.round((b - a) / 86400000);
}

const VALID_DATE = /^\d{4}-\d{2}-\d{2}$/;
/** 'YYYY-MM-DD' shifted by n days (UTC civil math); null if unparseable. */
function addDays(ds, n) {
  const d = new Date(`${ds10(ds)}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return null;
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
const lastDayOfMonthUTC = (y, m0) => new Date(Date.UTC(y, m0 + 1, 0)).getUTCDate();
/**
 * The calendar date `n` months before `dueDs`, clamping the day to the target month's
 * last day — so month-end and leap years are handled correctly:
 *   2026-05-31 −3mo → 2026-02-28 · 2028-03-31 −1mo → 2028-02-29 · 2026-01-31 −1mo → 2025-12-31
 */
function monthsBefore(dueDs, n) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ds10(dueDs));
  if (!m) return null;
  let y = +m[1], mo = +m[2] - 1, day = +m[3];
  mo -= n;
  y += Math.floor(mo / 12);
  mo = ((mo % 12) + 12) % 12;
  const d = Math.min(day, lastDayOfMonthUTC(y, mo));
  return `${y}-${String(mo + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

// ── data access (best-effort reads; never throw into the batch) ───────────────
const EMP_OPT = [...profile.COMPLETION_FIELDS, 'hr_passport'].join(',');
async function activeEmployees() {
  try {
    const activeVal = toValue('hr_employee_status', 'active');
    const { data } = await d365.getListOptional(EMP, {
      select: 'hr_hremployeeid,hr_hremployee1,hr_email,hr_status',
      optionalSelect: EMP_OPT, top: 5000,
    });
    return (data || []).filter(e => e.hr_status == null || e.hr_status === activeVal);
  } catch (e) { global.logger?.error?.(`[reminders] employee fetch failed: ${e.message}`); return []; }
}

async function employeeDocuments(employeeGuid) {
  try {
    const { data } = await d365.getListOptional(DOC, {
      select: 'hr_name', optionalSelect: 'hr_documenttype,hr_status',
      filter: `_hr_hremployee_value eq '${esc(employeeGuid)}'`, top: 200,
    });
    return (data || []).map(d => ({ name: d.hr_name, type: d.hr_documenttype || d.hr_name, status: d.hr_status || 'pending' }));
  } catch { return []; }
}

async function requiredDocsList() {
  try {
    const company = await require('./company.service').getCompany();
    const list = String(company?.hr_requireddocs || '').split(',').map(s => s.trim()).filter(Boolean);
    return list.length ? list : null;   // null → computeCompletion uses its default REQUIRED_DOCS
  } catch { return null; }
}

async function openGoals() {
  try {
    const { data } = await d365.getListOptional(GOAL, {
      select: 'hr_hrgoalid,hr_hrgoal1,hr_status,hr_duedate,hr_employeeid,hr_employeename',
      optionalSelect: 'hr_progress', top: 5000,
    });
    return data || [];
  } catch (e) { global.logger?.error?.(`[reminders] goal fetch failed: ${e.message}`); return []; }
}

// ── pure decision helpers (unit-tested) ───────────────────────────────────────
const isPassportComplete = (emp) => filled(emp?.hr_passport);

/** Reminder cadence gate: true when we haven't successfully sent `type` to this
 *  employee within the last INTERVAL_DAYS (or never). */
async function dueByInterval(employeeId, type, todayDs, intervalDays) {
  const last = await ledger.lastSentOn(employeeId, type);
  if (!last) return true;
  const gap = daysBetween(last, todayDs);
  return gap == null ? true : gap >= intervalDays;
}

/** The enabled fixed milestones for a due date, each with its target 'YYYY-MM-DD'. */
function goalFixedMilestones(dueDs, s) {
  const due = ds10(dueDs);
  return [
    { key: 'm3', on: s.m3, date: monthsBefore(due, 3), label: '3 months before due' },
    { key: 'm2', on: s.m2, date: monthsBefore(due, 2), label: '2 months before due' },
    { key: 'm1', on: s.m1, date: monthsBefore(due, 1), label: '1 month before due' },
    { key: 'd15', on: s.d15, date: addDays(due, -15), label: '15 days before due' },
    { key: 'd7', on: s.d7, date: addDays(due, -7), label: '7 days before due' },
    { key: 'd3', on: s.d3, date: addDays(due, -3), label: '3 days before due' },
    { key: 'd1', on: s.d1, date: addDays(due, -1), label: '1 day before due' },
    { key: 'due', on: s.due, date: due, label: 'due today' },
  ];
}

/**
 * Goal reminder decision for `today` from the goal's status + due date + settings.
 * EXACT-DATE: a fixed milestone fires only when today === its target date (computed from
 * the DUE date; calendar-months are month-end/leap-safe). Overdue fires when today is past
 * the due date and the days-overdue is a multiple of the configured overdue interval.
 * PURE — no ledger/network. @returns {{ reason, overdue?, daysLeft?, milestone?:{key,label} }}
 *   reason: 'closed' | 'no_due' | 'not_due' | 'fixed' | 'overdue'  ('fixed'/'overdue' → send)
 */
function goalMilestone(status, dueDs, todayDs, settings) {
  const s = settings || DEFAULT_GOAL_SETTINGS;
  if (GOAL_CLOSED.has(String(status || '').toLowerCase())) return { reason: 'closed' };
  const due = ds10(dueDs);
  if (!VALID_DATE.test(due)) return { reason: 'no_due' };
  const off = daysBetween(todayDs, due);   // due − today
  if (off == null) return { reason: 'no_due' };
  if (off < 0) {   // overdue
    if (!s.overdue) return { reason: 'not_due' };
    const over = -off;
    const n = Number.isFinite(s.overdueInterval) && s.overdueInterval >= 1 ? s.overdueInterval : 3;
    if (over % n !== 0) return { reason: 'not_due' };
    return { reason: 'overdue', overdue: true, daysLeft: off, milestone: { key: 'od', label: `overdue (${over} day${over === 1 ? '' : 's'})` } };
  }
  // today <= due: fire a fixed milestone whose target date is exactly today
  const t = ds10(todayDs);
  const hit = goalFixedMilestones(due, s).find(m => m.on && m.date && m.date === t);
  if (hit) return { reason: 'fixed', overdue: false, daysLeft: off, milestone: { key: hit.key, label: hit.label } };
  return { reason: 'not_due' };
}

/** Goal reminder settings resolved from Company Settings (defaults seeded in COMPANY_DEFAULTS). */
async function resolveGoalSettings() {
  let c = {};
  try { c = await require('./company.service').getCompany(); } catch (_) { /* defaults below */ }
  const on = (k, def) => { const v = c[k]; return (v === undefined || v === null || v === '') ? def : /^(true|1|yes|on)$/i.test(String(v)); };
  const iRaw = parseInt(c.hr_goaloverdueintervaldays, 10);
  return {
    m3: on('hr_goalrem_m3', true), m2: on('hr_goalrem_m2', true), m1: on('hr_goalrem_m1', true),
    d15: on('hr_goalrem_d15', true), d7: on('hr_goalrem_d7', true), d3: on('hr_goalrem_d3', true), d1: on('hr_goalrem_d1', true),
    due: on('hr_goalrem_due', true), overdue: on('hr_goalrem_overdue', true),
    overdueInterval: Number.isFinite(iRaw) && iRaw >= 1 ? iRaw : 3,
  };
}

// ── send (routing + idempotency) ──────────────────────────────────────────────
async function send({ employeeId, email, type, dateKey, subject, html }) {
  const from = hrSender();
  const cc = mergeCc([infoSender()], { excludeTo: [email], from });   // §E: CC info@ (never the employee, never the sender)
  return ledger.sendOnce({ employeeId, date: dateKey, type, to: email, cc, subject, html, from, entity: 'reminder' });
}

// ── A. Profile / document completion ──────────────────────────────────────────
async function runProfileReminders({ todayDs, employees, requiredDocs, intervalDays } = {}) {
  const t = ds10(todayDs || today());
  const emps = employees || await activeEmployees();
  const reqDocs = requiredDocs !== undefined ? requiredDocs : await requiredDocsList();
  const interval = intervalDays != null ? intervalDays : await resolveIntervalDays();
  const summary = { date: t, intervalDays: interval, scanned: 0, complete: 0, sent: 0, held: 0, skippedNoEmail: 0, errors: 0 };
  for (const emp of emps) {
    summary.scanned++;
    try {
      const email = emp.hr_email;
      if (!filled(email)) { summary.skippedNoEmail++; continue; }
      const documents = await employeeDocuments(emp.hr_hremployeeid);
      const completion = profile.computeCompletion(emp, { documents, requiredDocs: reqDocs || undefined });
      if (!completion.missing || completion.missing.length === 0) { summary.complete++; continue; }
      if (!(await dueByInterval(emp.hr_hremployeeid, TYPE.profile, t, interval))) { summary.held++; continue; }
      const { subject, html } = T.profileCompletionReminder({
        employeeName: emp.hr_hremployee1, missing: completion.missing, portalUrl: appUrl ? `${appUrl}/profile` : '',
      });
      const r = await send({ employeeId: emp.hr_hremployeeid, email, type: TYPE.profile, dateKey: t, subject, html });
      if (r?.sent) summary.sent++; else if (r?.skipped) summary.held++;
    } catch (e) { summary.errors++; global.logger?.warn?.(`[reminders] profile ${emp.hr_hremployeeid}: ${e.message}`); }
  }
  return summary;
}

// ── B. Passport deadline ──────────────────────────────────────────────────────
async function runPassportReminders({ todayDs, employees, intervalDays } = {}) {
  const t = ds10(todayDs || today());
  const emps = employees || await activeEmployees();
  const interval = intervalDays != null ? intervalDays : await resolveIntervalDays();
  const overdue = t >= PASSPORT_DEADLINE;
  const summary = { date: t, deadline: PASSPORT_DEADLINE, intervalDays: interval, overdue, scanned: 0, complete: 0, sent: 0, held: 0, skippedNoEmail: 0, errors: 0 };
  for (const emp of emps) {
    summary.scanned++;
    try {
      const email = emp.hr_email;
      if (!filled(email)) { summary.skippedNoEmail++; continue; }
      if (isPassportComplete(emp)) { summary.complete++; continue; }
      if (!(await dueByInterval(emp.hr_hremployeeid, TYPE.passport, t, interval))) { summary.held++; continue; }
      const { subject, html } = T.passportReminder({
        employeeName: emp.hr_hremployee1, deadline: PASSPORT_DEADLINE, overdue, portalUrl: appUrl ? `${appUrl}/profile` : '',
      });
      const r = await send({ employeeId: emp.hr_hremployeeid, email, type: TYPE.passport, dateKey: t, subject, html });
      if (r?.sent) summary.sent++; else if (r?.skipped) summary.held++;
    } catch (e) { summary.errors++; global.logger?.warn?.(`[reminders] passport ${emp.hr_hremployeeid}: ${e.message}`); }
  }
  return summary;
}

// ── C. Goal due dates ─────────────────────────────────────────────────────────
async function runGoalReminders({ todayDs, employees, goals, goalSettings } = {}) {
  const t = ds10(todayDs || today());
  const emps = employees || await activeEmployees();
  const settings = goalSettings || await resolveGoalSettings();
  const empMap = new Map((emps || []).map(e => [e.hr_hremployeeid, e]));
  const list = goals || await openGoals();
  const summary = { date: t, overdueInterval: settings.overdueInterval, scanned: 0, sent: 0, skippedClosed: 0, skippedNotDue: 0, skippedInactive: 0, skippedNoDate: 0, errors: 0 };
  for (const g of list) {
    summary.scanned++;
    try {
      const emp = empMap.get(g.hr_employeeid);
      if (!emp || !filled(emp.hr_email)) { summary.skippedInactive++; continue; }   // inactive/unknown employee → never remind
      const dec = goalMilestone(g.hr_status, g.hr_duedate, t, settings);
      if (dec.reason === 'closed') { summary.skippedClosed++; continue; }
      if (dec.reason === 'no_due') { summary.skippedNoDate++; continue; }
      if (dec.reason === 'not_due') { summary.skippedNotDue++; continue; }
      const { subject, html } = T.goalReminder({
        employeeName: emp.hr_hremployee1, goalName: g.hr_hrgoal1 || 'Goal', dueDate: ds10(g.hr_duedate),
        status: g.hr_status, statusLabel: g.hr_status, progress: g.hr_progress ?? 0,
        overdue: !!dec.overdue, daysLeft: dec.daysLeft, milestoneLabel: dec.milestone && dec.milestone.label, portalUrl: appUrl ? `${appUrl}/goals` : '',
      });
      // Per-goal-per-DAY idempotency: a milestone's target is a single calendar day, so the
      // goal id + today's date is a unique key (goal id fits hr_Type[60]); same-day re-runs dedupe.
      const r = await send({ employeeId: g.hr_employeeid, email: emp.hr_email, type: `${TYPE.goal}:${g.hr_hrgoalid}`, dateKey: t, subject, html });
      if (r?.sent) summary.sent++;
    } catch (e) { summary.errors++; global.logger?.warn?.(`[reminders] goal ${g.hr_hrgoalid}: ${e.message}`); }
  }
  return summary;
}

/** Scheduler entry point — runs all three (each gated by its own env flag in jobs/index). */
async function runAll(opts = {}) {
  const [profileR, passportR, goalR] = await Promise.all([
    runProfileReminders(opts).catch(e => ({ error: e.message })),
    runPassportReminders(opts).catch(e => ({ error: e.message })),
    runGoalReminders(opts).catch(e => ({ error: e.message })),
  ]);
  return { profile: profileR, passport: passportR, goal: goalR };
}

module.exports = {
  runProfileReminders, runPassportReminders, runGoalReminders, runAll,
  // pure helpers (tested)
  goalMilestone, goalFixedMilestones, monthsBefore, addDays, resolveGoalSettings,
  isPassportComplete, dueByInterval, daysBetween, resolveIntervalDays,
  PASSPORT_DEADLINE, GOAL_CLOSED, DEFAULT_GOAL_SETTINGS, TYPE,
};
