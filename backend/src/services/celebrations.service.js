/**
 * Celebrations — Birthday, Marriage Anniversary and Work Anniversary automation.
 *
 * A daily job (jobs/index.js, 09:00 IST default, configurable) calls runDaily():
 * it scans ACTIVE employees, matches today's month/day against Date of Birth /
 * Marriage Date / Joining Date, and — for each ENABLED event — sends an email and
 * an in-app notification, then writes an audit row (which also guards against
 * duplicate emails on the same day).
 *
 * FUTURE-READY: adding Festival / New Year / Diwali / Christmas / Appreciation Day
 * wishes needs only (a) a new entry in EVENTS with its templates and (b) a detector
 * that returns the matching employees — the send loop, dedupe, audit, dashboard and
 * settings store all work unchanged. No redesign, no schema change.
 *
 * PRIVACY: the dashboard feed (celebrationsToday) exposes only photo, name,
 * employee id, department and designation — never the Date of Birth / Marriage Date.
 */
const d365 = require('./d365.service');
const { toValue } = require('./picklist');
let notif; try { notif = require('./notification.service'); } catch (_) { notif = null; }
let activity; try { activity = require('./activity.service'); } catch (_) { activity = null; }

const EMP = d365.constructor.entities.employee;
const SETTINGS_SET = 'hr_celebrationsettings';
const LOGS_SET = 'hr_celebrationlogs';
const COMPANY = 'CRMONCE';

// ── settings store (single-row config, cached — mirrors payroll-settings) ──────
const DEFAULTS = {
  hr_name: 'Default Celebration Settings',
  hr_birthdayenabled: 'true',
  hr_marriageenabled: 'true',
  hr_workannivenabled: 'true',
  hr_sendtime: '09:00',
  hr_birthdaysubject: '🎉 Happy Birthday!',
  hr_birthdaybody: 'Happy Birthday {firstName}!\n\nWishing you a wonderful year ahead. Have a fantastic day!\n\nFrom,\nCRMONCE HR Team',
  hr_birthdaynotif: '🎂 Happy Birthday, {firstName}! Wishing you a wonderful year ahead.',
  hr_marriagesubject: '💐 Happy Wedding Anniversary!',
  hr_marriagebody: 'Congratulations {firstName}!\n\nWishing you and your family many more wonderful years together.\n\nRegards,\nCRMONCE HR Team',
  hr_marriagenotif: '💐 Happy Wedding Anniversary, {firstName}!',
  hr_worksubject: '🎉 Happy Work Anniversary!',
  hr_workbody: 'Congratulations {firstName} on completing {years} year(s) with CRMONCE!\n\nThank you for being a valuable part of our team.\n\nRegards,\nCRMONCE HR Team',
  hr_worknotif: '🏆 Happy Work Anniversary, {firstName}! {years} year(s) with CRMONCE.',
};
const FIELDS = Object.keys(DEFAULTS);
const SELECT = ['hr_celebrationsettingid', ...FIELDS].join(',');
// Only these are writable via the settings PUT (whitelist).
const WRITABLE = FIELDS.filter(f => f !== 'hr_name');

const bool = (v) => v === true || /^(true|yes|1|on)$/i.test(String(v ?? ''));
let cache = null, cacheAt = 0; const TTL = 5 * 60 * 1000;
function invalidate() { cache = null; cacheAt = 0; }

