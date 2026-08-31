const express = require('express');
const router = express.Router();
const d365 = require('../../services/d365.service');
const etimeService = require('../../services/etime.service');
const { requireRole, requirePermission, requireAnyPermission } = require('../../middleware/auth.middleware');
const { toValue, toLabel, labelsForList, labelsForEntity } = require('../../services/picklist');
const ExcelJS = require('exceljs');
const { computeFromPunches, computeSession, punchesFromRecord, statusForStorage } = require('../../services/attendance.util');
const attnCfg = require('../../services/attendance.config');
const leaveRoutes = require('./leave.routes');
const compOffRoutes = require('./comp-off.routes');
const lateLoginRoutes = require('./late-login.routes');
const lateLoginService = require('../../services/late-login.service');
const activity = require('../../services/activity.service');
const exceptionSvc = require('../../services/attendance-exception.service');
const ecfg = require('../../services/email/config');
const time = require('../../services/time.util');
const webCheckin = require('../../services/web-checkin.service');
const monthlyBalance = require('../../services/monthly-balance.service');
const { ensureAttendanceAuditTable, ENTITY_SET: ATT_AUDIT_SET } = require('../../services/provision-attendance-audit');

// Web Check-In must be explicitly enabled by an Admin for THIS employee (default
// DISABLED). Enforced server-side on every web punch so an unauthorized API call is
// rejected regardless of the UI. The eTime/device sync path is separate and unaffected.
async function requireWebCheckinEnabled(req, res, next) {
  try {
    if (await webCheckin.isEnabled(req.user.id)) return next();
    return res.status(403).json({ error: 'Web Check-In access is not enabled for this employee.' });
  } catch (err) { next(err); }
}

router.use('/leave', leaveRoutes);
router.use('/comp-off', compOffRoutes);
router.use('/historical-requests', require('./historical-attendance.routes'));
router.use('/late-login', lateLoginRoutes);

const ENTITY = d365.constructor.entities.attendance;

// GET /api/attendance
router.get('/', requireAnyPermission('attendance.view'), async (req, res, next) => {
  try {
    const { employeeId, from, to, status, source, department, late, missingPunch, month, year, page = 1, limit = 30 } = req.query;
    const filters = [];

    // Derive from/to from month/year when an explicit range wasn't passed (HR filters).
    let f = from, t = to;
    if (!f && !t && (month || year)) {
      const y = Number(year) || new Date().getFullYear();
      if (month) { const m = Number(month); const last = new Date(y, m, 0).getDate(); f = `${y}-${String(m).padStart(2, '0')}-01`; t = `${y}-${String(m).padStart(2, '0')}-${String(last).padStart(2, '0')}`; }
      else { f = `${y}-01-01`; t = `${y}-12-31`; }
    }

    // Employees can only see their own attendance
    const targetId = req.user.role === 'employee' ? req.user.id : employeeId;
    if (targetId) filters.push(`_hr_hremployee_value eq '${targetId}'`);
    if (f) filters.push(`hr_date ge ${f}`);
    if (t) filters.push(`hr_date le ${t}`);
    if (source) filters.push(`hr_source eq ${toValue('hr_attendance_source', source)}`);

    // Present/Half Day/Incomplete/In Progress are DYNAMIC (computed from punches + shift),
    // so filter/display them by the computed status — NOT the stored hr_status. 'in_progress'
    // (today's live open session) is included so it can be filtered and never falls into the
    // Incomplete filter — matching how the /stats summary now counts them separately.
    const COMPUTED = ['present', 'half_day', 'incomplete', 'in_progress'];
    const useComputed = COMPUTED.includes(status);
    if (status && !useComputed) filters.push(`hr_status eq ${toValue('hr_attendance_status', status)}`);

    const lateFlag = /^(1|true|yes)$/i.test(String(late || ''));
    const missFlag = /^(1|true|yes)$/i.test(String(missingPunch || ''));

    // Department filter (HR): resolve the department's employees, filter in-memory.
    let deptSet = null;
    if (department && req.user.role !== 'employee') {
      try {
        const { data } = await d365.getList(EMP_ENTITY, { select: 'hr_hremployeeid', filter: `hr_department eq '${String(department).replace(/'/g, "''")}'`, top: 5000 });
        deptSet = new Set((data || []).map(e => e.hr_hremployeeid));
      } catch { deptSet = new Set(); }
    }

    const SELECT = 'hr_hrattendanceid,hr_date,hr_intime,hr_outtime,hr_workedhours,hr_overtime,hr_status,hr_source,_hr_hremployee_value,hr_allpunches,hr_punchcount,hr_breakduration,hr_effectivehours';
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const lim = Math.max(1, parseInt(limit, 10) || 30);
    const baseFilter = filters.join(' and ') || undefined;

    // Any computed/in-memory filter → fetch all matching rows; else page via $top.
    const needsAll = useComputed || lateFlag || missFlag || !!deptSet;
    let recs, storedCount;
    if (needsAll) {
      const { data } = await d365.getAll(ENTITY, { select: SELECT, filter: baseFilter, orderby: 'hr_date desc' }, 10000);
      recs = data || [];
    } else {
      const { data, count } = await d365.getList(ENTITY, { select: SELECT, filter: baseFilter, orderby: 'hr_date desc', top: pageNum * lim });
      recs = data || [];
      storedCount = count;
    }

    // Recompute the session per record (status + late + missing-punch flags).
    const shiftFor = await buildShiftResolver();
    for (const r of recs) {
      const s = shiftFor(r._hr_hremployee_value, r.hr_date);
      const c = computeSession(punchesFromRecord(r), s, { graceMinutes: s.grace, date: String(r.hr_date).slice(0, 10) });
      r.hr_status = c.status;
      r._late = (c.lateArrivalMin || 0) > 0;
      r._incomplete = c.state === 'in' || (c.count % 2 !== 0);
    }

    let filtered = recs;
    if (deptSet) filtered = filtered.filter(r => deptSet.has(r._hr_hremployee_value));
    if (useComputed) filtered = filtered.filter(r => r.hr_status === status);
    if (lateFlag) filtered = filtered.filter(r => r._late);
    if (missFlag) filtered = filtered.filter(r => r._incomplete);

    let out, count;
    if (needsAll) { count = filtered.length; out = filtered.slice((pageNum - 1) * lim, pageNum * lim); }
    else { count = storedCount; out = filtered.slice((pageNum - 1) * lim); }

    // Late Login overlay (spec §7): an APPROVED late login never marks the day absent
    // and is surfaced as "Late Present"/"Present (Late Login Approved)" per settings.
    // Additive + best-effort — it annotates rows, never changes the computed status.
    try {
      const dates = out.map(r => String(r.hr_date || '').slice(0, 10)).filter(Boolean).sort();
      if (dates.length) {
        const set = await lateLoginService.approvedSet({ from: dates[0], to: dates[dates.length - 1], employeeId: targetId || undefined });
        if (set.size) {
          const mode = (await lateLoginService.policy()).attendanceMode || 'late_present';
          const label = mode === 'present' ? 'Present (Late Login Approved)' : 'Late Present';
          out.forEach(r => {
            if (set.has(`${r._hr_hremployee_value}|${String(r.hr_date || '').slice(0, 10)}`)) {
              r.hr_lateloginapproved = true;
              r.hr_lateloginlabel = label;
            }
          });
        }
      }
    } catch (_) { /* overlay is best-effort; attendance must never depend on it */ }

    out.forEach(r => { delete r._late; delete r._incomplete; });
    res.json(labelsForList('hr_hrattendances', { data: out, count }));
  } catch (err) { next(err); }
});

// GET /api/attendance/summary
router.get('/summary', requireAnyPermission('attendance.view'), async (req, res, next) => {
  try {
    const { employeeId, month, year } = req.query;
    const targetId = req.user.role === 'employee' ? req.user.id : employeeId;
    const fetchXml = `
      <fetch aggregate="true">
        <entity name="hr_hrattendance">
          <attribute name="hr_status" groupby="true" alias="status"/>
          <attribute name="hr_hrattendanceid" aggregate="count" alias="count"/>
          <attribute name="hr_workedhours" aggregate="sum" alias="total_hours"/>
          <filter>
            <condition attribute="_hr_hremployee_value" operator="eq" value="${targetId}"/>
            <condition attribute="hr_date" operator="this-month"/>
          </filter>
        </entity>
      </fetch>`;
    const data = await d365.executeFetchXml('hr_hrattendances', fetchXml);
    res.json(labelsForList('hr_hrattendances', data));
  } catch (err) { next(err); }
});

// POST /api/attendance/sync — pull logs from ZK device and sync to D365
router.post('/sync', requireAnyPermission('attendance.edit'), async (req, res, next) => {
  try {
    const { from, to } = req.body;
    const fromDate = from || new Date(Date.now() - 86400000).toISOString().split('T')[0];
    const toDate = to || new Date().toISOString().split('T')[0];
    const result = await etimeService.syncAttendance(fromDate, toDate);
    activity.record({
      category: 'Biometric', type: 'sync_completed', title: 'eTime Synchronization',
      name: '', meta: `${result.synced} punches imported successfully${result.errors?.length ? ` (${result.errors.length} error(s))` : ''}`,
    });
    res.json({ message: 'Sync complete', ...result });
  } catch (err) {
    activity.record({ category: 'Biometric', type: 'sync_failed', title: 'eTime Synchronization Failed', name: '', meta: err.message });
    next(err);
  }
});

// POST /api/attendance/device/request-logs — request device to push new logs
router.post('/device/request-logs', requireAnyPermission('attendance.edit'), async (req, res, next) => {
  try {
    const zkPush = require('../../services/zk-push.service');
    if (zkPush.activeSocket && !zkPush.activeSocket.destroyed) {
      // Send XML command to request new attendance data
      const cmd = '<?xml version="1.0"?><Request><Command>GETATTLOG</Command></Request>\0';
      zkPush.activeSocket.write(cmd);
      res.json({ message: 'Requested device to send attendance logs', connected: true });
    } else {
      res.json({ message: 'Device not currently connected. It will push on next connection.', connected: false });
    }
  } catch (err) { next(err); }
});

// GET /api/attendance/device/info — get ZK device info
router.get('/device/info', requireAnyPermission('attendance.export'), async (req, res, next) => {
  try {
    const info = await etimeService.getDeviceInfo();
    res.json({ device: `ZKTeco Z900 @ ${etimeService.ip}`, ...info });
  } catch (err) { next(err); }
});

