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

  // Payroll Automation — scheduled month-end run. OFF by default (opt-in), so it
  // never surprises anyone: set AUTO_PAYROLL=true to enable. Runs on the last day
  // of the month at 20:00 IST for the CURRENT month. Manual "Run Now" + retry are
  // always available in the Automation dashboard regardless of this flag.
  if (process.env.AUTO_PAYROLL === 'true') {
    const automation = require('../services/payroll-automation.service');
    cron.schedule('0 20 28-31 * *', async () => {
      const now = new Date();
      const last = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
      if (now.getDate() !== last) return;   // only actually run on the true last day
      global.logger?.info('[automation] scheduled month-end payroll run starting');
      automation.runJob({ month: now.getMonth() + 1, year: now.getFullYear(), user: { name: 'Scheduler' }, trigger: 'scheduled', wait: true })
        .catch(e => global.logger?.error(`[automation] scheduled run failed: ${e.message}`));
    }, { timezone: 'Asia/Kolkata' });
    global.logger?.info('Payroll Automation scheduled (last day of month, 20:00 IST)');
  }

  // Comp Off expiry — daily at 01:00 IST. Marks approved comp-off past its expiry
  // date as Expired, reverses the balance, and notifies the employee (email + in-app).
  {
    const compOff = require('../services/comp-off.service');
    cron.schedule('0 1 * * *', async () => {
      try {
        const n = await compOff.sweepExpired();
        if (n) global.logger?.info(`[comp-off] daily expiry sweep: ${n} comp-off credit(s) expired`);
      } catch (e) { global.logger?.error(`[comp-off] daily expiry sweep failed: ${e.message}`); }
    }, { timezone: 'Asia/Kolkata' });
    global.logger?.info('Comp Off expiry sweep scheduled (01:00 IST daily)');
  }

  // Celebrations — Birthday / Marriage Anniversary / Work Anniversary wishes.
  // Ticks every 30 min; celebrations.runDaily() only actually sends once the
  // configured Send Time (default 09:00 IST) has passed, and the audit log guards
  // against duplicate emails — so a missed 09:00 tick (server restart) still sends
  // later the same day, exactly once. Disable with CELEBRATIONS_SCHEDULER=false.
  if (process.env.CELEBRATIONS_SCHEDULER !== 'false') {
    const celebrations = require('../services/celebrations.service');
    cron.schedule('*/30 * * * *', () => {
      celebrations.runDaily({ scheduled: true })
        .then(r => { if (r?.total) global.logger?.info(`[celebrations] daily run: ${r.total} wish(es) sent`); })
        .catch(e => global.logger?.error(`[celebrations] daily run failed: ${e.message}`));
    }, { timezone: 'Asia/Kolkata' });
    global.logger?.info('Celebrations scheduled (every 30 min; sends at configured Send Time, IST)');
  }

  global.logger?.info('Cron jobs initialized');
}

module.exports = { initJobs };
