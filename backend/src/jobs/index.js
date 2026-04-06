const cron = require('node-cron');

function initJobs() {
  // Attendance sync is handled by zk-push.service.js (push+proxy mode)
  // No pull-based cron needed — device pushes in real-time via TCP

  global.logger?.info('Cron jobs initialized');
}

module.exports = { initJobs };
