// PM2 Ecosystem Config — Hostinger VPS Production
// Usage:
//   pm2 start ecosystem.config.js
//   pm2 save
//   pm2 startup   ← run the output command to auto-start on reboot

module.exports = {
  apps: [
    {
      name: 'hr-backend',
      script: './backend/src/server.js',
      cwd: '/var/www/hr-system',
      instances: 2,              // 2 workers (adjust to CPU cores - 1)
      exec_mode: 'cluster',
      watch: false,
      max_memory_restart: '500M',
      env: {
        NODE_ENV: 'production',
        PORT: 5000,
      },
      error_file: '/var/log/hr-system/backend-error.log',
      out_file:   '/var/log/hr-system/backend-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      merge_logs: true,
      autorestart: true,
      restart_delay: 3000,
    },
  ],
};
