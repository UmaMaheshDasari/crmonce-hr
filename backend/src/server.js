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

const { authenticateToken } = require('./middleware/auth.middleware');
const { initJobs }          = require('./jobs');
const { initSocket }        = require('./services/notification.service');
const zkPushService         = require('./services/zk-push.service');

const app    = express();
const server = http.createServer(app);

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

// ── 404 ───────────────────────────────────────────────────────────
app.use((req, res) => res.status(404).json({ error: `Route ${req.method} ${req.url} not found` }));

// ── Global error handler ──────────────────────────────────────────
app.use((err, req, res, next) => {
  logger.error(`${err.message} — ${req.method} ${req.url}`);
  res.status(err.status || 500).json({ error: err.message || 'Internal server error' });
});

// ── Start ─────────────────────────────────────────────────────────
const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  logger.info(`✅ HR System backend running → http://localhost:${PORT}`);
  logger.info(`   Health check → http://localhost:${PORT}/health`);
  initJobs();

  // Start ZKTeco push listener
  zkPushService.start((punch) => {
    // Broadcast real-time punch to frontend via Socket.io
    io.emit('attendance:punch', punch);
    logger.info(`Real-time punch: ${punch.employeeName} ${punch.type} at ${punch.time}`);
  });
});

module.exports = { app, io };