// GET /api/attendance/device/users — list users registered on ZK device
router.get('/device/users', requireAnyPermission('attendance.export'), async (req, res, next) => {
  try {
    const users = await etimeService.fetchDeviceUsers();
    res.json({ count: users.length, data: users });
  } catch (err) { next(err); }
});

// GET /api/attendance/device/logs — raw attendance logs from ZK device
router.get('/device/logs', requireAnyPermission('attendance.export'), async (req, res, next) => {
  try {
    const logs = await etimeService.fetchAttendanceLogs();
    res.json({ count: logs.length, data: logs });
  } catch (err) { next(err); }
});

// GET /api/attendance/etime-sync/status — Office Sync Agent status for the HR "Sync eTime"
// panel: online/offline, last successful/attempted sync, last punch, and running totals.
// This is the modern path (agent → HTTPS → backend). No device connection is attempted.
router.get('/etime-sync/status', requireAnyPermission('attendance.export'), (req, res) => {
  res.json(require('../../services/etime-sync-state').snapshot());
});

// ── Web punch session (multi-punch: IN/OUT/IN/OUT…, never locks) ──────────────
const PUNCH_SELECT = 'hr_hrattendanceid,hr_date,hr_intime,hr_outtime,hr_workedhours,hr_overtime,hr_status,hr_source,_hr_hremployee_value,hr_allpunches,hr_punchcount,hr_breakduration,hr_effectivehours';
// Punch time + "today" are computed in the app timezone (Asia/Kolkata), NOT the
// server timezone — otherwise a 9:14 AM IST punch is stored as "03:44" (UTC).
const nowHHMM = () => time.istHHMM();

async function findTodayRecord(employeeId) {
  const today = time.istDateStr();
  const existing = await d365.getList(ENTITY, {
    select: PUNCH_SELECT,
    filter: `_hr_hremployee_value eq '${employeeId}' and hr_date eq ${today}`,
    top: 1,
  });
  return { today, record: (existing.data && existing.data[0]) || null };
}

// Map computed session → the D365 fields (only existing columns; late/early/
// overtime/compensation are computed on read, not stored — no schema change).
function punchPayload(c) {
  return {
    hr_intime: c.firstPunch || '',
    hr_outtime: c.state === 'out' ? c.lastPunch : '',   // "final" out only while currently OUT
    hr_workedhours: c.totalSpanHours,
    hr_overtime: c.overtimeHours,
    hr_breakduration: c.breakHours,
    hr_effectivehours: c.effectiveHours,
    hr_punchcount: c.count,
    // Store times as a string array (device/zk-push compatible). Direction is
    // re-derived by pairing on read — correct for web's strict IN/OUT order.
    hr_allpunches: JSON.stringify(c.punches.map(p => p.t)),
    // Open session → stored as 'incomplete' (the choice column has no 'in_progress');
    // recomputes to 'in_progress' on read. A closing OUT stores present/half normally.
    hr_status: toValue('hr_attendance_status', statusForStorage(c.status)),
  };
}

// Per-employee shift: the employee's assigned Shift Name + Start Time drive all
// Late / Early Exit / Overtime math. resolveShift() is the legacy fallback only.
const EMP_ENTITY = d365.constructor.entities.employee;
const resolveShift = () => attnCfg.resolveShift();
const SHIFT_COLS = 'hr_shiftname,hr_shiftstarttime,hr_shiftendtime';
const shiftOf = (emp) => attnCfg.resolveEmployeeShift(emp?.hr_shiftname, emp?.hr_shiftstarttime, emp?.hr_shiftendtime);

// Absent-before-grace (spec §7/§8): each employee is NEVER Absent today until their
// OWN shift-start + configured grace has elapsed. gracePassedToday + absentDatesFor
// live in attendance-summary.util (shared by list / stats / dashboard). Here we just
// resolve "now" (IST) and the grace window.
function istNowMinutes() { const [h, m] = String(time.istHHMM() || '00:00').split(':').map(Number); return (h || 0) * 60 + (m || 0); }
// The grace window (minutes) for the absent cutoff — the SAME configured Late Login
// grace, so "Present until shift+grace" is consistent everywhere. Default 15.
async function resolveAbsentGrace() {
  try { return (await require('../../services/payroll-settings.service').getResolved()).lateLogin.graceMinutes; }
  catch { return 15; }
}
async function getEmployeeShift(employeeId) {
  try {
    // Optional columns: degrade to defaults if the shift columns don't exist.
    const e = await d365.getByIdOptional(EMP_ENTITY, employeeId, { select: 'hr_hremployeeid', optionalSelect: SHIFT_COLS });
    return shiftOf(e);
  } catch (_) { return resolveShift(); }
}
// Shift EFFECTIVE on a specific attendance DATE (history-aware; falls back to the
// employee's current shift). Use for any PAST-dated recompute (edit / correction /
// historical entry) so a later shift change never re-judges an old day.
async function getEmployeeShiftForDate(employeeId, date) {
  try { return await require('../../services/shift-history.service').resolveShiftForDate(employeeId, String(date).slice(0, 10)); }
  catch (_) { return getEmployeeShift(employeeId); }
}
// Real-time Late Entry email (employee only). Runs detached so it can NEVER delay or
// fail a check-in; the ledger guarantees ONE email per employee+date even with the
// nightly scan also running. No-op when disabled or the check-in is within grace.
function maybeSendLateEntry(employeeId, date, shift, c) {
  if (!ecfg.notify.lateLoginNotice || (c?.lateEntryMinutes || 0) <= 0) return;
  Promise.resolve()
    .then(async () => {
      const emp = await d365.getByIdOptional(EMP_ENTITY, employeeId, { select: 'hr_hremployeeid,hr_hremployee1,hr_email' });
      if (!emp?.hr_email) return;
      const shiftLabel = emp.hr_shiftname || `${shift.start}–${shift.end}`;
      await exceptionSvc.sendLateLoginNotice(emp, {
        date, shift: shiftLabel, expectedTime: shift.start,
        actualTime: c.firstPunch ? time.to12h(c.firstPunch) : '', lateBy: c.lateEntryMinutes,
        grace: c.graceMinutes,
      });
    })
    .catch((err) => global.logger?.warn?.(`[checkin] late-entry notice failed: ${err.message}`));
}

/** employeeId → resolved shift, for multi-employee reports (overview/export). */
async function buildShiftMap() {
  const map = new Map();
  try {
    const { data } = await d365.getListOptional(EMP_ENTITY, { select: 'hr_hremployeeid', optionalSelect: SHIFT_COLS, top: 5000 });
    (data || []).forEach(e => map.set(e.hr_hremployeeid, shiftOf(e)));
  } catch (_) { /* fall back to default per record */ }
  return map;
}

/** Date-aware shift resolver for multi-employee reports: (employeeId, date) → the shift
 *  EFFECTIVE on that date (history-aware; falls back to the employee's current shift).
 *  One shift-history query for the whole report, not one per employee. */
async function buildShiftResolver() {
  const sh = require('../../services/shift-history.service');
  const empMap = new Map();
  try { const { data } = await d365.getListOptional(EMP_ENTITY, { select: 'hr_hremployeeid', optionalSelect: SHIFT_COLS, top: 5000 }); (data || []).forEach(e => empMap.set(e.hr_hremployeeid, e)); } catch (_) {}
  const histMap = await sh.loadHistoryMap();
  return (employeeId, date) => sh.shiftForDateFromMap(histMap, employeeId, date, empMap.get(employeeId));
}

// An employee's FIRST attendance date (device or web). Attendance history — and
// therefore Absent/Present/Working-day math — starts only from this date; nothing
// before the first punch is ever counted.
async function getFirstAttendanceDate(employeeId) {
  try {
    const { data } = await d365.getList(ENTITY, {
      select: 'hr_date', filter: `_hr_hremployee_value eq '${employeeId}'`, orderby: 'hr_date asc', top: 1,
    });
    return (data && data[0]) ? String(data[0].hr_date).slice(0, 10) : null;
  } catch (_) { return null; }
}
/** employeeId → first attendance date (min hr_date), via one aggregate query.
 * FetchXML groups a lookup by its LOGICAL name (hr_hremployee), not the OData
 * `_..._value` form — the latter errors and would leave the map empty, which then
 * zeroes every Absent count (working days clamp to 0). Callers must still tolerate
 * an empty map (see the in-range fallback in buildRangeSummary). */
async function getFirstAttendanceMap() {
  const map = new Map();
  try {
    const fetchXml = `<fetch aggregate="true"><entity name="hr_hrattendance">` +
      `<attribute name="hr_date" aggregate="min" alias="first"/>` +
      `<attribute name="hr_hremployee" groupby="true" alias="emp"/></entity></fetch>`;
    const rows = await d365.executeFetchXml('hr_hrattendances', fetchXml);
    for (const r of (rows || [])) {
      // A grouped lookup comes back as { Value } (or occasionally the raw guid).
      const emp = r.emp && typeof r.emp === 'object' ? r.emp.Value : r.emp;
      const first = r.first;
      if (emp && first) map.set(String(emp), String(first).slice(0, 10));
    }
  } catch (_) { /* degrade: buildRangeSummary falls back to earliest in-range punch */ }
  return map;
}

// Find the most recent prior-day record that is still OPEN (forgot checkout).
async function findOpenPriorRecord(employeeId, today) {
  const { data } = await d365.getList(ENTITY, {
    select: PUNCH_SELECT,
    filter: `_hr_hremployee_value eq '${employeeId}' and hr_date lt ${today}`,
    orderby: 'hr_date desc', top: 5,
  });
  for (const r of (data || [])) {
    if (punchesFromRecord(r).length % 2 === 1) return r;  // odd punches = open
  }
  return null;
}