function merge(row = {}) {
  const m = { ...DEFAULTS };
  for (const f of FIELDS) if (row[f] !== undefined && row[f] !== null && row[f] !== '') m[f] = row[f];
  if (row.hr_celebrationsettingid) m.hr_celebrationsettingid = row.hr_celebrationsettingid;
  return m;
}
async function getSettingsRow() {
  const now = Date.now();
  if (cache && now - cacheAt < TTL) return cache;
  let row = {};
  try {
    const { data } = await d365.getListOptional(SETTINGS_SET, { select: SELECT, optionalSelect: '', top: 1, orderby: 'createdon asc' });
    if (data && data[0]) row = data[0];
  } catch (_) { /* not provisioned yet → defaults */ }
  cache = merge(row); cacheAt = now;
  return cache;
}
/** Typed settings for API/consumers. */
async function getSettings() {
  const g = await getSettingsRow();
  return {
    birthdayEnabled: bool(g.hr_birthdayenabled),
    marriageEnabled: bool(g.hr_marriageenabled),
    workAnnivEnabled: bool(g.hr_workannivenabled),
    sendTime: /^\d{2}:\d{2}$/.test(g.hr_sendtime) ? g.hr_sendtime : '09:00',
    templates: {
      birthday: { subject: g.hr_birthdaysubject, body: g.hr_birthdaybody, notif: g.hr_birthdaynotif },
      marriage_anniversary: { subject: g.hr_marriagesubject, body: g.hr_marriagebody, notif: g.hr_marriagenotif },
      work_anniversary: { subject: g.hr_worksubject, body: g.hr_workbody, notif: g.hr_worknotif },
    },
  };
}
/** Update the (single) settings row — creates it if absent. HR only (route-guarded). */
async function updateSettings(patch = {}) {
  const clean = {};
  for (const k of WRITABLE) if (patch[k] !== undefined) clean[k] = String(patch[k]);
  const row = await getSettingsRow();
  let saved;
  if (row.hr_celebrationsettingid) saved = await d365.update(SETTINGS_SET, row.hr_celebrationsettingid, clean);
  else saved = await d365.create(SETTINGS_SET, { hr_name: 'Default Celebration Settings', ...clean });
  invalidate();
  return getSettings();
}

// ── event registry (future-ready) ─────────────────────────────────────────────
// Each event has a template key + the in-app socket event name. Adding a new event
// (festival/new-year/…) = add an entry here + a detector in findToday().
const EVENTS = {
  birthday: { label: 'Birthday', enabled: 'birthdayEnabled', notifEvent: 'celebration:birthday' },
  marriage_anniversary: { label: 'Marriage Anniversary', enabled: 'marriageEnabled', notifEvent: 'celebration:marriage' },
  work_anniversary: { label: 'Work Anniversary', enabled: 'workAnnivEnabled', notifEvent: 'celebration:work' },
};

