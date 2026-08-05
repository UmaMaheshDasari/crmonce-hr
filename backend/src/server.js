require('dotenv').config();
const express = require('express');
const http = require('http');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { Server } = require('socket.io');
const winston = require('winston');
const path = require('path');
const fs = require('fs');

// Ensure logs and uploads dirs exist
['logs', 'uploads'].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

const authRoutes       = require('./modules/auth/auth.routes');
const employeeRoutes   = require('./modules/employees/employee.routes');
const attendanceRoutes = require('./modules/attendance/attendance.routes');
const payrollRoutes    = require('./modules/payroll/payroll.routes');
const taxDeclarationRoutes = require('./modules/payroll/tax-declaration.routes');
const recruitmentRoutes= require('./modules/recruitment/recruitment.routes');
const goalsRoutes      = require('./modules/performance/goals.routes');
const performanceRoutes= require('./modules/performance/performance.routes');
const documentRoutes   = require('./modules/documents/document.routes');
const activityRoutes   = require('./modules/activity/activity.routes');
const dashboardRoutes  = require('./modules/dashboard/dashboard.routes');
const attendanceRequestRoutes = require('./modules/attendance/attendance-request.routes');
const holidayRoutes    = require('./modules/attendance/holiday.routes');

const { authenticateToken } = require('./middleware/auth.middleware');
const { isAxiosError, formatAxiosError, summarize } = require('./utils/axiosError');
const { initJobs }          = require('./jobs');
const { initSocket }        = require('./services/notification.service');
const zkPushService         = require('./services/zk-push.service');

const app    = express();
const server = http.createServer(app);

// ── Trust proxy ───────────────────────────────────────────────────
// Production runs behind Nginx (one reverse proxy hop). Trust exactly ONE hop so
// req.ip / express-rate-limit read the real client IP from X-Forwarded-For.
// We use the hop COUNT (1), not `true` — `true` trusts every hop and lets a
// client spoof X-Forwarded-For, which express-rate-limit rejects as permissive.
// Override with TRUST_PROXY_HOPS if more proxies are chained (e.g. Cloudflare→Nginx = 2).
app.set('trust proxy', Number(process.env.TRUST_PROXY_HOPS || 1));

// ── Logger ────────────────────────────────────────────────────────
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.colorize(),
    winston.format.timestamp({ format: 'HH:mm:ss' }),
    winston.format.printf(({ timestamp, level, message }) => `${timestamp} ${level}: ${message}`)
  ),
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({ filename: 'logs/error.log',    level: 'error', format: winston.format.json() }),
    new winston.transports.File({ filename: 'logs/combined.log',                format: winston.format.json() }),
  ],
});
global.logger = logger;

// ── CORS ──────────────────────────────────────────────────────────
const corsOptions = {
  origin: (origin, cb) => {
    const allowed = process.env.FRONTEND_URL || 'http://localhost:3000';
    if (!origin || origin === allowed || process.env.NODE_ENV === 'development') cb(null, true);
    else cb(new Error('Not allowed by CORS'));
  },
  credentials: true,
};

// ── Socket.io ─────────────────────────────────────────────────────
const io = new Server(server, {
  cors: { origin: process.env.FRONTEND_URL || 'http://localhost:3000', credentials: true },
});
initSocket(io);

// ── Middleware ────────────────────────────────────────────────────
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors(corsOptions));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// ── Rate limiting ─────────────────────────────────────────────────
app.use('/api/auth', rateLimit({ windowMs: 15 * 60 * 1000, max: 50,  message: { error: 'Too many auth requests' } }));
app.use('/api',      rateLimit({ windowMs: 15 * 60 * 1000, max: 500, message: { error: 'Too many requests' } }));

// ── Static uploads ────────────────────────────────────────────────
app.use('/uploads', express.static(path.resolve(process.env.UPLOAD_DIR || './uploads')));

// ── Health check ──────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({ status: 'ok', timestamp: new Date().toISOString() }));