// POST /api/attendance/checkin — append an IN punch (only when currently OUT/none)
router.post('/checkin', requireAnyPermission('attendance.view'), requireWebCheckinEnabled, async (req, res, next) => {
  try {
    const employeeId = req.user.id;
    const shift = await getEmployeeShift(employeeId);
    const { today, record } = await findTodayRecord(employeeId);

    // NOTE: an incomplete PRIOR day never blocks today's punch. Employees can always
    // check in/out; a forgotten checkout is fixed separately via an Attendance
    // Correction request (which only edits that past record on approval).
    if (!record) {
      const c = computeSession([{ t: nowHHMM(), d: 'in' }], shift);
      const created = await d365.create(ENTITY, {
        'hr_hremployee@odata.bind': `/hr_hremployees(${employeeId})`,
        hr_date: today,
        hr_source: toValue('hr_attendance_source', 'web_checkin'),
        ...punchPayload(c),
      });
      // Real-time Late Entry notice to the EMPLOYEE when this first check-in is past
      // the 5-min grace. Fire-and-forget (never blocks/fails the check-in) and the
      // ledger de-dupes vs. the nightly scan (one email per employee+date).
      maybeSendLateEntry(employeeId, today, shift, c);
      return res.json(labelsForEntity('hr_hrattendances', created));
    }

    const punches = punchesFromRecord(record);
    if (punches.length % 2 === 1) {
      return res.status(400).json({ error: 'You are already checked in — check out first' });
    }
    const c = computeSession([...punches, { t: nowHHMM(), d: 'in' }], shift);
    // A WEB check-in tags the record as web_checkin — even when appending to a day
    // that was started on the eTime device — so the Source reflects the web action.
    const updated = await d365.update(ENTITY, record.hr_hrattendanceid, {
      ...punchPayload(c), hr_source: toValue('hr_attendance_source', 'web_checkin'),
    });
    res.json(labelsForEntity('hr_hrattendances', updated));
  } catch (err) { next(err); }
});

// POST /api/attendance/checkout — append an OUT punch (only when currently IN). Session stays open.
router.post('/checkout', requireAnyPermission('attendance.view'), requireWebCheckinEnabled, async (req, res, next) => {
  try {
    const employeeId = req.user.id;
    const shift = await getEmployeeShift(employeeId);
    const { record } = await findTodayRecord(employeeId);
    if (!record) return res.status(400).json({ error: "You haven't checked in today" });

    const punches = punchesFromRecord(record);
    if (punches.length % 2 === 0) {
      return res.status(400).json({ error: 'You are not currently checked in' });
    }
    const c = computeSession([...punches, { t: nowHHMM(), d: 'out' }], shift);
    // A WEB check-out tags the record as web_checkin so the Source shows Web, not Device.
    const updated = await d365.update(ENTITY, record.hr_hrattendanceid, {
      ...punchPayload(c), hr_source: toValue('hr_attendance_source', 'web_checkin'),
    });
    res.json(labelsForEntity('hr_hrattendances', updated));
  } catch (err) { next(err); }
});

// POST /api/attendance/correction — resolve a forgot-checkout (actual checkout + reason).
// EDITING attendance is HR / Super Admin only. Employees must NOT edit attendance
// directly — they submit a Missing Punch request (/attendance-requests) that HR
// approves. This endpoint is the HR override path.
router.post('/correction', requireAnyPermission('attendance.add_punch'), async (req, res, next) => {
  try {
    const { attendanceId, actualCheckout, reason } = req.body;
    if (!attendanceId || !actualCheckout) {
      return res.status(400).json({ error: 'attendanceId and actualCheckout are required' });
    }
    const rec = await d365.getById(ENTITY, attendanceId, { select: PUNCH_SELECT });
    const punches = punchesFromRecord(rec);
    if (punches.length % 2 === 0) {
      return res.status(400).json({ error: 'This attendance is already complete' });
    }
    const shift = await getEmployeeShiftForDate(rec._hr_hremployee_value, rec.hr_date);
    const c = computeSession([...punches, { t: actualCheckout, d: 'out' }], shift, { graceMinutes: shift.grace, date: String(rec.hr_date).slice(0, 10) });
    const updated = await d365.update(ENTITY, attendanceId, {
      ...punchPayload(c),
      hr_source: toValue('hr_attendance_source', 'manual_correction'),
    });
    global.logger?.info(`Attendance correction by ${req.user.name} on ${rec.hr_date}: checkout ${actualCheckout} — reason: ${reason || '(none)'}`);
    res.json(labelsForEntity('hr_hrattendances', updated));
  } catch (err) { next(err); }
});

// ── Attendance edit / historical entry / audit (HR / Super Admin) ─────────────
const safeJson = (v) => { try { return JSON.parse(v || '{}'); } catch { return {}; } };
// Normalise a requested status label to a stored value; week_off is a derived
// non-working day (no stored status), lop maps to absent for a stored record.
function normalizeAttStatus(s) {
  const k = String(s || '').toLowerCase().replace(/\s+/g, '_');
  if (['week_off', 'weekoff', 'weekly_off'].includes(k)) return null;   // don't store
  const map = { present: 'present', absent: 'absent', lop: 'absent', half_day: 'half_day', halfday: 'half_day', holiday: 'holiday', incomplete: 'incomplete' };
  return map[k] || null;
}
function attSnapshot(rec) {
  return {
    inTime: rec.hr_intime || '', outTime: rec.hr_outtime || '',
    status: toLabel('hr_attendance_status', rec.hr_status) || '',
    workedHours: rec.hr_workedhours ?? '', breakHours: rec.hr_breakduration ?? '',
    effectiveHours: rec.hr_effectivehours ?? '', overtime: rec.hr_overtime ?? '',
  };
}
async function writeAttendanceAudit(entry) {
  const payload = {
    hr_name: `${entry.employeeName || entry.employeeId} · ${entry.date} · ${entry.action}`.slice(0, 250),
    hr_attendanceid: String(entry.attendanceId || ''), hr_employeeid: String(entry.employeeId || ''),
    hr_employeename: entry.employeeName || '', hr_date: String(entry.date || '').slice(0, 10),
    hr_action: entry.action || 'edited', hr_oldvalue: JSON.stringify(entry.oldValues || {}),
    hr_newvalue: JSON.stringify(entry.newValues || {}), hr_updatedby: entry.updatedBy || '',
    hr_updatedon: new Date().toISOString(), hr_reason: entry.reason || '',
  };
  try { await d365.create(ATT_AUDIT_SET, payload); }
  catch (err) {
    if (/Resource not found for the segment|does not exist|Could not find/i.test(err.message)) {
      await ensureAttendanceAuditTable(global.logger || console).catch(() => {});
      try { await d365.create(ATT_AUDIT_SET, payload); } catch (_) { /* best-effort */ }
    }
  }
}

// PUT /:id/edit — full HR/Admin attendance edit (in/out/break/status/overtime),
// with automatic recompute + audit. Works even after a correction request was
// approved (attendance records carry no lock). Payroll picks up the change on the
// next DRAFT generation of that month (locked/processed months are unaffected).
router.put('/:id/edit', requireAnyPermission('attendance.edit'), async (req, res, next) => {
  try {
    const { inTime, outTime, breakHours, workedHours, overtime, status, lateMinutes, reason } = req.body;
    const rec = await d365.getById(ENTITY, req.params.id, { select: PUNCH_SELECT });
    const empId = rec._hr_hremployee_value;
    const shift = await getEmployeeShiftForDate(empId, rec.hr_date);
    // Rebuild the day from the edited in/out (blanks dropped) and recompute under the
    // shift EFFECTIVE on this record's date.
    const times = [inTime, outTime].map(t => String(t ?? '').trim()).filter(Boolean);
    const c = computeSession(times, shift, { graceMinutes: shift.grace, date: String(rec.hr_date).slice(0, 10) });
    const payload = { ...punchPayload(c), hr_source: toValue('hr_attendance_source', 'manual_correction') };
    // Explicit HR overrides win over the recomputed values.
    const st = normalizeAttStatus(status);
    if (status && st) payload.hr_status = toValue('hr_attendance_status', st);
    if (overtime !== undefined && overtime !== '') payload.hr_overtime = Number(overtime) || 0;
    if (breakHours !== undefined && breakHours !== '') payload.hr_breakduration = Number(breakHours) || 0;
    if (workedHours !== undefined && workedHours !== '') payload.hr_workedhours = Number(workedHours) || 0;

    const before = attSnapshot(rec);
    const updated = await d365.update(ENTITY, req.params.id, payload);
    let empName = ''; try { const e = await d365.getById(EMP_ENTITY, empId, { select: 'hr_hremployee1' }); empName = e.hr_hremployee1 || ''; } catch {}
    const after = {
      inTime: payload.hr_intime, outTime: payload.hr_outtime,
      status: toLabel('hr_attendance_status', payload.hr_status) || '',
      workedHours: payload.hr_workedhours, breakHours: payload.hr_breakduration,
      effectiveHours: payload.hr_effectivehours, overtime: payload.hr_overtime,
      lateMinutes: (lateMinutes ?? c.lateArrivalMin),
    };
    await writeAttendanceAudit({ attendanceId: req.params.id, employeeId: empId, employeeName: empName, date: rec.hr_date, action: 'edited', oldValues: before, newValues: after, updatedBy: req.user.name || req.user.email, reason });
    activity.record({ category: 'Attendance', type: 'attendance_edited', title: 'Attendance edited', name: empName, meta: { date: rec.hr_date, by: req.user.name } });
    res.json(labelsForEntity('hr_hrattendances', updated));
  } catch (err) { next(err); }
});

// POST /historical — HR/Admin manual historical attendance entry for a PAST date.
// Recomputes hours/status; warns (409) on a duplicate unless overwrite=true.
router.post('/historical', requireAnyPermission('attendance.edit'), async (req, res, next) => {
  try {
    const { employeeId, date, inTime, outTime, status, remarks, overwrite } = req.body;
    if (!employeeId || !date) return res.status(400).json({ error: 'Employee and date are required.' });
    const ds = String(date).slice(0, 10);
    const existing = await d365.getList(ENTITY, { select: PUNCH_SELECT, filter: `_hr_hremployee_value eq '${employeeId}' and hr_date eq ${ds}`, top: 1 });
    const dup = existing.data && existing.data[0];
    if (dup && !overwrite) {
      return res.status(409).json({ error: `Attendance already exists for this employee on ${ds}. Enable overwrite to replace it.`, duplicate: true, existing: labelsForEntity('hr_hrattendances', dup) });
    }
    const shift = await getEmployeeShiftForDate(employeeId, ds);
    const times = [inTime, outTime].map(t => String(t ?? '').trim()).filter(Boolean);
    const c = computeSession(times, shift, { graceMinutes: shift.grace, date: ds });
    const payload = { ...punchPayload(c), hr_source: toValue('hr_attendance_source', 'manual_correction') };
    const st = normalizeAttStatus(status);
    if (status && st) payload.hr_status = toValue('hr_attendance_status', st);

    let saved, action;
    let empName = ''; try { const e = await d365.getById(EMP_ENTITY, employeeId, { select: 'hr_hremployee1' }); empName = e.hr_hremployee1 || ''; } catch {}
    if (dup) {
      const before = attSnapshot(dup);
      saved = await d365.update(ENTITY, dup.hr_hrattendanceid, payload); action = 'historical_update';
      await writeAttendanceAudit({ attendanceId: dup.hr_hrattendanceid, employeeId, employeeName: empName, date: ds, action, oldValues: before, newValues: { inTime: payload.hr_intime, outTime: payload.hr_outtime, status: toLabel('hr_attendance_status', payload.hr_status) || '' }, updatedBy: req.user.name || req.user.email, reason: remarks });
    } else {
      saved = await d365.create(ENTITY, { 'hr_hremployee@odata.bind': `/hr_hremployees(${employeeId})`, hr_date: ds, ...payload }); action = 'historical_entry';
      await writeAttendanceAudit({ attendanceId: saved.hr_hrattendanceid, employeeId, employeeName: empName, date: ds, action, oldValues: {}, newValues: { inTime: payload.hr_intime, outTime: payload.hr_outtime, status: toLabel('hr_attendance_status', payload.hr_status) || '' }, updatedBy: req.user.name || req.user.email, reason: remarks });
    }
    activity.record({ category: 'Attendance', type: action, title: dup ? 'Historical attendance updated' : 'Historical attendance added', name: empName, meta: { date: ds, by: req.user.name } });
    res.status(dup ? 200 : 201).json(labelsForEntity('hr_hrattendances', saved));
  } catch (err) { next(err); }
});

