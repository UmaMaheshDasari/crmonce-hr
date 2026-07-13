const express = require('express');
const router = express.Router();
const d365 = require('../../services/d365.service');
const etimeService = require('../../services/etime.service');
const { requireRole, requirePermission } = require('../../middleware/auth.middleware');
const { toValue, labelsForList, labelsForEntity } = require('../../services/picklist');
const { computeFromPunches, punchesFromRecord } = require('../../services/attendance.util');
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

// Map computed session → the D365 fields (shared by check-in / check-out).
function punchPayload(c) {
  return {
    hr_intime: c.firstPunch || '',
    hr_outtime: c.state === 'out' ? c.lastPunch : '',   // "final" out only while currently OUT
    hr_workedhours: c.workedHours,
    hr_overtime: c.overtime,
    hr_breakduration: c.breakDuration,
    hr_effectivehours: c.effectiveHours,
    hr_punchcount: c.count,
    hr_allpunches: JSON.stringify(c.punches),
    hr_status: toValue('hr_attendance_status', c.status),
  };
}

// POST /api/attendance/checkin — append an IN punch (allowed only when currently OUT/none)
router.post('/checkin', requirePermission('attendance:read'), async (req, res, next) => {
  try {
    const employeeId = req.user.id;
    const { today, record } = await findTodayRecord(employeeId);

    if (!record) {
      const c = computeFromPunches([nowHHMM()]);
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
    const c = computeFromPunches([...punches, nowHHMM()]);
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
    const c = computeFromPunches([...punches, nowHHMM()]);
    const updated = await d365.update(ENTITY, record.hr_hrattendanceid, punchPayload(c));
    res.json(labelsForEntity('hr_hrattendances', updated));
  } catch (err) { next(err); }
});

// GET /api/attendance/my-status — session state so the UI always offers the right next action
router.get('/my-status', requirePermission('attendance:read'), async (req, res, next) => {
  try {
    const { record } = await findTodayRecord(req.user.id);
    const c = computeFromPunches(record ? punchesFromRecord(record) : []);
    res.json({
      state: c.state,                 // 'none' | 'in' | 'out'
      canCheckIn: c.state !== 'in',   // after any OUT you can check in again
      canCheckOut: c.state === 'in',
      punchCount: c.count,
      punches: c.punches,
      workedHours: c.workedHours,
      breakDuration: c.breakDuration,
      effectiveHours: c.effectiveHours,
      // backward-compatible flags (kept so nothing else breaks)
      checkedIn: c.state === 'in',
      checkedOut: c.state === 'out',
      record: record ? labelsForEntity('hr_hrattendances', record) : null,
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
