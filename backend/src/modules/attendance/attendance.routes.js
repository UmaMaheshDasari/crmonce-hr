const express = require('express');
const router = express.Router();
const d365 = require('../../services/d365.service');
const etimeService = require('../../services/etime.service');
const { requireRole, requirePermission } = require('../../middleware/auth.middleware');
const { toValue, labelsForList, labelsForEntity } = require('../../services/picklist');
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

// POST /api/attendance/checkin — Employee web check-in
router.post('/checkin', requirePermission('attendance:read'), async (req, res, next) => {
  try {
    const employeeId = req.user.id;
    const today = new Date().toISOString().split('T')[0];

    // Check if attendance record already exists for today
    const existing = await d365.getList(ENTITY, {
      select: 'hr_hrattendanceid,hr_date,hr_intime,hr_outtime,hr_workedhours,hr_overtime,hr_status,hr_source,_hr_hremployee_value,hr_allpunches,hr_punchcount,hr_breakduration,hr_effectivehours',
      filter: `_hr_hremployee_value eq '${employeeId}' and hr_date eq ${today}`,
      top: 1,
    });

    if (existing.data && existing.data.length > 0 && existing.data[0].hr_intime) {
      return res.status(400).json({ error: 'Already checked in today' });
    }

    const now = new Date();
    const currentTime = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

    const record = await d365.create(ENTITY, {
      'hr_hremployee@odata.bind': `/hr_hremployees(${employeeId})`,
      hr_date: today,
      hr_intime: currentTime,
      hr_source: toValue('hr_attendance_source', 'web_checkin'),
      hr_status: toValue('hr_attendance_status', 'incomplete'),
    });

    res.json(labelsForEntity('hr_hrattendances', record));
  } catch (err) { next(err); }
});

// POST /api/attendance/checkout — Employee web check-out
router.post('/checkout', requirePermission('attendance:read'), async (req, res, next) => {
  try {
    const employeeId = req.user.id;
    const today = new Date().toISOString().split('T')[0];

    const existing = await d365.getList(ENTITY, {
      select: 'hr_hrattendanceid,hr_date,hr_intime,hr_outtime,hr_workedhours,hr_overtime,hr_status,hr_source,_hr_hremployee_value,hr_allpunches,hr_punchcount,hr_breakduration,hr_effectivehours',
      filter: `_hr_hremployee_value eq '${employeeId}' and hr_date eq ${today}`,
      top: 1,
    });

    if (!existing.data || existing.data.length === 0) {
      return res.status(400).json({ error: "You haven't checked in today" });
    }

    const record = existing.data[0];
    if (record.hr_outtime) {
      return res.status(400).json({ error: 'Already checked out today' });
    }

    const now = new Date();
    const currentTime = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

    // Calculate worked hours from hr_intime to now
    const [inH, inM] = record.hr_intime.split(':').map(Number);
    const workedMinutes = (now.getHours() * 60 + now.getMinutes()) - (inH * 60 + inM);
    const workedHours = Math.max(0, parseFloat((workedMinutes / 60).toFixed(2)));
    const overtime = Math.max(0, parseFloat((workedHours - 8).toFixed(2)));

    const statusLabel = workedHours < 4 ? 'half_day' : 'present';

    const updated = await d365.update(ENTITY, record.hr_hrattendanceid, {
      hr_outtime: currentTime,
      hr_workedhours: workedHours,
      hr_overtime: overtime,
      hr_status: toValue('hr_attendance_status', statusLabel),
    });

    res.json(labelsForEntity('hr_hrattendances', updated));
  } catch (err) { next(err); }
});

// GET /api/attendance/my-status — Today's attendance status for logged-in employee
router.get('/my-status', requirePermission('attendance:read'), async (req, res, next) => {
  try {
    const employeeId = req.user.id;
    const today = new Date().toISOString().split('T')[0];

    const existing = await d365.getList(ENTITY, {
      select: 'hr_hrattendanceid,hr_date,hr_intime,hr_outtime,hr_workedhours,hr_overtime,hr_status,hr_source,_hr_hremployee_value,hr_allpunches,hr_punchcount,hr_breakduration,hr_effectivehours',
      filter: `_hr_hremployee_value eq '${employeeId}' and hr_date eq ${today}`,
      top: 1,
    });

    const record = existing.data && existing.data.length > 0 ? existing.data[0] : null;

    res.json({
      checkedIn: !!(record && record.hr_intime),
      checkedOut: !!(record && record.hr_outtime),
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