// GET /audit — attendance edit history (HR / Super Admin). Filter by ?attendanceId / ?employeeId / ?date.
router.get('/audit', requireAnyPermission('attendance.export'), async (req, res, next) => {
  try {
    const { attendanceId, employeeId, date } = req.query;
    const filters = [];
    if (attendanceId) filters.push(`hr_attendanceid eq '${attendanceId}'`);
    if (employeeId) filters.push(`hr_employeeid eq '${employeeId}'`);
    if (date) filters.push(`hr_date eq '${String(date).slice(0, 10)}'`);
    const { data } = await d365.getList(ATT_AUDIT_SET, {
      select: 'hr_attendanceauditid,hr_attendanceid,hr_employeename,hr_date,hr_action,hr_oldvalue,hr_newvalue,hr_updatedby,hr_updatedon,hr_reason',
      filter: filters.join(' and ') || undefined, orderby: 'createdon desc', top: 500,
    });
    res.json({ data: (data || []).map(r => ({
      id: r.hr_attendanceauditid, attendanceId: r.hr_attendanceid, employeeName: r.hr_employeename,
      date: r.hr_date, action: r.hr_action, oldValues: safeJson(r.hr_oldvalue), newValues: safeJson(r.hr_newvalue),
      updatedBy: r.hr_updatedby, updatedOn: r.hr_updatedon, reason: r.hr_reason || '',
    })) });
  } catch (_) { res.json({ data: [] }); }
});

// Build the full session view returned to clients (facts computed on read).
function sessionView(record, shift) {
  const c = computeSession(record ? punchesFromRecord(record) : [], shift || resolveShift(), record ? { date: String(record.hr_date).slice(0, 10) } : {});
  return {
    state: c.state,                 // 'none' | 'in' | 'out'
    canCheckIn: c.state !== 'in',   // after any OUT you can check in again
    canCheckOut: c.state === 'in',
    punchCount: c.count,
    punches: c.punches,
    firstPunch: c.firstPunch,
    lastPunch: c.lastPunch,
    workedHours: c.totalSpanHours,
    breakHours: c.breakHours,
    effectiveHours: c.effectiveHours,
    overtimeHours: c.overtimeHours,
    // Punch timeline (§12/§18): completed IN→OUT sessions + open session + worked minutes.
    sessions: c.sessions,
    openSession: c.openSession,
    totalWorkedMinutes: c.totalWorkedMinutes,
    lateArrivalMin: c.lateArrivalMin,
    earlyDepartureMin: c.earlyDepartureMin,
    compensationStatus: c.compensationStatus,
    attendanceStatus: c.status,
    shift: c.shift,
    // backward-compatible aliases (kept so nothing else breaks)
    breakDuration: c.breakHours,
    checkedIn: c.state === 'in',
    checkedOut: c.state === 'out',
  };
}

// GET /api/attendance/my-status — full session so the UI always offers the right next action
router.get('/my-status', requireAnyPermission('attendance.view'), async (req, res, next) => {
  try {
    const shift = await getEmployeeShift(req.user.id);
    const { today, record } = await findTodayRecord(req.user.id);
    const openPrior = record ? null : await findOpenPriorRecord(req.user.id, today);
    const webCheckinEnabled = await webCheckin.isEnabled(req.user.id);
    res.json({
      ...sessionView(record, shift),
      webCheckinEnabled,   // UI shows the Web Check-In button only when true
      incompletePrevious: openPrior ? labelsForEntity('hr_hrattendances', openPrior) : null,
      record: record ? labelsForEntity('hr_hrattendances', record) : null,
    });
  } catch (err) { next(err); }
});

// GET /api/attendance/first-date — the employee's dynamic Attendance Start Date:
// the earliest attendance record of ANY source (device / web / manual). Drives the
// date-picker minDate and quick-filter clamping on the client. Never hardcoded;
// null when the employee has no attendance history yet. HR may pass ?employeeId=.
router.get('/first-date', requireAnyPermission('attendance.view'), async (req, res, next) => {
  try {
    // Employees clamp to their OWN first punch. HR/Admin clamp only when viewing a
    // SPECIFIC employee; "All Employees" (no employeeId) has no single start date,
    // so there is NO minimum — don't fall back to the admin's own first punch.
    const targetId = req.user.role === 'employee' ? req.user.id : req.query.employeeId;
    if (!targetId) return res.json({ firstDate: null });
    const firstDate = await getFirstAttendanceDate(targetId);   // min hr_date, computed once
    res.json({ firstDate: firstDate || null });
  } catch (err) { next(err); }
});

// ── Dynamic summaries (no fixed calendar values) ─────────────────────────────
function countWorkingDays(y, m) {
  const daysInMonth = new Date(y, m, 0).getDate();
  let count = 0;
  for (let d = 1; d <= daysInMonth; d++) {
    const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
    const dateStr = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    if (attnCfg.weekOffDays.includes(dow)) continue;   // week-off (configurable, not counted)
    if (attnCfg.holidays.includes(dateStr)) continue;  // holiday (not counted / not absent)
    count++;
  }
  return count;
}

// GET /api/attendance/summary/monthly — Present/Half/Absent/Leave/Late/Early/Overtime (dynamic)
router.get('/summary/monthly', requireAnyPermission('attendance.view'), async (req, res, next) => {
  try {
    const now = new Date();
    const y = parseInt(req.query.year) || now.getFullYear();
    const m = parseInt(req.query.month) || (now.getMonth() + 1);
    const targetId = req.user.role === 'employee' ? req.user.id : (req.query.employeeId || req.user.id);
    const mm = String(m).padStart(2, '0');
    const from = `${y}-${mm}-01`, to = `${y}-${mm}-31`;

    const { data: recs } = await d365.getList(ENTITY, {
      select: PUNCH_SELECT,
      filter: `_hr_hremployee_value eq '${targetId}' and hr_date ge ${from} and hr_date le ${to}`,
      orderby: 'hr_date asc',
    });
    // Resolve the shift EFFECTIVE on each day (history-aware) — one history load, reused.
    const shiftResolver = await require('../../services/shift-history.service').shiftResolverFor(targetId);
    let present = 0, halfDay = 0, incomplete = 0, attended = 0, lateCount = 0, earlyCount = 0, overtimeHours = 0;
    for (const r of (recs || [])) {
      const s = shiftResolver.forDate(String(r.hr_date).slice(0, 10));
      const c = computeSession(punchesFromRecord(r), s, { graceMinutes: s.grace, date: String(r.hr_date).slice(0, 10) });
      if ((c.count || 0) > 0) attended++;             // any punch → NOT absent
      if (c.status === 'present') present++;
      else if (c.status === 'half_day') halfDay++;
      else if (c.status === 'incomplete') incomplete++;
      if (c.lateArrivalMin > 0) lateCount++;
      if (c.earlyDepartureMin > 0) earlyCount++;
      overtimeHours += c.overtimeHours;
    }

    const { data: leaves } = await d365.getList(d365.constructor.entities.leave, {
      select: 'hr_days,hr_fromdate,hr_todate,hr_status',
      filter: `_hr_hremployee_value eq '${targetId}' and hr_status eq ${toValue('hr_leave_status', 'approved')}`,
    });
    // Absent only counts working days that have already occurred (up to today).
    const today = time.istDateStr();
    const workingDays = countWorkingDays(y, m);                  // full month (display)
    const monthEnd = `${y}-${mm}-${String(new Date(y, m, 0).getDate()).padStart(2, '0')}`;
    const capTo = today < monthEnd ? today : monthEnd;           // min(today, last day of month)
    // Approved-leave WORKING days in [from, capTo] via the shared engine — matches
    // /stats and /absentees exactly (calendar-day counting over-subtracted and
    // leaked future days).
    const leaveDays = approvedLeaveWorkingDays(leaves || [], from, capTo);
    // Working days start at the employee's FIRST attendance date (never before
    // their first punch). No attendance history → 0 working days → 0 absent.
    // Prefer the true first-ever date; fall back to the earliest in-range punch
    // (recs are ordered hr_date asc) so a lookup miss never zeroes Absent.
    const firstDate = (await getFirstAttendanceDate(targetId))
      || (recs && recs[0] ? String(recs[0].hr_date).slice(0, 10) : null);
    const workingElapsed = effectiveWorking(from, capTo, firstDate);
    // Absent = Elapsed Working − Attended (any punch, incl. incomplete) − Leave.
    const absentDays = Math.max(0, workingElapsed - attended - leaveDays);

    res.json({
      month: m, year: y, workingDays, workingElapsed,
      presentDays: present, halfDays: halfDay, incompleteDays: incomplete, attendedDays: attended,
      leaveDays, absentDays,
      lateCount, earlyExitCount: earlyCount,
      overtimeHours: Math.round(overtimeHours * 100) / 100,
    });
  } catch (err) { next(err); }
});

