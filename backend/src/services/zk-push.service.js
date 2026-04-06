/**
 * ZKTeco Z900 Push Service with eTimeOffice Cloud Proxy
 *
 * Device pushes to our server → we process the data AND forward to
 * eTimeOffice cloud (data.etimeoffice.com:6009) which sends back the
 * correct ACK that clears the device queue.
 */
const net = require('net');
const d365 = require('./d365.service');
const { toValue } = require('./picklist');

const ETIME_CLOUD_HOST = 'data.etimeoffice.com';
const ETIME_CLOUD_PORT = 6009;

class ZKPushService {
  constructor() {
    this.port = parseInt(process.env.ZK_PUSH_PORT || '9922');
    this.server = null;
    this.onPunchCallback = null;
    this.processedPunches = new Set();
    this.dupCount = 0;
  }

  start(onPunch) {
    this.onPunchCallback = onPunch;

    this.server = net.createServer((deviceSocket) => {
      const deviceIp = deviceSocket.remoteAddress;
      let deviceBuffer = Buffer.alloc(0);

      // Connect to eTimeOffice cloud to proxy the data and get proper ACK
      const cloudSocket = new net.Socket();
      cloudSocket.setTimeout(15000);

      cloudSocket.connect(ETIME_CLOUD_PORT, ETIME_CLOUD_HOST, () => {
        global.logger?.debug(`ZK Proxy: Connected to eTimeOffice cloud`);
      });

      cloudSocket.on('error', (err) => {
        global.logger?.warn(`ZK Proxy: Cloud unreachable (${err.code}) — device queue won't clear`);
      });

      // When cloud sends ACK back, forward to device (this clears the queue!)
      cloudSocket.on('data', (ackData) => {
        global.logger?.info(`ZK Proxy: Cloud ACK ${ackData.length} bytes → forwarding to device`);
        try { deviceSocket.write(ackData); } catch (_) {}
      });

      cloudSocket.on('end', () => {
        try { deviceSocket.end(); } catch (_) {}
      });

      // Handle device data
      deviceSocket.on('data', (chunk) => {
        deviceBuffer = Buffer.concat([deviceBuffer, chunk]);
        const raw = deviceBuffer.toString('utf8');

        if (!raw.includes('</Message>')) return;
        deviceBuffer = Buffer.alloc(0);

        // 1. Process attendance data locally
        const regex = /<Message>[\s\S]*?<\/Message>/g;
        let match;
        while ((match = regex.exec(raw)) !== null) {
          this.handleXml(match[0], deviceIp);
        }

        // 2. Forward raw data to eTimeOffice cloud for proper ACK
        try { cloudSocket.write(chunk); } catch (_) {}
      });

      deviceSocket.on('error', () => {});
      deviceSocket.on('close', () => {
        cloudSocket.destroy();
      });
      deviceSocket.setTimeout(30000, () => deviceSocket.end());
    });

    this.server.listen(this.port, '0.0.0.0', () => {
      global.logger?.info(`ZK Push+Proxy server on port ${this.port} (→ ${ETIME_CLOUD_HOST}:${ETIME_CLOUD_PORT})`);
    });

    this.server.on('error', (err) => {
      global.logger?.error(`ZK server error: ${err.message}`);
    });
  }

  handleXml(xml, deviceIp) {
    const get = (tag) => {
      const m = xml.match(new RegExp(`<${tag}>([^<]*)</${tag}>`));
      return m ? m[1].trim() : null;
    };

    if (get('Event') !== 'TimeLog') return;

    const userId = get('UserID');
    const year = get('Year');
    const month = get('Month')?.padStart(2, '0');
    const day = get('Day')?.padStart(2, '0');
    const hour = get('Hour')?.padStart(2, '0');
    const minute = get('Minute')?.padStart(2, '0');
    const second = get('Second')?.padStart(2, '0');
    const date = `${year}-${month}-${day}`;
    const time = `${hour}:${minute}`;

    const key = `${userId}_${date}_${hour}:${minute}:${second}`;
    if (this.processedPunches.has(key)) {
      this.dupCount++;
      if (this.dupCount % 50 === 0) {
        global.logger?.debug(`ZK: ${this.dupCount} duplicates suppressed`);
      }
      return;
    }

    this.processedPunches.add(key);
    if (this.processedPunches.size > 10000) {
      this.processedPunches = new Set([...this.processedPunches].slice(-5000));
    }

    this.dupCount = 0;
    global.logger?.info(`ZK Punch [NEW]: User ${userId} | ${date} ${time} | ${get('AttendStat')} | ${get('VerifMode')}`);
    this.syncToD365({ userId, date, time, deviceSN: get('DeviceSerialNo') || 'Z900' }, deviceIp).catch(() => {});
  }