// ── API Routes ────────────────────────────────────────────────────
app.use('/api/auth',        authRoutes);
app.use('/api/employees',   authenticateToken, employeeRoutes);
app.use('/api/attendance',  authenticateToken, attendanceRoutes);
app.use('/api/payroll/tax-declarations', authenticateToken, taxDeclarationRoutes);
app.use('/api/payroll',     authenticateToken, payrollRoutes);
app.use('/api/recruitment', authenticateToken, recruitmentRoutes);
app.use('/api/performance/goals', authenticateToken, goalsRoutes);
app.use('/api/performance', authenticateToken, performanceRoutes);
app.use('/api/documents',   authenticateToken, documentRoutes);
app.use('/api/activity',    authenticateToken, activityRoutes);
app.use('/api/dashboard',   authenticateToken, dashboardRoutes);
app.use('/api/attendance-requests', authenticateToken, attendanceRequestRoutes);
app.use('/api/holidays',    authenticateToken, holidayRoutes);
app.use('/api/company',     authenticateToken, require('./modules/company/company.routes'));

// ── 404 ───────────────────────────────────────────────────────────
app.use((req, res) => res.status(404).json({ error: `Route ${req.method} ${req.url} not found` }));

// ── Global error handler ──────────────────────────────────────────
app.use((err, req, res, next) => {
  const route = `${req.method} ${req.url}`;
  if (isAxiosError(err)) {
    // Surface the underlying upstream (e.g. D365 / Graph) failure detail.
    logger.error(`Upstream request failed on ${route} → ${summarize(err)}`);
    logger.error(`Upstream error detail: ${JSON.stringify(formatAxiosError(err, { route }))}`);
  } else {
    logger.error(`${err.message} — ${route}\n${err.stack || ''}`);
  }
  // Response contract unchanged (diagnostics only).
  res.status(err.status || 500).json({ error: err.message || 'Internal server error' });
});

// ── Start ─────────────────────────────────────────────────────────
const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  logger.info(`✅ HR System backend running → http://localhost:${PORT}`);
  logger.info(`   Health check → http://localhost:${PORT}/health`);
  initJobs();

  // Best-effort: create the Missing Punch / Holiday tables if they don't exist yet
  // (idempotent). Skipped when they exist or the app lacks customization rights.
  if (process.env.AUTO_PROVISION !== 'false') {
    require('./services/provision-attendance-request')
      .ensureAttendanceRequestTable(logger)
      .catch(err => logger.warn(`[provision] attendance-request setup skipped: ${err.message}`));
    require('./services/provision-holiday')
      .ensureHolidayTable(logger)
      .catch(err => logger.warn(`[provision] holiday setup skipped: ${err.message}`));
    require('./services/provision-goal')
      // retry in the background if Dataverse is mid-customization (locked): every
      // 30s for up to 10 min. Non-blocking — the server keeps serving meanwhile.
      .ensureGoalTable(logger, { retry: true })
      .catch(err => logger.warn(`[provision] goal setup skipped: ${err.message}`));
    require('./services/provision-company')
      .ensureCompanyTable(logger, { retry: true })
      .catch(err => logger.warn(`[provision] company setup skipped: ${err.message}`));
    require('./services/provision-employee-columns')
      .ensureEmployeeColumns(logger)
      .catch(err => logger.warn(`[provision] employee identity/bank columns skipped: ${err.message}`));
    require('./services/provision-payroll-columns')
      .ensurePayrollColumns(logger)
      .catch(err => logger.warn(`[provision] payroll columns skipped: ${err.message}`));
    require('./services/provision-profile-audit')
      .ensureProfileAuditTable(logger, { retry: true })
      .catch(err => logger.warn(`[provision] profile-audit table skipped: ${err.message}`));
    require('./services/provision-document-columns')
      .ensureDocumentColumns(logger)
      .catch(err => logger.warn(`[provision] document columns skipped: ${err.message}`));
  }

  // Load the HR holiday calendar into attendance.config so holidays are excluded
  // from Working Days / Absent everywhere — ALWAYS (independent of provisioning),
  // and refresh periodically so new holidays apply without a restart (and across
  // pm2 instances). A holiday is a non-working day: never Absent, never Leave.
  const holidaySvc = require('./services/holiday.service');
  const loadHolidays = () => holidaySvc.refresh(true).catch(err => logger.warn(`[holiday] calendar load failed: ${err.message}`));
  setTimeout(loadHolidays, 2000);                        // after any table provisioning above
  setInterval(loadHolidays, 10 * 60 * 1000).unref();     // every 10 min

  // Start ZKTeco push listener
  zkPushService.start((punch) => {
    // Broadcast real-time punch to frontend via Socket.io
    io.emit('attendance:punch', punch);
    logger.info(`Real-time punch: ${punch.employeeName} ${punch.type} at ${punch.time}`);
  });
});

module.exports = { app, io };