// GET /api/attendance/monthly-balance — INDEPENDENT monthly hour balance (no carry-
// forward). Employee sees their own; HR may pass ?employeeId=. A negative balance is
// deducted as EXACT hours × the existing hourly rate (no LOP days). Reuses the daily
// engine + shift history + approved leave. Only dates on/after the effective cutoff.
router.get('/monthly-balance', requireAnyPermission('attendance.view'), async (req, res, next) => {
  try {
    const now = new Date();
    const y = parseInt(req.query.year) || now.getFullYear();
    const m = parseInt(req.query.month) || (now.getMonth() + 1);
    const targetId = req.user.role === 'employee' ? req.user.id : (req.query.employeeId || req.user.id);

    // Each month is computed independently — NO previous/next month balance.
    const report = await monthlyBalance.buildMonthlyBalance({ employeeId: targetId, year: y, month: m });
    // Exact-hours salary deduction for a negative balance via the EXISTING hourly rate
    // (read-only). Payroll still owns the authoritative run — not modified here.
    const deduction = await monthlyBalance.estimateSalaryDeduction({ employeeId: targetId, year: y, month: m, shortageHours: report.shortageHours });

    let employeeName = req.user.name || 'Employee';
    if (targetId !== req.user.id) {
      try { const e = await d365.getByIdOptional(EMP_ENTITY, targetId, { select: 'hr_hremployeeid', optionalSelect: 'hr_hremployee1' }); employeeName = e?.hr_hremployee1 || employeeName; } catch { /* keep default */ }
    }
    res.json({ employeeId: targetId, employeeName, ...report, hourlyRate: deduction.hourlyRate, salaryDeduction: deduction.salaryDeduction });
  } catch (err) { next(err); }
});

// GET /api/attendance/hr/overview — HR dashboard (today), computed on read
router.get('/hr/overview', requireAnyPermission('attendance.export'), async (req, res, next) => {
  try {
    const today = time.istDateStr();
    const { data: recs } = await d365.getList(ENTITY, {
      select: PUNCH_SELECT, filter: `hr_date eq ${today}`,
    });
    const shiftFor = await buildShiftResolver();
    let inside = 0, outside = 0, incomplete = 0, late = 0, early = 0, overtime = 0;
    for (const r of (recs || [])) {
      const s = shiftFor(r._hr_hremployee_value, r.hr_date);
      const c = computeSession(punchesFromRecord(r), s, { graceMinutes: s.grace, date: String(r.hr_date).slice(0, 10) });
      if (c.state === 'in') inside++;
      else if (c.state === 'out') outside++;
      if (c.status === 'incomplete') incomplete++;
      if (c.lateArrivalMin > 0) late++;
      if (c.earlyDepartureMin > 0) early++;
      overtime += c.overtimeHours;
    }
    res.json({
      date: today,
      employeesInside: inside, employeesOutside: outside,
      incompleteAttendance: incomplete, lateEmployees: late, earlyExit: early,
      overtimeHours: Math.round(overtime * 100) / 100,
      totalMarkedToday: (recs || []).length,
    });
  } catch (err) { next(err); }
});

// ── Excel export: Employee Attendance Summary (default) + Daily detail ───────
const { rangeCounts, summarizeEmployee, effectiveWorking, approvedLeaveWorkingDays, approvedLeaveDaysWeighted, absentDatesFor, gracePassedToday, expandLeaveDays } = require('../../services/attendance-summary.util');
const { resolveDays } = require('../../services/leave-summary.util');   // blank hr_days → from→to span
const { buildAttendanceRow, buildLopReconRow, pendingLopDayCount } = require('../../services/payroll-recon.util');
const companyPolicy = require('../../services/company.policy');

/** Run async `fn` over `items` with at most `limit` in flight (bounds per-employee I/O). */
async function mapWithConcurrency(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => { while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); } };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}
const pad2 = (n) => String(n).padStart(2, '0');
const fmtDur = (h) => {
  const v = Number(h);
  if (!Number.isFinite(v) || v <= 0) return '0m';
  let H = Math.floor(v), M = Math.round((v - H) * 60);
  if (M === 60) { H++; M = 0; }
  return H === 0 ? `${M}m` : (M === 0 ? `${H}h` : `${H}h ${M}m`);
};
const fmtMin = (m) => fmtDur((Number(m) || 0) / 60);

/**
 * SINGLE SOURCE OF TRUTH for range attendance figures (Present/Half/Incomplete/
 * Absent/Leave). Used by BOTH the /stats cards and the Excel export so every view
 * shows the SAME absent count. Absent is ENUMERATED (absentDatesFor) — a working day
 * with no attendance record and no approved leave — identical to /absentees.
 */
async function buildRangeSummary(from, to, { targetId, department, designation } = {}) {
  const f = [`hr_date ge ${from}`, `hr_date le ${to}`];
  if (targetId) f.push(`_hr_hremployee_value eq '${targetId}'`);
  const { data: recs } = await d365.getAll(ENTITY, {
    select: PUNCH_SELECT, filter: f.join(' and '), orderby: 'hr_date desc',
  }, 10000);

  const { data: emps } = await d365.getListOptional(d365.constructor.entities.employee, {
    select: 'hr_hremployeeid,hr_hremployee1,hr_department,hr_designation',
    optionalSelect: `${SHIFT_COLS},hr_etimecode`,   // hr_etimecode → the "Employee ID" column
    filter: `hr_status eq ${toValue('hr_employee_status', 'active')}`, top: 5000,
  });
  const empMap = new Map((emps || []).map(e => [e.hr_hremployeeid, e]));

  // Absent is only meaningful up to TODAY — future working days haven't happened
  // yet, so they must NEVER be counted as Absent (per-employee working days are
  // computed below from each employee's first attendance date).
  const today = time.istDateStr();
  const capTo = to < today ? to : today;                                  // min(to, today)

  // APPROVED + PENDING leave, expanded to per-(employee, working-date) with type+status —
  // the SAME classification the payroll rule uses (approved = paid/Payable, pending = held,
  // never Absent/LOP). Rejected/cancelled are never fetched, so they stay Absent. Expanded
  // over the FULL selected range so a future approved/pending leave still shows on the page;
  // Absent enumeration itself only ever reaches capTo (today), so future dates never count.
  const { data: leaves } = await d365.getListOptional(d365.constructor.entities.leave, {
    select: 'hr_days,hr_fromdate,hr_todate,_hr_hremployee_value,hr_status,hr_leavetype',
    optionalSelect: 'hr_usecompoff',
    filter: `(hr_status eq ${toValue('hr_leave_status', 'approved')} or hr_status eq ${toValue('hr_leave_status', 'pending')})`,
  });
  const normLeaves = (leaves || []).map(l => ({
    employeeId: l._hr_hremployee_value, fromDate: l.hr_fromdate, toDate: l.hr_todate,
    type: l.hr_usecompoff === 'true' ? 'Comp Off' : toLabel('hr_leave_type', l.hr_leavetype),
    status: toLabel('hr_leave_status', l.hr_status),
  }));
  const leaveInfoByEmp = expandLeaveDays(normLeaves, from, to);           // Map(empId → Map(date → {type,status}))
  // APPROVED leaves grouped per employee (raw rows carry hr_days for half-day duration) —
  // the source for "Salary Working Days = Working Days − approved leave working days".
  const approvedLeavesByEmp = {};
  for (const l of leaves || []) {
    if (toLabel('hr_leave_status', l.hr_status) !== 'approved') continue;   // pending/rejected/cancelled excluded
    (approvedLeavesByEmp[l._hr_hremployee_value] = approvedLeavesByEmp[l._hr_hremployee_value] || []).push(l);
  }
  const recordDatesByEmp = {};
  (recs || []).forEach(r => {
    const ds = String(r.hr_date || '').slice(0, 10);
    if (!ds) return;
    (recordDatesByEmp[r._hr_hremployee_value] = recordDatesByEmp[r._hr_hremployee_value] || new Set()).add(ds);
  });

  const rc = rangeCounts(from, to);
  const firstMap = await getFirstAttendanceMap();   // employeeId → first attendance date

  // Compute each day's session once with THAT employee's shift; group by employee.
  // Also track each employee's EARLIEST in-range punch date as a resilient fallback
  // for the first-attendance clamp (used when the aggregate map is unavailable —
  // without it a failed map would clamp working days to 0 and zero every Absent).
  const byEmp = {};
  const firstInRange = {};
  // Resolve each record under the shift EFFECTIVE on ITS date (history-aware) — one load.
  const shiftSvc = require('../../services/shift-history.service');
  const histMap = await shiftSvc.loadHistoryMap();
  const computed = (recs || []).map(r => {
    const emp = empMap.get(r._hr_hremployee_value) || {};
    const ds = String(r.hr_date).slice(0, 10);
    const s = shiftSvc.shiftForDateFromMap(histMap, r._hr_hremployee_value, ds, emp);
    const c = computeSession(punchesFromRecord(r), s, { graceMinutes: s.grace, date: String(r.hr_date).slice(0, 10) });
    (byEmp[r._hr_hremployee_value] = byEmp[r._hr_hremployee_value] || []).push({ ...c, date: r.hr_date });
    if (!firstInRange[r._hr_hremployee_value] || ds < firstInRange[r._hr_hremployee_value]) {
      firstInRange[r._hr_hremployee_value] = ds;
    }
    return { r, c, emp };
  });

  let scope = emps || [];
  if (targetId) scope = scope.filter(e => e.hr_hremployeeid === targetId);
  if (department) scope = scope.filter(e => e.hr_department === department);
  if (designation) scope = scope.filter(e => e.hr_designation === designation);

  // Each employee's Working Days start at their FIRST attendance date (never
  // before their first punch) and end at min(to, today). An employee with no
  // attendance history at all has 0 working days → never marked Absent.
  // Per-employee grace evaluation: is today still "Pending Attendance" (pre-grace)?
  const nowMin = istNowMinutes();
  const graceMin = await resolveAbsentGrace();
  const todayInRange = capTo >= today;
  const perEmployee = scope.map(e => {
    const recordSet = recordDatesByEmp[e.hr_hremployeeid] || new Set();
    const leaveMap = leaveInfoByEmp.get(e.hr_hremployeeid) || new Map();   // date → {type,status}
    // ACTUAL Absent excludes BOTH approved AND pending leave: a pending-leave day is NOT an
    // actual Absent — it has its own "Leave Pending" status/count. (Rejected/cancelled are never
    // fetched, so those days stay Absent.) The optional "Include Pending Leave" toggle only adds
    // pending rows to the Absent DETAIL view — it never changes this Absent count.
    const leaveSet = new Set(leaveMap.keys());                             // approved+pending → NEVER actual Absent
    let approvedDays = 0, pendingDays = 0;
    for (const info of leaveMap.values()) { if (info.status === 'approved') approvedDays++; else if (info.status === 'pending') pendingDays++; }
    // Prefer the true first-ever date; fall back to the earliest in-range punch so
    // an unavailable aggregate never forces working days (and thus Absent) to 0.
    const firstDate = firstMap.get(e.hr_hremployeeid) || firstInRange[e.hr_hremployeeid] || null;
    const working = effectiveWorking(from, capTo, firstDate);
    const summary = summarizeEmployee(byEmp[e.hr_hremployeeid] || [], { working, leaveDays: approvedDays });
    // Absent = ENUMERATED working dates with no record and no approved/pending leave. Today
    // counts only once this employee's own shift-start + grace has passed (spec §7/§8).
    const todayPending = todayInRange && !gracePassedToday(shiftOf(e), graceMin, nowMin);
    summary.absent = absentDatesFor(from, capTo, firstDate, ds => recordSet.has(ds), ds => leaveSet.has(ds), { today, todayPending }).length;
    // Approved leave working-day equivalent for the FULL selected month (half-day aware,
    // weekend/holiday-excluded, overlap-deduped, month-clipped). Drives Salary Working Days.
    const approvedLeaveDays = approvedLeaveDaysWeighted(approvedLeavesByEmp[e.hr_hremployeeid] || [], from, to);
    return { emp: e, approvedDays, pendingDays, approvedLeaveDays, working, firstDate, summary, leaveMap, recordSet };
  });

  const totals = perEmployee.reduce((t, p) => {
    t.present += p.summary.present; t.half += p.summary.half; t.incomplete += p.summary.incomplete; t.inProgress += p.summary.inProgress;
    t.attended += p.summary.attended; t.absent += p.summary.absent;
    t.leaveApproved += p.approvedDays; t.leavePending += p.pendingDays;
    t.effectiveHours += p.summary.effectiveHours; t.overtimeHours += p.summary.overtimeHours;
    return t;
  }, { present: 0, half: 0, incomplete: 0, inProgress: 0, attended: 0, absent: 0, leaveApproved: 0, leavePending: 0, effectiveHours: 0, overtimeHours: 0, employees: perEmployee.length });
  totals.leave = totals.leaveApproved;                       // back-compat: "Leave" column = approved working days
  totals.leaveApplied = totals.leaveApproved + totals.leavePending;

  // Per-(employee, date) leave rows for the table overlay — a leave date with an
  // attendance record is NOT emitted (the punch wins: Present, not a leave row).
  const leaveDays = [];
  for (const p of perEmployee) {
    if (!p.leaveMap.size) continue;
    for (const [date, info] of p.leaveMap) {
      if (p.recordSet.has(date)) continue;                   // present/punched → the record row shows it
      leaveDays.push({ employeeId: p.emp.hr_hremployeeid, employee: p.emp.hr_hremployee1 || 'Employee', department: p.emp.hr_department || '', date, leaveType: info.type, leaveStatus: info.status });
    }
  }

  return { rc, empMap, byEmp, computed, perEmployee, totals, leaveDays };
}

