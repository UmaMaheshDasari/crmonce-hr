const ZKLib = require('zklib-js');
const d365 = require('./d365.service');
const { toValue } = require('./picklist');

class ZKDeviceService {
  constructor() {
    this.ip = process.env.ZK_DEVICE_IP || '192.168.1.199';
    this.port = parseInt(process.env.ZK_DEVICE_PORT || '4370');
    this.timeout = parseInt(process.env.ZK_TIMEOUT || '10000');
  }

  async connect() {
    const zk = new ZKLib(this.ip, this.port, this.timeout, 4000);
    await zk.createSocket();
    return zk;
  }

  // Pull all attendance logs from device
  async fetchAttendanceLogs() {
    let zk;
    try {
      zk = await this.connect();
      const result = await zk.getAttendances();
      await zk.disconnect();
      return result?.data || [];
    } catch (err) {
      if (zk) try { await zk.disconnect(); } catch (_) {}
      throw new Error(`ZK Device connection failed (${this.ip}:${this.port}): ${err.message}`);
    }
  }

  // Pull all users registered on the device
  async fetchDeviceUsers() {
    let zk;
    try {
      zk = await this.connect();
      const result = await zk.getUsers();
      await zk.disconnect();
      return result?.data || [];
    } catch (err) {
      if (zk) try { await zk.disconnect(); } catch (_) {}
      throw new Error(`ZK Device connection failed (${this.ip}:${this.port}): ${err.message}`);
    }
  }

  // Get device info (capacity, logs count, etc.)
  async getDeviceInfo() {
    let zk;
    try {
      zk = await this.connect();
      const info = await zk.getInfo();
      await zk.disconnect();
      return info;
    } catch (err) {
      if (zk) try { await zk.disconnect(); } catch (_) {}
      throw new Error(`ZK Device connection failed (${this.ip}:${this.port}): ${err.message}`);
    }
  }

  // Enable real-time log push from device
  async startRealTimeLogs(callback) {
    const zk = await this.connect();
    await zk.getRealTimeLogs((log) => {
      callback(log);
    });
    return zk; // caller must disconnect when done
  }

  // Map device user ID to D365 employee
  async resolveEmployeeId(deviceUserId) {
    const { data } = await d365.getList(d365.constructor.entities.employee, {
      filter: `hr_etimecode eq '${deviceUserId}'`,
      select: 'hr_hremployeeid,hr_hremployee1',
    });
    return data?.[0] || null;
  }

  // Group punch logs by user+date, compute in/out times
  groupLogsByDay(logs) {
    const grouped = {};
    for (const log of logs) {
      const ts = log.recordTime;
      if (!ts) continue;
      const date = new Date(ts);
      const dateStr = date.toISOString().split('T')[0];
      const timeStr = date.toTimeString().slice(0, 5); // HH:MM
      const key = `${log.deviceUserId}_${dateStr}`;

      if (!grouped[key]) {
        grouped[key] = {
          deviceUserId: String(log.deviceUserId),
          date: dateStr,
          punches: [],
        };
      }
      grouped[key].punches.push(timeStr);
    }

    // Sort punches and compute in/out
    for (const entry of Object.values(grouped)) {
      entry.punches.sort();
      entry.inTime = entry.punches[0];
      entry.outTime = entry.punches.length > 1 ? entry.punches[entry.punches.length - 1] : null;

      // Calculate worked hours
      if (entry.inTime && entry.outTime) {
        const [inH, inM] = entry.inTime.split(':').map(Number);
        const [outH, outM] = entry.outTime.split(':').map(Number);
        entry.workedHours = Math.round(((outH * 60 + outM) - (inH * 60 + inM)) / 60 * 100) / 100;
        entry.overtime = Math.max(0, entry.workedHours - 8);
      } else {
        entry.workedHours = 0;
        entry.overtime = 0;
      }
    }

    return Object.values(grouped);
  }

  computeStatus(entry) {
    if (!entry.inTime) return 'absent';
    if (!entry.outTime) return 'incomplete';
    if (entry.workedHours < 4) return 'half_day';
    return 'present';
  }

  // Core sync: pull logs from device → group → upsert into D365
  async syncAttendance(fromDate, toDate) {
    const allLogs = await this.fetchAttendanceLogs();
    const results = { synced: 0, skipped: 0, errors: [], total_logs: allLogs.length };

    // Filter logs by date range
    const from = fromDate ? new Date(fromDate) : new Date('2000-01-01');
    const to = toDate ? new Date(toDate) : new Date('2099-12-31');
    const filteredLogs = allLogs.filter(log => {
      if (!log.recordTime) return false;
      const d = new Date(log.recordTime);
      const dateOnly = new Date(d.toISOString().split('T')[0]);
      return dateOnly >= new Date(from.toISOString().split('T')[0]) &&
             dateOnly <= new Date(to.toISOString().split('T')[0]);
    });

    const grouped = this.groupLogsByDay(filteredLogs);

    for (const entry of grouped) {
      try {
        const employee = await this.resolveEmployeeId(entry.deviceUserId);
        if (!employee) {
          results.skipped++;
          continue;
        }

        // Check if record already exists for this employee + date
        const { data: existing } = await d365.getList(d365.constructor.entities.attendance, {
          filter: `_hr_hremployee_value eq '${employee.hr_hremployeeid}' and hr_date eq ${entry.date}`,
          select: 'hr_hrattendanceid',
        });

        const status = this.computeStatus(entry);
        const payload = {
          'hr_hremployee@odata.bind': `/hr_hremployees(${employee.hr_hremployeeid})`,
          hr_date: entry.date,
          hr_intime: entry.inTime,
          hr_outtime: entry.outTime || '',
          hr_workedhours: entry.workedHours,
          hr_overtime: entry.overtime,
          hr_deviceid: this.ip,
          hr_source: toValue('hr_attendance_source', 'etime_device'),
          hr_status: toValue('hr_attendance_status', status),
        };

        if (existing.length > 0) {
          await d365.update(d365.constructor.entities.attendance, existing[0].hr_hrattendanceid, payload);
        } else {
          await d365.create(d365.constructor.entities.attendance, payload);
        }
        results.synced++;
      } catch (err) {
        results.errors.push({ userId: entry.deviceUserId, date: entry.date, error: err.message });
        global.logger?.error(`ZK sync error for user ${entry.deviceUserId} on ${entry.date}: ${err.message}`);
      }
    }

    global.logger?.info(`ZK sync complete: ${results.synced} synced, ${results.skipped} skipped, ${results.errors.length} errors`);
    return results;
  }
}

module.exports = new ZKDeviceService();