  /**
   * Sync punch to D365 — stores ALL punches, computes attendance from first/last,
   * calculates break duration from intermediate punches.
   *
   * Logic:
   *  - All punches stored in hr_allpunches as JSON array ["09:00","12:30","13:00","18:00"]
   *  - hr_intime = first punch of the day
   *  - hr_outtime = last punch of the day (updated on every new punch)
   *  - hr_workedhours = last punch - first punch (total duration)
   *  - hr_breakduration = sum of gaps between even→odd punches (2nd→3rd, 4th→5th, etc.)
   *  - hr_effectivehours = workedhours - breakduration
   *  - hr_punchcount = total punches
   */
  async syncToD365(record, deviceIp) {
    try {
      const { data } = await d365.getList(d365.constructor.entities.employee, {
        filter: `hr_etimecode eq '${record.userId}'`,
        select: 'hr_hremployeeid,hr_hremployee1',
      });

      if (!data || data.length === 0) {
        global.logger?.warn(`ZK: Unknown user ID ${record.userId}`);
        return;
      }

      const employee = data[0];
      const { data: existing } = await d365.getList(d365.constructor.entities.attendance, {
        filter: `_hr_hremployee_value eq '${employee.hr_hremployeeid}' and hr_date eq ${record.date}`,
        select: 'hr_hrattendanceid,hr_intime,hr_outtime,hr_allpunches,hr_punchcount',
      });

      let punchType;

      if (existing.length > 0) {
        const current = existing[0];

        // Parse existing punches array
        let punches = [];
        try { punches = JSON.parse(current.hr_allpunches || '[]'); } catch (_) { punches = []; }
        if (!Array.isArray(punches)) punches = [];

        // Add current punch if not already present
        if (!punches.includes(record.time)) {
          punches.push(record.time);
        }

        // Sort punches chronologically
        punches.sort();

        const firstPunch = punches[0];
        const lastPunch = punches[punches.length - 1];
        const totalHours = this.calcHours(firstPunch, lastPunch);
        const breakDuration = this.calcBreakDuration(punches);
        const effectiveHours = Math.max(0, totalHours - breakDuration);
        const status = punches.length < 2 ? 'incomplete' : effectiveHours < 4 ? 'half_day' : 'present';

        const updatePayload = {
          hr_intime: firstPunch,
          hr_outtime: punches.length > 1 ? lastPunch : '',
          hr_workedhours: Math.round(totalHours * 100) / 100,
          hr_overtime: Math.max(0, Math.round((effectiveHours - 8) * 100) / 100),
          hr_status: toValue('hr_attendance_status', status),
          hr_allpunches: JSON.stringify(punches),
          hr_punchcount: punches.length,
          hr_breakduration: Math.round(breakDuration * 100) / 100,
          hr_effectivehours: Math.round(effectiveHours * 100) / 100,
        };

        await d365.update(d365.constructor.entities.attendance, current.hr_hrattendanceid, updatePayload);
        punchType = punches.length <= 1 ? 'in' : 'out';
        global.logger?.info(`ZK Sync: ${employee.hr_hremployee1} punch #${punches.length} at ${record.time} | Total: ${totalHours.toFixed(2)}h | Break: ${breakDuration.toFixed(2)}h | Effective: ${effectiveHours.toFixed(2)}h`);
      } else {
        // First punch of the day
        const punches = [record.time];
        await d365.create(d365.constructor.entities.attendance, {
          'hr_hremployee@odata.bind': `/hr_hremployees(${employee.hr_hremployeeid})`,
          hr_date: record.date,
          hr_intime: record.time,
          hr_outtime: '',
          hr_workedhours: 0,
          hr_overtime: 0,
          hr_deviceid: deviceIp || 'Z900',
          hr_source: toValue('hr_attendance_source', 'etime_device'),
          hr_status: toValue('hr_attendance_status', 'incomplete'),
          hr_allpunches: JSON.stringify(punches),
          hr_punchcount: 1,
          hr_breakduration: 0,
          hr_effectivehours: 0,
        });
        punchType = 'in';
        global.logger?.info(`ZK Sync: IN — ${employee.hr_hremployee1} at ${record.time} (first punch)`);
      }

      if (this.onPunchCallback) {
        this.onPunchCallback({
          employeeId: employee.hr_hremployeeid,
          employeeName: employee.hr_hremployee1,
          time: record.time,
          date: record.date,
          type: punchType,
        });
      }
    } catch (err) {
      global.logger?.error(`ZK Sync error for user ${record.userId}: ${err.message}`);
    }
  }

  /**
   * Calculate break duration from punch array.
   * Punches: [IN, OUT, IN, OUT, IN, OUT]
   *           0    1    2   3    4   5
   * Breaks = gap between punch[1]→punch[2], punch[3]→punch[4], etc.
   * (odd index to next even index = break)
   */
  calcBreakDuration(punches) {
    if (punches.length < 3) return 0;
    let totalBreak = 0;
    for (let i = 1; i < punches.length - 1; i += 2) {
      const breakOut = punches[i];
      const breakIn = punches[i + 1];
      if (breakOut && breakIn) {
        totalBreak += this.calcHours(breakOut, breakIn);
      }
    }
    return totalBreak;
  }

  calcHours(inTime, outTime) {
    if (!inTime || !outTime) return 0;
    const [inH, inM] = inTime.split(':').map(Number);
    const [outH, outM] = outTime.split(':').map(Number);
    return Math.round(((outH * 60 + outM) - (inH * 60 + inM)) / 60 * 100) / 100;
  }

  stop() { if (this.server) this.server.close(); }
}

module.exports = new ZKPushService();