// GET /api/attendance/stats — aggregate Present/Half/Incomplete/Absent/Leave for
// a date range (+ optional employee/department/designation). Same math as the
// export, so the dashboard cards and the Excel file always agree.
router.get('/stats', requireAnyPermission('attendance.view'), async (req, res, next) => {
  try {
    const { department, designation } = req.query;
    const targetId = req.user.role === 'employee' ? req.user.id : req.query.employeeId;
    const now = new Date();
    const from = req.query.from || `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-01`;
    const to = req.query.to || `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate())}`;
    const { rc, totals, leaveDays } = await buildRangeSummary(from, to, { targetId, department, designation });
    res.json({
      from, to,
      calendar: rc.calendar, working: rc.working, holidays: rc.holidays, weeklyOff: rc.weeklyOff,
      present: totals.present, halfDay: totals.half, incomplete: totals.incomplete, inProgress: totals.inProgress,
      absent: totals.absent, leave: totals.leave, attended: totals.attended,
      // Leave summary (respects the same employee/department/date filters).
      leaveApplied: totals.leaveApplied, leavePending: totals.leavePending, leaveApproved: totals.leaveApproved,
      leaveDays,                                    // [{ employeeId, employee, date, leaveType, leaveStatus }]
      employees: totals.employees,
    });
  } catch (err) { next(err); }
});

