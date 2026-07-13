const express = require('express');
const router = express.Router();
const d365 = require('../../services/d365.service');
const etimeService = require('../../services/etime.service');
const { requireRole, requirePermission } = require('../../middleware/auth.middleware');
const { toValue, labelsForList, labelsForEntity } = require('../../services/picklist');
const { computeFromPunches, computeSession, punchesFromRecord } = require('../../services/attendance.util');
const attnCfg = require('../../services/attendance.config');
const leaveRoutes = require('./leave.routes');

router.use('/leave', leaveRoutes);

const ENTITY = d365.constructor.entities.attendance;

// GET /api/attendance
router.get('/', requirePermission('attendance:read'), async (req, res, next) => {
  try {
    const { employeeId, from, to, status, page = 1, limit = 30 } = req.query;
    const filters = [];

    // Employees can only see their own attendance
    const targetId = req.user.role === 'employee' ? req.user.id : employeeId;
    if (targetId) filters.push(`_hr_hremployee_value eq '${targetId}'`);
    if (from) filters.push(`hr_date ge ${from}`);
    if (to) filters.push(`hr_date le ${to}`);
    if (status) filters.push(`hr_status eq ${toValue('hr_attendance_status', status)}`);

    const result = await d365.getList(ENTITY, {
      select: 'hr_hrattendanceid,hr_date,hr_intime,hr_outtime,hr_workedhours,hr_overtime,hr_status,hr_source,_hr_hremployee_value,hr_allpunches,hr_punchcount,hr_breakduration,hr_effectivehours',
      filter: filters.join(' and ') || undefined,
      orderby: 'hr_date desc',
      top: limit,
      skip: (page - 1) * limit,
    });
    res.json(labelsForList('hr_hrattendances', result));
  } catch (err) { next(err); }
});

