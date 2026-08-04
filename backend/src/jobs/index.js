const cron = require('node-cron');

function initJobs() {
  // Attendance sync is handled by zk-push.service.js (push+proxy mode) — no pull cron.

  // Attendance Exception scan: detect missing-punch exceptions on completed days and
  // notify employees (email from info@crmonce.com + in-app bell), with escalation.
  //  • 21:30 IST — nightly end-of-day detection for the just-finished day.
  //  • 09:00 IST — morning reminder pass over the last few unresolved days.
  // Disable with ATTENDANCE_EXCEPTION_SCAN=false. Times are Asia/Kolkata.
  if (process.env.ATTENDANCE_EXCEPTION_SCAN !== 'false') {
    const exceptions = require('../services/attendance-exception.service');
    const opts = { timezone: 'Asia/Kolkata' };
    cron.schedule('30 21 * * *', () => exceptions.runScan({ days: 1 }).catch(e => global.logger?.error(`[exception-scan nightly] ${e.message}`)), opts);
    cron.schedule('0 9 * * *', () => exceptions.runScan({ days: 3, reminder: true }).catch(e => global.logger?.error(`[exception-scan morning] ${e.message}`)), opts);
    global.logger?.info('Attendance exception scans scheduled (21:30 nightly, 09:00 reminders, IST)');
  }

  global.logger?.info('Cron jobs initialized');
}

module.exports = { initJobs };