// GET /api/attendance/weekly — Present/Absent per weekday (Mon–Fri) for the
// current week, for the dashboard chart. Present = employees with a punch that
// day; Absent = active − present − leave on a working day (0 for future days).
router.get('/weekly', requireAnyPermission('attendance.export'), async (req, res, next) => {
  try {
    const today = time.istDateStr();
    const addDays = (ds, n) => { const d = new Date(`${ds}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`; };
    const dow = new Date(`${today}T00:00:00Z`).getUTCDay();           // 0 Sun … 6 Sat
    const monday = addDays(today, dow === 0 ? -6 : 1 - dow);
    const dayNames = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'];
    const dates = dayNames.map((_, i) => addDays(monday, i));
    const from = dates[0], to = dates[4];

    const { data: recs } = await d365.getAll(ENTITY, {
      select: 'hr_date,_hr_hremployee_value,hr_allpunches,hr_intime,hr_outtime,hr_punchcount',
      filter: `hr_date ge ${from} and hr_date le ${to}`, orderby: 'hr_date desc',
    }, 10000);
    const presentByDate = {}; dates.forEach(d => (presentByDate[d] = new Set()));
    (recs || []).forEach(r => {
      const d = String(r.hr_date || '').slice(0, 10);
      if (presentByDate[d] && punchesFromRecord(r).length > 0) presentByDate[d].add(r._hr_hremployee_value);
    });

    const { data: emps } = await d365.getListOptional(d365.constructor.entities.employee, {
      select: 'hr_hremployeeid', optionalSelect: SHIFT_COLS, filter: `hr_status eq ${toValue('hr_employee_status', 'active')}`, top: 5000,
    });
    const activeCount = (emps || []).length;

    const { data: leaves } = await d365.getList(d365.constructor.entities.leave, {
      select: 'hr_fromdate,hr_todate,_hr_hremployee_value,hr_status', filter: `hr_status eq ${toValue('hr_leave_status', 'approved')}`,
    });
    const leaveByDate = {}; dates.forEach(d => (leaveByDate[d] = new Set()));
    (leaves || []).forEach(l => {
      const lf = String(l.hr_fromdate || '').slice(0, 10);
      const lt = String(l.hr_todate || '').slice(0, 10) || lf;
      dates.forEach(d => { if (d >= lf && d <= lt) leaveByDate[d].add(l._hr_hremployee_value); });
    });

    const data = dates.map((d, i) => {
      const isWorking = !attnCfg.weekOffDays.includes(new Date(`${d}T00:00:00Z`).getUTCDay()) && !attnCfg.holidays.includes(d);
      const present = presentByDate[d].size;
      const absent = (isWorking && d <= today) ? Math.max(0, activeCount - present - leaveByDate[d].size) : 0;
      return { day: dayNames[i], date: d, present, absent };
    });
    res.json({ data });
  } catch (err) { next(err); }
});

// GET /api/attendance/absentees — the actual absent (employee, working-day) rows.
// Absent = active employee on a WORKING day (not week-off/holiday, up to today)
// with NO punch and NO approved leave. Powers the "Absent" table view — since an
// absent day has no attendance record, these rows are synthesized here.
router.get('/absentees', requireAnyPermission('attendance.view'), async (req, res, next) => {
  try {
    const { department, designation } = req.query;
    const targetId = req.user.role === 'employee' ? req.user.id : req.query.employeeId;
    const now = new Date();
    const from = req.query.from || `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-01`;
    const to = req.query.to || `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate())}`;
    const today = time.istDateStr();

    // Working dates in range, only up to today (exclude week-off & holidays).
    const capTo = to < today ? to : today;
    const workDates = [];
    if (capTo >= from) {
      const end = new Date(`${capTo}T00:00:00Z`);
      for (let d = new Date(`${from}T00:00:00Z`); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
        const ds = `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
        if (attnCfg.holidays.includes(ds)) continue;
        if (attnCfg.weekOffDays.includes(d.getUTCDay())) continue;
        workDates.push(ds);
      }
    }
    if (!workDates.length) return res.json({ data: [], count: 0 });

    // (employee|date) that already have attendance activity.
    const f = [`hr_date ge ${from}`, `hr_date le ${to}`];
    if (targetId) f.push(`_hr_hremployee_value eq '${targetId}'`);
    const { data: recs } = await d365.getAll(ENTITY, {
      select: 'hr_date,_hr_hremployee_value,hr_allpunches,hr_intime,hr_outtime,hr_punchcount',
      filter: f.join(' and '), orderby: 'hr_date desc',
    }, 10000);
    // A date is NOT synthesized as absent when the employee has ANY attendance
    // record for it — the record itself represents the day (shown in the list with
    // its computed status). This guarantees ONE row per employee per date: a
    // Present/manual/Historical record never coexists with a synthesized "Absent".
    const active = new Set();
    (recs || []).forEach(r => active.add(`${r._hr_hremployee_value}|${String(r.hr_date).slice(0, 10)}`));

    // Active employees in scope.
    const { data: emps } = await d365.getListOptional(d365.constructor.entities.employee, {
      select: 'hr_hremployeeid,hr_hremployee1,hr_department,hr_designation', optionalSelect: SHIFT_COLS,
      filter: `hr_status eq ${toValue('hr_employee_status', 'active')}`, top: 5000,
    });
    let scope = emps || [];
    if (targetId) scope = scope.filter(e => e.hr_hremployeeid === targetId);
    if (department) scope = scope.filter(e => e.hr_department === department);
    if (designation) scope = scope.filter(e => e.hr_designation === designation);

    // Approved + Pending leave (employee|date). BOTH suppress ACTUAL Absent (a pending-leave day
    // is never an actual Absent — same as /stats); rejected/cancelled stay Absent. `pendingLeave`
    // is tracked separately to power the OPTIONAL "Include Pending Leave" view.
    const includePending = /^(1|true|yes)$/i.test(String(req.query.includePending || ''));
    const { data: leaves } = await d365.getList(d365.constructor.entities.leave, {
      select: 'hr_fromdate,hr_todate,_hr_hremployee_value,hr_status,hr_leavetype',
      filter: `(hr_status eq ${toValue('hr_leave_status', 'approved')} or hr_status eq ${toValue('hr_leave_status', 'pending')})`,
    });
    const onLeave = new Set();
    const pendingLeaveType = new Map();   // employee|date → leave type (pending only), for the optional rows
    (leaves || []).forEach(l => {
      const lf = String(l.hr_fromdate || '').slice(0, 10);
      const lt = String(l.hr_todate || '').slice(0, 10) || lf;
      const isPending = toLabel('hr_leave_status', l.hr_status) === 'pending';
      for (const ds of workDates) if (ds >= lf && ds <= lt) {
        onLeave.add(`${l._hr_hremployee_value}|${ds}`);
        if (isPending) pendingLeaveType.set(`${l._hr_hremployee_value}|${ds}`, toLabel('hr_leave_type', l.hr_leavetype));
      }
    });

    // Clamp each employee's absent days to start at their FIRST attendance date —
    // exactly like /stats (effectiveWorking). Without this, a new joiner (or an
    // employee with no history) is wrongly listed absent for the whole range, so
    // the Absent CARD (/stats) and the Absent LIST (/absentees) would diverge.
    const firstMap = await getFirstAttendanceMap();
    // Earliest in-range record per employee — same first-date fallback as /stats, so
    // the Absent LIST and the Absent CARD are computed from identical inputs.
    const firstInRange = {};
    (recs || []).forEach(r => {
      const ds = String(r.hr_date || '').slice(0, 10);
      if (ds && (!firstInRange[r._hr_hremployee_value] || ds < firstInRange[r._hr_hremployee_value])) firstInRange[r._hr_hremployee_value] = ds;
    });
    const nowMin = istNowMinutes();
    const graceMin = await resolveAbsentGrace();
    const todayInRange = capTo >= today;
    const CAP = 5000;
    const rows = [];
    for (const e of scope) {
      const firstDate = firstMap.get(String(e.hr_hremployeeid)) || firstInRange[e.hr_hremployeeid] || null;
      if (!firstDate) continue;   // no attendance history → never counted absent (matches /stats)
      const todayPending = todayInRange && !gracePassedToday(shiftOf(e), graceMin, nowMin);
      const dates = absentDatesFor(from, capTo, firstDate,
        ds => active.has(`${e.hr_hremployeeid}|${ds}`),
        ds => onLeave.has(`${e.hr_hremployeeid}|${ds}`),
        { today, todayPending });
      for (const ds of dates) {
        rows.push({ employee: e.hr_hremployee1 || 'Employee', department: e.hr_department || '', designation: e.hr_designation || '', date: ds, status: 'absent' });
        if (rows.length >= CAP) break;
      }
      if (rows.length >= CAP) break;
    }
    // OPTIONAL: add PENDING-leave rows to the Absent view (HR toggle). These are NOT Absent —
    // they carry status 'leave_pending' so the UI labels them distinctly. Same scope + date range;
    // only pending-leave working dates with NO attendance record (a punched day shows its record).
    if (includePending && rows.length < CAP) {
      for (const e of scope) {
        for (const ds of workDates) {
          const key = `${e.hr_hremployeeid}|${ds}`;
          if (!pendingLeaveType.has(key) || active.has(key)) continue;   // pending + no record only
          rows.push({ employee: e.hr_hremployee1 || 'Employee', department: e.hr_department || '', designation: e.hr_designation || '', date: ds, status: 'leave_pending', leaveType: pendingLeaveType.get(key) || '' });
          if (rows.length >= CAP) break;
        }
        if (rows.length >= CAP) break;
      }
    }
    rows.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : a.employee.localeCompare(b.employee)));
    res.json({ data: rows, count: rows.length });
  } catch (err) { next(err); }
});

// GET /api/attendance/export — .xlsx with FOUR sheets:
//   1) Employee Attendance Summary — per-employee summary (original code, restored)
//   2) Daily Attendance            — daily rows (original code, restored)
//   3) Monthly Attendance Report — one row/employee, ATTENDANCE ONLY (no monetary
//      values): Employee ID | Employee Name | Calendar Days | Working Days | Present
//      Days | Approved Leave Days | Absent Days | Half Days | Incomplete Days | In
//      Progress Days | Salary Working Days | Effective Hours | LOP Hours | Shortage
//      Hours | OT Hours. CRMONCE ADMIN and UmaMahesh are excluded from sheets 3 & 4.
//   4) Attendance & LOP Reconciliation — like sheet 3 but a stricter LOP model: adds a
//      Pending Leave Days column and a Required Hours column, treats PENDING leave as LOP
//      (approved leave stays paid), and derives Salary Working Days = Working − LOP/req
//      (not hardcoded to Working). Sheet 3 is left unchanged.
// Reuses buildRangeSummary (no change to attendance/leave calculation).
router.get('/export', requireAnyPermission('attendance.view'), async (req, res, next) => {
  try {
    const { employeeId, status, department, designation, source, view } = req.query;
    const targetId = req.user.role === 'employee' ? req.user.id : employeeId;

    // Date range (defaults to the current calendar month).
    const now = new Date();
    const from = req.query.from || `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-01`;
    const to = req.query.to || `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate())}`;

    const { rc, computed, perEmployee } = await buildRangeSummary(from, to, { targetId, department, designation });

    const wb = new ExcelJS.Workbook();

    // ── Sheet 1 (default): Employee Attendance Summary ── (restored, original code)
    const sum = wb.addWorksheet('Employee Attendance Summary');
    sum.columns = [
      { header: 'Employee', key: 'emp', width: 22 }, { header: 'Department', key: 'dept', width: 16 },
      { header: 'Designation', key: 'desig', width: 18 }, { header: 'Total Calendar Days', key: 'cal', width: 17 },
      { header: 'Working Days', key: 'wd', width: 12 }, { header: 'Present', key: 'present', width: 9 },
      { header: 'Half Day', key: 'half', width: 9 }, { header: 'Absent', key: 'absent', width: 9 },
      { header: 'Approved Leave', key: 'leave', width: 14 }, { header: 'Office Holidays', key: 'hol', width: 14 },
      { header: 'Weekly Off', key: 'woff', width: 11 }, { header: 'Incomplete Days', key: 'incomplete', width: 13 },
      { header: 'Missing Punch Details', key: 'missing', width: 34 },
      { header: 'Total Effective Hours', key: 'eff', width: 18 }, { header: 'Total Break Hours', key: 'brk', width: 16 },
      { header: 'Total Overtime', key: 'ot', width: 14 },
    ];
    sum.getRow(1).font = { bold: true };
    sum.getColumn('missing').alignment = { wrapText: true, vertical: 'top' };
    for (const { emp: e, approvedDays, working, summary: s } of perEmployee) {
      sum.addRow({
        emp: e.hr_hremployee1 || 'Employee', dept: e.hr_department || '', desig: e.hr_designation || '',
        cal: rc.calendar, wd: working, present: s.present, half: s.half, absent: s.absent,
        leave: approvedDays, hol: rc.holidays, woff: rc.weeklyOff, incomplete: s.incomplete,
        missing: s.missingPunchDetails.length ? s.missingPunchDetails.join('\n') : 'None',
        eff: fmtDur(s.effectiveHours), brk: fmtDur(s.breakHours), ot: fmtDur(s.overtimeHours),
      });
    }

    // ── Sheet 2: Daily Attendance (filtered by status / source / view / dept / desig) ── (restored, original code)
    const matchView = (c) => {
      switch (view) {
        case 'present': return c.status === 'present';
        case 'absent': return c.status === 'absent';
        case 'half': return c.status === 'half_day';
        case 'incomplete': return c.status === 'incomplete';
        case 'late': return c.lateArrivalMin > 0;
        case 'early': return c.earlyDepartureMin > 0;
        case 'overtime': return c.overtimeHours > 0;
        case 'less': return c.effectiveHours < c.requiredHours;
        case 'more': return c.effectiveHours > c.requiredHours;
        case 'working': return c.count > 0 && c.effectiveHours > 0;
        default: return true;
      }
    };
    const detail = wb.addWorksheet('Daily Attendance');
    detail.columns = [
      { header: 'Employee', key: 'emp', width: 22 }, { header: 'Department', key: 'dept', width: 16 },
      { header: 'Designation', key: 'desig', width: 18 }, { header: 'Date', key: 'date', width: 12 },
      { header: 'First Punch', key: 'first', width: 11 }, { header: 'Last Punch', key: 'last', width: 11 },
      { header: 'Punch Count', key: 'pc', width: 11 }, { header: 'Effective Hours', key: 'eff', width: 14 },
      { header: 'Break', key: 'brk', width: 10 }, { header: 'Late', key: 'late', width: 10 },
      { header: 'Early Exit', key: 'early', width: 11 }, { header: 'Overtime', key: 'ot', width: 11 },
      { header: 'Status', key: 'status', width: 12 }, { header: 'Attendance Issue', key: 'issue', width: 16 },
      { header: 'Source', key: 'source', width: 12 }, { header: 'Remarks', key: 'remarks', width: 20 },
    ];
    detail.getRow(1).font = { bold: true };
    for (const { r, c, emp } of computed) {
      if (department && emp.hr_department !== department) continue;
      if (designation && emp.hr_designation !== designation) continue;
      if (status && c.status !== status) continue;
      if (source && r.hr_source !== toValue('hr_attendance_source', source)) continue;
      if (!matchView(c)) continue;
      detail.addRow({
        emp: emp.hr_hremployee1 || r['_hr_hremployee_value@OData.Community.Display.V1.FormattedValue'] || 'Employee',
        dept: emp.hr_department || '', desig: emp.hr_designation || '',
        date: String(r.hr_date || '').slice(0, 10),
        first: c.firstPunch || '', last: c.lastPunch || '', pc: c.count,
        eff: fmtDur(c.effectiveHours), brk: fmtDur(c.breakHours),
        late: fmtMin(c.lateArrivalMin), early: fmtMin(c.earlyDepartureMin), ot: fmtDur(c.overtimeHours),
        status: c.status,
        issue: r.hr_source === toValue('hr_attendance_source', 'manual_correction') ? 'Manual Correction' : (c.attendanceIssue || 'Normal'),
        source: toLabel('hr_attendance_source', r.hr_source), remarks: '',
      });
    }

    // ── Sheet 3: Monthly Attendance Report ───────────────────────────────────
    // A professional employee-wise ATTENDANCE report — NO monetary values (gross/net/
    // PT/deductions live in the Payroll Register). Day/hour counts come from
    // buildRangeSummary (the same source as the /stats cards and the Monthly Attendance
    // UI). Shortage Hours come from buildMonthlyBalance — the authoritative monthly
    // hour-balance the payroll engine itself uses — computed from attendance alone, so
    // it populates whether or not payroll has been generated for the month. No payroll
    // math and no salary figures are recreated here.
    //
    // Month-scoped: buildRangeSummary already ran for [from, to], so every row belongs
    // to the selected month only.
    const repYear = Number(String(from).slice(0, 4));
    const repMonth = Number(String(from).slice(5, 7));
    const fullDayHours = companyPolicy.attendance.fullDayExpectedHours();   // 9
    const monthLabel = new Date(Date.UTC(repYear, repMonth - 1, 1))
      .toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });

    // Excluded admin/test accounts (never in the monthly summary).
    const norm = (n) => String(n || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const EXCLUDE = ['crmonceadmin', 'umamahesh'];
    const isExcluded = (e) => EXCLUDE.some(x => norm(e.hr_hremployee1).includes(x));

    const summaryRows = perEmployee
      .filter(p => !isExcluded(p.emp))
      .sort((a, b) => (a.emp.hr_hremployee1 || '').localeCompare(b.emp.hr_hremployee1 || ''));

    // Shortage Hours = attended-day working-hour shortfall, from the authoritative
    // monthly hour-balance (same service payroll generation uses). Computed for every
    // in-scope employee (bounded concurrency) so the column is correct for the month
    // even before payroll is generated. Absent-day LOP flows through LOP Hours instead.
    const shortageByEmp = new Map();
    await mapWithConcurrency(summaryRows, 6, async ({ emp }) => {
      try {
        const bal = await monthlyBalance.buildMonthlyBalance({ employeeId: emp.hr_hremployeeid, year: repYear, month: repMonth });
        shortageByEmp.set(emp.hr_hremployeeid, Number(bal.shortageHours) || 0);
      } catch { shortageByEmp.set(emp.hr_hremployeeid, 0); }   // degrade to 0, never block the export
    });

    const ws = wb.addWorksheet('Monthly Attendance Report');
    ws.columns = [
      { header: 'Employee ID', key: 'id', width: 14 },
      { header: 'Employee Name', key: 'name', width: 26 },
      { header: 'Calendar Days', key: 'cal', width: 13 },
      { header: 'Working Days', key: 'wd', width: 12 },
      { header: 'Present Days', key: 'present', width: 12 },
      { header: 'Approved Leave Days', key: 'leave', width: 18 },
      { header: 'Absent Days', key: 'absent', width: 11 },
      { header: 'Half Days', key: 'half', width: 10 },
      { header: 'Incomplete Days', key: 'incomplete', width: 15 },
      { header: 'In Progress Days', key: 'inprogress', width: 15 },
      { header: 'Salary Working Days', key: 'salary', width: 18 },
      { header: 'Effective Hours', key: 'eff', width: 14 },
      { header: 'LOP Hours', key: 'lophrs', width: 11 },
      { header: 'Shortage Hours', key: 'shorthrs', width: 14 },
      { header: 'OT Hours', key: 'othrs', width: 10 },
    ];
    for (const { emp: e, approvedLeaveDays, summary: s } of summaryRows) {
      const row = buildAttendanceRow({
        employeeId: e.hr_etimecode || e.hr_hremployeeid || '',
        employeeName: e.hr_hremployee1 || 'Employee',
        rc, summary: s, approvedLeaveDays,
        shortageHours: shortageByEmp.get(e.hr_hremployeeid) || 0,
        fullDayHours,
      });
      ws.addRow({
        id: row.employeeId, name: row.employeeName,
        cal: row.calendarDays, wd: row.workingDays, present: row.presentDays,
        leave: row.approvedLeaveDays, absent: row.absentDays, half: row.halfDays,
        incomplete: row.incompleteDays, inprogress: row.inProgressDays, salary: row.salaryWorkingDays,
        eff: fmtDur(row.effectiveHours), lophrs: fmtDur(row.lopHours),
        shorthrs: fmtDur(row.shortageHours), othrs: fmtDur(row.otHours),
      });
    }

    // Centered numeric day/hour columns (no monetary columns on this sheet).
    ['cal', 'wd', 'present', 'leave', 'absent', 'half', 'incomplete', 'inprogress', 'salary', 'eff', 'lophrs', 'shorthrs', 'othrs'].forEach(k => { ws.getColumn(k).alignment = { horizontal: 'center' }; });

    // Title banner (row 1) identifying the month, headers on row 2.
    const lastCol = ws.columnCount;
    ws.spliceRows(1, 0, [`Monthly Attendance Report — ${monthLabel}`]);
    ws.mergeCells(1, 1, 1, lastCol);
    const titleCell = ws.getCell(1, 1);
    titleCell.font = { bold: true, size: 13, color: { argb: 'FF1F4E79' } };
    titleCell.alignment = { horizontal: 'left', vertical: 'middle' };
    ws.getRow(1).height = 22;
    ws.getRow(2).eachCell((cell) => {
      cell.font = { bold: true };
      cell.alignment = { ...(cell.alignment || {}), horizontal: 'center', vertical: 'middle', wrapText: true };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD9E8FB' } };
    });
    ws.getRow(2).height = 30;
    ws.views = [{ state: 'frozen', ySplit: 2 }];                      // freeze title + header
    ws.autoFilter = { from: { row: 2, column: 1 }, to: { row: 2, column: lastCol } };

    // ── Sheet 4: Attendance & LOP Reconciliation ─────────────────────────────
    // A stricter LOP view (Sheet 3 is untouched). Attendance counts come from the same
    // authoritative buildRangeSummary. The difference from Sheet 3 is the LOP model:
    //   • APPROVED leave — paid, salary-protected: 0 LOP, keeps full Salary-Working-Day credit.
    //   • PENDING leave  — NOT paid: EVERY pending-leave working day in the month with no
    //     punch (TODAY INCLUDED) contributes its required hours to LOP, until it is approved.
    //   • GENUINE ABSENT — no punch, no approved/pending leave: contributes required hours to LOP.
    //   • SHORTAGE       — attended-day working-hour shortfall (buildMonthlyBalance): contributes to LOP.
    // LOP Hours = absent×req + pending×req + shortage (disjoint → no double count). Salary
    // Working Days = Working − LOP Hours / required (paid-day basis, never hardcoded to Working).
    // Pending leave is unpaid → LOP for EVERY pending-leave working day in the selected
    // month (TODAY INCLUDED — a pending request stays LOP until it is approved), UNLESS an
    // attendance record exists on that date (punch precedence: a present/incomplete/
    // in-progress record wins, so the day is never double-counted and an in-progress day
    // itself creates no pending-LOP). leaveMap is already bounded to [from, to] and to
    // working days by expandLeaveDays (approved wins over pending per date).
    const pendingLopDays = (p) => pendingLopDayCount(p.leaveMap, (d) => p.recordSet.has(d));

    const ws4 = wb.addWorksheet('Attendance & LOP Reconciliation');
    ws4.columns = [
      { header: 'Employee ID', key: 'id', width: 14 },
      { header: 'Employee Name', key: 'name', width: 26 },
      { header: 'Calendar Days', key: 'cal', width: 13 },
      { header: 'Working Days', key: 'wd', width: 12 },
      { header: 'Present Days', key: 'present', width: 12 },
      { header: 'Approved Leave Days', key: 'aleave', width: 18 },
      { header: 'Pending Leave Days', key: 'pleave', width: 18 },
      { header: 'Absent Days', key: 'absent', width: 11 },
      { header: 'Half Days', key: 'half', width: 10 },
      { header: 'Incomplete Days', key: 'incomplete', width: 15 },
      { header: 'In Progress Days', key: 'inprogress', width: 15 },
      { header: 'Salary Working Days', key: 'salary', width: 18 },
      { header: 'Effective Hours', key: 'eff', width: 14 },
      { header: 'Required Hours', key: 'req', width: 13 },
      { header: 'Shortage Hours', key: 'shorthrs', width: 14 },
      { header: 'LOP Hours', key: 'lophrs', width: 11 },
      { header: 'OT Hours', key: 'othrs', width: 10 },
    ];
    for (const p of summaryRows) {
      const e = p.emp;
      const row = buildLopReconRow({
        employeeId: e.hr_etimecode || e.hr_hremployeeid || '',
        employeeName: e.hr_hremployee1 || 'Employee',
        rc, summary: p.summary,
        approvedLeaveDays: p.approvedLeaveDays,
        pendingLeaveDays: pendingLopDays(p),
        shortageHours: shortageByEmp.get(e.hr_hremployeeid) || 0,
        fullDayHours,
      });
      ws4.addRow({
        id: row.employeeId, name: row.employeeName,
        cal: row.calendarDays, wd: row.workingDays, present: row.presentDays,
        aleave: row.approvedLeaveDays, pleave: row.pendingLeaveDays, absent: row.absentDays,
        half: row.halfDays, incomplete: row.incompleteDays, inprogress: row.inProgressDays,
        salary: row.salaryWorkingDays, eff: fmtDur(row.effectiveHours), req: fmtDur(row.requiredHours),
        shorthrs: fmtDur(row.shortageHours), lophrs: fmtDur(row.lopHours), othrs: fmtDur(row.otHours),
      });
    }
    ['cal', 'wd', 'present', 'aleave', 'pleave', 'absent', 'half', 'incomplete', 'inprogress', 'salary', 'eff', 'req', 'shorthrs', 'lophrs', 'othrs'].forEach(k => { ws4.getColumn(k).alignment = { horizontal: 'center' }; });
    const lastCol4 = ws4.columnCount;
    ws4.spliceRows(1, 0, [`Attendance & LOP Reconciliation — ${monthLabel}`]);
    ws4.mergeCells(1, 1, 1, lastCol4);
    ws4.getCell(1, 1).font = { bold: true, size: 13, color: { argb: 'FF1F4E79' } };
    ws4.getCell(1, 1).alignment = { horizontal: 'left', vertical: 'middle' };
    ws4.getRow(1).height = 22;
    ws4.getRow(2).eachCell((cell) => {
      cell.font = { bold: true };
      cell.alignment = { ...(cell.alignment || {}), horizontal: 'center', vertical: 'middle', wrapText: true };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFCE4D6' } };
    });
    ws4.getRow(2).height = 30;
    ws4.views = [{ state: 'frozen', ySplit: 2 }];
    ws4.autoFilter = { from: { row: 2, column: 1 }, to: { row: 2, column: lastCol4 } };

    wb.views = [{ activeTab: 0 }];   // open on Employee Attendance Summary
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename=Attendance_${from}_to_${to}.xlsx`);
    await wb.xlsx.write(res);
    res.end();
  } catch (err) { next(err); }
});

// PATCH /api/attendance/:id — manual correction
router.patch('/:id', requireAnyPermission('attendance.edit'), async (req, res, next) => {
  try {
    const record = await d365.update(ENTITY, req.params.id, {
      ...req.body,
      hr_source: toValue('hr_attendance_source', 'manual_correction'),
    });
    res.json(labelsForEntity('hr_hrattendances', record));
  } catch (err) { next(err); }
});

module.exports = router;
