const express = require('express');
const router = express.Router();
const d365 = require('../../services/d365.service');
const etimeService = require('../../services/etime.service');
const { requireRole, requirePermission } = require('../../middleware/auth.middleware');
const { toValue, toLabel, labelsForList, labelsForEntity } = require('../../services/picklist');
const ExcelJS = require('exceljs');
const { computeFromPunches, computeSession, punchesFromRecord } = require('../../services/attendance.util');
const attnCfg = require('../../services/attendance.config');
const leaveRoutes = require('./leave.routes');
const activity = require('../../services/activity.service');
const time = require('../../services/time.util');

router.use('/leave', leaveRoutes);

const ENTITY = d365.constructor.entities.attendance;

// GET /api/attendance
router.get('/', requirePermission('attendance:read'), async (req, res, next) => {
  try {
    const { employeeId, from, to, status, source, page = 1, limit = 30 } = req.query;
    const filters = [];

    // Employees can only see their own attendance
    const targetId = req.user.role === 'employee' ? req.user.id : employeeId;
    if (targetId) filters.push(`_hr_hremployee_value eq '${targetId}'`);
    if (from) filters.push(`hr_date ge ${from}`);
    if (to) filters.push(`hr_date le ${to}`);
    if (status) filters.push(`hr_status eq ${toValue('hr_attendance_status', status)}`);
    if (source) filters.push(`hr_source eq ${toValue('hr_attendance_source', source)}`);

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
    hr_status: toValue('hr_attendance_status', c.status),
  };
}

// Per-employee shift: the employee's assigned Shift Name + Start Time drive all
// Late / Early Exit / Overtime math. resolveShift() is the legacy fallback only.
const EMP_ENTITY = d365.constructor.entities.employee;
const resolveShift = () => attnCfg.resolveShift();
const shiftOf = (emp) => attnCfg.resolveEmployeeShift(emp?.hr_shift, emp?.hr_shiftstart);
async function getEmployeeShift(employeeId) {
  try {
    // Optional columns: degrade to defaults if hr_shift/hr_shiftstart don't exist.
    const e = await d365.getByIdOptional(EMP_ENTITY, employeeId, { select: 'hr_hremployeeid', optionalSelect: 'hr_shift,hr_shiftstart' });
    return shiftOf(e);
  } catch (_) { return resolveShift(); }
}
/** employeeId → resolved shift, for multi-employee reports (overview/export). */
async function buildShiftMap() {
  const map = new Map();
  try {
    const { data } = await d365.getListOptional(EMP_ENTITY, { select: 'hr_hremployeeid', optionalSelect: 'hr_shift,hr_shiftstart', top: 5000 });
    (data || []).forEach(e => map.set(e.hr_hremployeeid, shiftOf(e)));
  } catch (_) { /* fall back to default per record */ }
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
router.post('/checkin', requirePermission('attendance:read'), async (req, res, next) => {
  try {
    const employeeId = req.user.id;
    const shift = await getEmployeeShift(employeeId);
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
      const c = computeSession([{ t: nowHHMM(), d: 'in' }], shift);
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
    const c = computeSession([...punches, { t: nowHHMM(), d: 'in' }], shift);
    const updated = await d365.update(ENTITY, record.hr_hrattendanceid, punchPayload(c));
    res.json(labelsForEntity('hr_hrattendances', updated));
  } catch (err) { next(err); }
});

// POST /api/attendance/checkout — append an OUT punch (only when currently IN). Session stays open.
router.post('/checkout', requirePermission('attendance:read'), async (req, res, next) => {
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
    const shift = await getEmployeeShift(rec._hr_hremployee_value);
    const c = computeSession([...punches, { t: actualCheckout, d: 'out' }], shift);
    const updated = await d365.update(ENTITY, attendanceId, {
      ...punchPayload(c),
      hr_source: toValue('hr_attendance_source', 'manual_correction'),
    });
    global.logger?.info(`Attendance correction by ${req.user.name} on ${rec.hr_date}: checkout ${actualCheckout} — reason: ${reason || '(none)'}`);
    res.json(labelsForEntity('hr_hrattendances', updated));
  } catch (err) { next(err); }
});

// Build the full session view returned to clients (facts computed on read).
function sessionView(record, shift) {
  const c = computeSession(record ? punchesFromRecord(record) : [], shift || resolveShift());
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
    const shift = await getEmployeeShift(req.user.id);
    const { today, record } = await findTodayRecord(req.user.id);
    const openPrior = record ? null : await findOpenPriorRecord(req.user.id, today);
    res.json({
      ...sessionView(record, shift),
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
    const shift = await getEmployeeShift(targetId);
    let present = 0, halfDay = 0, lateCount = 0, earlyCount = 0, overtimeHours = 0;
    for (const r of (recs || [])) {
      const c = computeSession(punchesFromRecord(r), shift);
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
    const today = time.istDateStr();
    const { data: recs } = await d365.getList(ENTITY, {
      select: PUNCH_SELECT, filter: `hr_date eq ${today}`,
    });
    const shiftMap = await buildShiftMap();
    let inside = 0, outside = 0, incomplete = 0, late = 0, early = 0, overtime = 0;
    for (const r of (recs || [])) {
      const c = computeSession(punchesFromRecord(r), shiftMap.get(r._hr_hremployee_value) || resolveShift());
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
const { rangeCounts, summarizeEmployee } = require('../../services/attendance-summary.util');
const pad2 = (n) => String(n).padStart(2, '0');
const fmtDur = (h) => {
  const v = Number(h);
  if (!Number.isFinite(v) || v <= 0) return '0m';
  let H = Math.floor(v), M = Math.round((v - H) * 60);
  if (M === 60) { H++; M = 0; }
  return H === 0 ? `${M}m` : (M === 0 ? `${H}h` : `${H}h ${M}m`);
};
const fmtMin = (m) => fmtDur((Number(m) || 0) / 60);

// GET /api/attendance/export — .xlsx: Employee Attendance Summary (default sheet) + Daily detail
router.get('/export', requirePermission('attendance:read'), async (req, res, next) => {
  try {
    const { employeeId, status, department, designation, source, view } = req.query;
    const targetId = req.user.role === 'employee' ? req.user.id : employeeId;

    // Date range (defaults to the current calendar month).
    const now = new Date();
    const from = req.query.from || `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-01`;
    const to = req.query.to || `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate())}`;

    // Attendance in range (date + employee scope) — feeds BOTH sheets. Paginated (10k+).
    const f = [`hr_date ge ${from}`, `hr_date le ${to}`];
    if (targetId) f.push(`_hr_hremployee_value eq '${targetId}'`);
    const CAP = 10000, PAGE = 1000;
    let recs = [], skip = 0;
    while (recs.length < CAP) {
      const { data } = await d365.getList(ENTITY, { select: PUNCH_SELECT, filter: f.join(' and '), orderby: 'hr_date desc', top: PAGE, skip });
      if (!data || !data.length) break;
      recs.push(...data);
      if (data.length < PAGE) break;
      skip += PAGE;
    }

    // Active employees + approved leaves (for the summary).
    const { data: emps } = await d365.getListOptional(d365.constructor.entities.employee, {
      select: 'hr_hremployeeid,hr_hremployee1,hr_department,hr_designation',
      optionalSelect: 'hr_shift,hr_shiftstart',
      filter: `hr_status eq ${toValue('hr_employee_status', 'active')}`, top: 5000,
    });
    const empMap = new Map((emps || []).map(e => [e.hr_hremployeeid, e]));
    const { data: leaves } = await d365.getList(d365.constructor.entities.leave, {
      select: 'hr_days,hr_fromdate,_hr_hremployee_value,hr_status',
      filter: `hr_status eq ${toValue('hr_leave_status', 'approved')}`,
    });
    const leaveByEmp = {};
    (leaves || []).forEach(l => {
      const d = String(l.hr_fromdate || '').slice(0, 10);
      if (d < from || d > to) return;
      leaveByEmp[l._hr_hremployee_value] = (leaveByEmp[l._hr_hremployee_value] || 0) + (l.hr_days || 0);
    });

    const rc = rangeCounts(from, to);

    // Compute each session once with THAT employee's shift; group by employee.
    const byEmp = {};
    const computed = recs.map(r => {
      const emp = empMap.get(r._hr_hremployee_value) || {};
      const c = computeSession(punchesFromRecord(r), shiftOf(emp));
      (byEmp[r._hr_hremployee_value] = byEmp[r._hr_hremployee_value] || []).push({ ...c, date: r.hr_date });
      return { r, c, emp };
    });

    // Employees in scope for the summary.
    let scope = emps || [];
    if (targetId) scope = scope.filter(e => e.hr_hremployeeid === targetId);
    if (department) scope = scope.filter(e => e.hr_department === department);
    if (designation) scope = scope.filter(e => e.hr_designation === designation);

    const wb = new ExcelJS.Workbook();

    // ── Sheet 1 (default): Employee Attendance Summary ──
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
    for (const e of scope) {
      const leaveDays = leaveByEmp[e.hr_hremployeeid] || 0;
      const s = summarizeEmployee(byEmp[e.hr_hremployeeid] || [], { working: rc.working, leaveDays });
      sum.addRow({
        emp: e.hr_hremployee1 || 'Employee', dept: e.hr_department || '', desig: e.hr_designation || '',
        cal: rc.calendar, wd: rc.working, present: s.present, half: s.half, absent: s.absent,
        leave: leaveDays, hol: rc.holidays, woff: rc.weeklyOff, incomplete: s.incomplete,
        missing: s.missingPunchDetails.length ? s.missingPunchDetails.join('\n') : 'None',
        eff: fmtDur(s.effectiveHours), brk: fmtDur(s.breakHours), ot: fmtDur(s.overtimeHours),
      });
    }

    // ── Sheet 2: Daily Attendance (filtered by status / source / view / dept / desig) ──
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

    wb.views = [{ activeTab: 0 }]; // open on the Summary sheet by default

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename=Attendance_${from}_to_${to}.xlsx`);
    await wb.xlsx.write(res);
    res.end();
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