// GET /api/attendance/summary
router.get('/summary', requirePermission('attendance:read'), async (req, res, next) => {
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
router.post('/sync', requireRole('super_admin', 'hr_manager'), async (req, res, next) => {
  try {
    const { from, to } = req.body;
    const fromDate = from || new Date(Date.now() - 86400000).toISOString().split('T')[0];
    const toDate = to || new Date().toISOString().split('T')[0];
    const result = await etimeService.syncAttendance(fromDate, toDate);
    res.json({ message: 'Sync complete', ...result });
  } catch (err) { next(err); }
});

// POST /api/attendance/device/request-logs — request device to push new logs
router.post('/device/request-logs', requireRole('super_admin', 'hr_manager'), async (req, res, next) => {
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
router.get('/device/info', requireRole('super_admin', 'hr_manager'), async (req, res, next) => {
  try {
    const info = await etimeService.getDeviceInfo();
    res.json({ device: `ZKTeco Z900 @ ${etimeService.ip}`, ...info });
  } catch (err) { next(err); }
});

// GET /api/attendance/device/users — list users registered on ZK device
router.get('/device/users', requireRole('super_admin', 'hr_manager'), async (req, res, next) => {
  try {
    const users = await etimeService.fetchDeviceUsers();
    res.json({ count: users.length, data: users });
  } catch (err) { next(err); }
});

// GET /api/attendance/device/logs — raw attendance logs from ZK device
router.get('/device/logs', requireRole('super_admin', 'hr_manager'), async (req, res, next) => {
  try {
    const logs = await etimeService.fetchAttendanceLogs();
    res.json({ count: logs.length, data: logs });
  } catch (err) { next(err); }
});

// ── Web punch session (multi-punch: IN/OUT/IN/OUT…, never locks) ──────────────
const PUNCH_SELECT = 'hr_hrattendanceid,hr_date,hr_intime,hr_outtime,hr_workedhours,hr_overtime,hr_status,hr_source,_hr_hremployee_value,hr_allpunches,hr_punchcount,hr_breakduration,hr_effectivehours';
const nowHHMM = () => { const n = new Date(); return `${String(n.getHours()).padStart(2, '0')}:${String(n.getMinutes()).padStart(2, '0')}`; };

async function findTodayRecord(employeeId) {
  const today = new Date().toISOString().split('T')[0];
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
    hr_status: toValue('hr_attendance_status', c.status),
  };
}

// Per-employee shift (optional hr_shift; default until that column exists).
const resolveShift = () => attnCfg.resolveShift();

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
router.post('/checkin', requirePermission('attendance:read'), async (req, res, next) => {
  try {
    const employeeId = req.user.id;
    const { today, record } = await findTodayRecord(employeeId);

    // Forgot-checkout: never silently start a new session over an open prior day.
    const openPrior = await findOpenPriorRecord(employeeId, today);
    if (openPrior && !record) {
      return res.status(409).json({
        error: 'Previous attendance is incomplete',
        code: 'FORGOT_CHECKOUT',
        incompletePrevious: labelsForEntity('hr_hrattendances', openPrior),
      });
    }

    if (!record) {
      const c = computeSession([{ t: nowHHMM(), d: 'in' }], resolveShift());
      const created = await d365.create(ENTITY, {
        'hr_hremployee@odata.bind': `/hr_hremployees(${employeeId})`,
        hr_date: today,
        hr_source: toValue('hr_attendance_source', 'web_checkin'),
        ...punchPayload(c),
      });
      return res.json(labelsForEntity('hr_hrattendances', created));
    }

    const punches = punchesFromRecord(record);
    if (punches.length % 2 === 1) {
      return res.status(400).json({ error: 'You are already checked in — check out first' });
    }
    const c = computeSession([...punches, { t: nowHHMM(), d: 'in' }], resolveShift());
    const updated = await d365.update(ENTITY, record.hr_hrattendanceid, punchPayload(c));
    res.json(labelsForEntity('hr_hrattendances', updated));
  } catch (err) { next(err); }
});

// POST /api/attendance/checkout — append an OUT punch (only when currently IN). Session stays open.
router.post('/checkout', requirePermission('attendance:read'), async (req, res, next) => {
  try {
    const employeeId = req.user.id;
    const { record } = await findTodayRecord(employeeId);
    if (!record) return res.status(400).json({ error: "You haven't checked in today" });

    const punches = punchesFromRecord(record);
    if (punches.length % 2 === 0) {
      return res.status(400).json({ error: 'You are not currently checked in' });
    }
    const c = computeSession([...punches, { t: nowHHMM(), d: 'out' }], resolveShift());
    const updated = await d365.update(ENTITY, record.hr_hrattendanceid, punchPayload(c));
    res.json(labelsForEntity('hr_hrattendances', updated));
  } catch (err) { next(err); }
});

// POST /api/attendance/correction — resolve a forgot-checkout (actual checkout + reason)
router.post('/correction', requirePermission('attendance:read'), async (req, res, next) => {
  try {
    const { attendanceId, actualCheckout, reason } = req.body;
    if (!attendanceId || !actualCheckout) {
      return res.status(400).json({ error: 'attendanceId and actualCheckout are required' });
    }
    const rec = await d365.getById(ENTITY, attendanceId, { select: PUNCH_SELECT });
    const isHR = ['super_admin', 'hr_manager'].includes(req.user.role);
    if (rec._hr_hremployee_value !== req.user.id && !isHR) {
      return res.status(403).json({ error: 'Not your attendance record' });
    }
    const punches = punchesFromRecord(rec);
    if (punches.length % 2 === 0) {
      return res.status(400).json({ error: 'This attendance is already complete' });
    }
    const c = computeSession([...punches, { t: actualCheckout, d: 'out' }], resolveShift());
    const updated = await d365.update(ENTITY, attendanceId, {
      ...punchPayload(c),
      hr_source: toValue('hr_attendance_source', 'manual_correction'),
    });
    global.logger?.info(`Attendance correction by ${req.user.name} on ${rec.hr_date}: checkout ${actualCheckout} — reason: ${reason || '(none)'}`);
    res.json(labelsForEntity('hr_hrattendances', updated));
  } catch (err) { next(err); }
});

// Build the full session view returned to clients (facts computed on read).
function sessionView(record) {
  const c = computeSession(record ? punchesFromRecord(record) : [], resolveShift());
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
router.get('/my-status', requirePermission('attendance:read'), async (req, res, next) => {
  try {
    const { today, record } = await findTodayRecord(req.user.id);
    const openPrior = record ? null : await findOpenPriorRecord(req.user.id, today);
    res.json({
      ...sessionView(record),
      incompletePrevious: openPrior ? labelsForEntity('hr_hrattendances', openPrior) : null,
      record: record ? labelsForEntity('hr_hrattendances', record) : null,
    });
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
router.get('/summary/monthly', requirePermission('attendance:read'), async (req, res, next) => {
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
    let present = 0, halfDay = 0, lateCount = 0, earlyCount = 0, overtimeHours = 0;
    for (const r of (recs || [])) {
      const c = computeSession(punchesFromRecord(r), resolveShift());
      if (c.status === 'present') present++;
      else if (c.status === 'half_day') halfDay++;
      if (c.lateArrivalMin > 0) lateCount++;
      if (c.earlyDepartureMin > 0) earlyCount++;
      overtimeHours += c.overtimeHours;
    }

    const { data: leaves } = await d365.getList(d365.constructor.entities.leave, {
      select: 'hr_days,hr_fromdate,hr_status',
      filter: `_hr_hremployee_value eq '${targetId}' and hr_status eq ${toValue('hr_leave_status', 'approved')}`,
    });
    const leaveDays = (leaves || [])
      .filter(l => String(l.hr_fromdate || '').slice(0, 7) === `${y}-${mm}`)
      .reduce((s, l) => s + (l.hr_days || 0), 0);

    const workingDays = countWorkingDays(y, m);
    const absentDays = Math.max(0, workingDays - present - halfDay - leaveDays);

    res.json({
      month: m, year: y, workingDays,
      presentDays: present, halfDays: halfDay, leaveDays, absentDays,
      lateCount, earlyExitCount: earlyCount,
      overtimeHours: Math.round(overtimeHours * 100) / 100,
    });
  } catch (err) { next(err); }
});

// GET /api/attendance/hr/overview — HR dashboard (today), computed on read
router.get('/hr/overview', requireRole('super_admin', 'hr_manager'), async (req, res, next) => {
  try {
    const today = new Date().toISOString().split('T')[0];
    const { data: recs } = await d365.getList(ENTITY, {
      select: PUNCH_SELECT, filter: `hr_date eq ${today}`,
    });
    let inside = 0, outside = 0, incomplete = 0, late = 0, early = 0, overtime = 0;
    for (const r of (recs || [])) {
      const c = computeSession(punchesFromRecord(r), resolveShift());
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

// PATCH /api/attendance/:id — manual correction
router.patch('/:id', requireRole('super_admin', 'hr_manager'), async (req, res, next) => {
  try {
    const record = await d365.update(ENTITY, req.params.id, {
      ...req.body,
      hr_source: toValue('hr_attendance_source', 'manual_correction'),
    });
    res.json(labelsForEntity('hr_hrattendances', record));
  } catch (err) { next(err); }
});

module.exports = router;