// ── date helpers ──────────────────────────────────────────────────────────────
/** Today's date in IST as YYYY-MM-DD (the send day) regardless of server TZ. */
function todayIST() { return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }); }
/** Current IST HH:MM. */
function nowHHMM() { return new Date().toLocaleTimeString('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit' }); }
/** Extract MM-DD from a stored date (accepts "YYYY-MM-DD" or ISO). '' if unparseable. */
function mmdd(v) {
  const s = String(v ?? '').trim(); if (!s) return '';
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) return `${m[2]}-${m[3]}`;
  const d = new Date(s); if (isNaN(d)) return '';
  return `${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}
function yearOf(v) {
  const s = String(v ?? '').trim(); const m = /^(\d{4})-/.exec(s);
  if (m) return Number(m[1]);
  const d = new Date(s); return isNaN(d) ? null : d.getUTCFullYear();
}
// Feb-29 birthdays/anniversaries are observed on Feb-28 in non-leap years.
function matchesToday(dateVal, today) {
  const md = mmdd(dateVal); if (!md) return false;
  if (md === today.slice(5)) return true;
  if (md === '02-29' && today.slice(5) === '02-28') {
    const y = Number(today.slice(0, 4));
    const isLeap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
    return !isLeap;
  }
  return false;
}
const firstNameOf = (n) => String(n || '').trim().split(/\s+/)[0] || 'there';
function fill(tpl, ctx) { return String(tpl ?? '').replace(/\{(\w+)\}/g, (_, k) => (ctx[k] != null ? String(ctx[k]) : '')); }

// ── employee scan ─────────────────────────────────────────────────────────────
const EMP_SELECT = 'hr_hremployeeid,hr_hremployee1,hr_email,hr_department,hr_designation,hr_status,hr_joiningdate';
const EMP_OPT = 'hr_dob,hr_maritalstatus,hr_marriagedate,hr_photourl,hr_employeeid,hr_employeecode,hr_etimecode';

async function activeEmployees() {
  const { data } = await d365.getListOptional(EMP, {
    select: EMP_SELECT, optionalSelect: EMP_OPT,
    filter: `hr_status eq ${toValue('hr_employee_status', 'active')}`, top: 5000,
  });
  return data || [];
}
const shapePublic = (e, extra = {}) => ({
  id: e.hr_hremployeeid,
  name: e.hr_hremployee1 || 'Employee',
  employeeId: e.hr_employeeid || e.hr_employeecode || e.hr_etimecode || '',
  department: e.hr_department || '',
  designation: e.hr_designation || '',
  photo: e.hr_photourl || '',
  ...extra,   // years (public) — never the underlying date
});

/**
 * Everyone celebrating TODAY, grouped by event. `full` includes email + first name
 * (for sending); the default (privacy-safe) form is used by the dashboard.
 */
async function findToday({ full = false, today = todayIST() } = {}) {
  const emps = await activeEmployees();
  const y = Number(today.slice(0, 4));
  const out = { date: today, birthday: [], marriage_anniversary: [], work_anniversary: [] };
  for (const e of emps) {
    const withSend = (extra) => full ? { ...shapePublic(e, extra), email: e.hr_email || '', firstName: firstNameOf(e.hr_hremployee1) } : shapePublic(e, extra);
    // Birthday
    if (matchesToday(e.hr_dob, today)) out.birthday.push(withSend({}));
    // Marriage anniversary — only for married employees with a marriage date.
    if (/^married$/i.test(String(e.hr_maritalstatus || '')) && matchesToday(e.hr_marriagedate, today)) {
      const my = yearOf(e.hr_marriagedate); const years = my ? y - my : null;
      out.marriage_anniversary.push(withSend(years && years > 0 ? { years } : {}));
    }
    // Work anniversary — joining date's month/day, at least one completed year.
    if (matchesToday(e.hr_joiningdate, today)) {
      const jy = yearOf(e.hr_joiningdate); const years = jy ? y - jy : null;
      if (years && years > 0) out.work_anniversary.push(withSend({ years }));
    }
  }
  return out;
}

/** Privacy-safe celebrations for the dashboard (no dates, no emails). */
async function celebrationsToday() {
  const t = await findToday({ full: false });
  return { date: t.date, birthdays: t.birthday, marriageAnniversaries: t.marriage_anniversary, workAnniversaries: t.work_anniversary };
}

// ── audit log + duplicate-send guard ──────────────────────────────────────────
async function todaysLogs(today) {
  try {
    const { data } = await d365.getList(LOGS_SET, {
      select: 'hr_celebrationlogid,hr_employeeid,hr_type,hr_emailstatus,hr_notifstatus',
      filter: `hr_date eq '${today}'`, top: 5000,
    });
    const map = new Map();
    for (const r of data || []) map.set(`${r.hr_employeeid}|${r.hr_type}`, r);
    return map;
  } catch { return new Map(); }
}
async function writeLog({ id, employeeId, employeeName, type, date, emailStatus, notifStatus, detail }) {
  const payload = {
    hr_name: `${employeeName} · ${EVENTS[type]?.label || type} · ${date}`.slice(0, 250),
    hr_employeeid: String(employeeId || ''), hr_employeename: employeeName || '',
    hr_type: type, hr_date: date, hr_time: new Date().toISOString(),
    hr_emailstatus: emailStatus, hr_notifstatus: notifStatus, hr_detail: detail || '',
  };
  try {
    if (id) return await d365.update(LOGS_SET, id, payload);
    return await d365.create(LOGS_SET, payload);
  } catch (e) { global.logger?.warn?.(`[celebrations] log write skipped: ${e.message}`); return null; }
}

// ── send one wish (email + in-app) ────────────────────────────────────────────
async function sendOne(type, emp, settings) {
  const tpl = settings.templates[type] || {};
  const ctx = { name: emp.name, firstName: emp.firstName || firstNameOf(emp.name), years: emp.years ?? '', department: emp.department, designation: emp.designation, company: COMPANY };
  const subject = fill(tpl.subject, ctx) || EVENTS[type]?.label || 'Celebration';
  const bodyText = fill(tpl.body, ctx);
  const notifText = fill(tpl.notif, ctx) || subject;

  // Email (best-effort).
  let emailStatus = 'skipped';
  if (emp.email) {
    const html = `<div style="font-family:Segoe UI,Arial,sans-serif;font-size:15px;color:#111;line-height:1.6">${bodyText.replace(/\n/g, '<br/>')}</div>`;
    try {
      const r = await notif?.sendEmail?.(emp.email, subject, html, { meta: { type: `celebration_${type}` } });
      emailStatus = r?.success ? 'sent' : 'failed';
    } catch { emailStatus = 'failed'; }
  }
  // In-app notification (socket) + activity feed.
  let notifStatus = 'sent';
  try {
    notif?.notifyUser?.(emp.id, EVENTS[type]?.notifEvent || 'celebration', { type, message: notifText });
    activity?.record?.({ category: 'Celebration', type: `celebration_${type}`, title: EVENTS[type]?.label || 'Celebration', name: emp.name, meta: notifText });
  } catch { notifStatus = 'failed'; }

  return { emailStatus, notifStatus, detail: emp.years ? `${emp.years} year(s)` : (emp.email || '') };
}

/**
 * The daily run. Sends wishes for every ENABLED event to everyone celebrating
 * today, skipping anyone already emailed today (duplicate guard). Returns a summary.
 *   opts.scheduled — true when called by the cron tick (respects the send time).
 *   opts.force     — bypass the send-time gate (manual "Run Now").
 */
async function runDaily(opts = {}) {
  const { scheduled = false, force = false } = opts;
  const settings = await getSettings();
  const today = todayIST();
  // Send-time gate (only for scheduled ticks; manual runs bypass it).
  if (scheduled && !force && nowHHMM() < settings.sendTime) {
    return { skipped: 'before_send_time', sendTime: settings.sendTime, date: today };
  }
  const matches = await findToday({ full: true, today });
  const logs = await todaysLogs(today);
  const summary = { date: today, sent: {}, skipped: {}, disabled: {} };

  for (const [type, meta] of Object.entries(EVENTS)) {
    const list = matches[type] || [];
    summary.sent[type] = 0; summary.skipped[type] = 0;
    if (!settings[meta.enabled]) { summary.disabled[type] = list.length; continue; }
    for (const emp of list) {
      const key = `${emp.id}|${type}`;
      const prior = logs.get(key);
      if (prior && prior.hr_emailstatus === 'sent') { summary.skipped[type]++; continue; }   // already emailed today
      const res = await sendOne(type, emp, settings);
      await writeLog({ id: prior?.hr_celebrationlogid, employeeId: emp.id, employeeName: emp.name, type, date: today, ...res });
      summary.sent[type]++;
    }
  }
  const total = Object.values(summary.sent).reduce((a, b) => a + b, 0);
  if (total) global.logger?.info?.(`[celebrations] ${today}: sent ${JSON.stringify(summary.sent)}`);
  return { ...summary, total };
}

/** Audit log rows (HR). Newest first. */
async function listLogs({ type, date, employeeId, top = 500 } = {}) {
  const filters = [];
  if (type) filters.push(`hr_type eq '${String(type).replace(/'/g, "''")}'`);
  if (date) filters.push(`hr_date eq '${String(date).replace(/'/g, "''")}'`);
  if (employeeId) filters.push(`hr_employeeid eq '${String(employeeId).replace(/'/g, "''")}'`);
  try {
    const { data } = await d365.getList(LOGS_SET, {
      select: 'hr_celebrationlogid,hr_employeeid,hr_employeename,hr_type,hr_date,hr_time,hr_emailstatus,hr_notifstatus,hr_detail,createdon',
      filter: filters.join(' and ') || undefined, orderby: 'createdon desc', top,
    });
    return (data || []).map(r => ({
      id: r.hr_celebrationlogid, employeeId: r.hr_employeeid, employeeName: r.hr_employeename,
      type: r.hr_type, typeLabel: EVENTS[r.hr_type]?.label || r.hr_type,
      date: r.hr_date, time: r.hr_time, emailStatus: r.hr_emailstatus, notificationStatus: r.hr_notifstatus,
      detail: r.hr_detail || '', createdOn: r.createdon,
    }));
  } catch { return []; }
}

module.exports = {
  getSettings, updateSettings, celebrationsToday, findToday, runDaily, listLogs,
  EVENTS, SETTINGS_SET, LOGS_SET, invalidate,
  // exposed for tests
  mmdd, yearOf, matchesToday, fill, firstNameOf, todayIST,
};
