const nodemailer = require('nodemailer');

let io;
const userSockets = new Map(); // userId -> socketId

function initSocket(socketServer) {
  io = socketServer;
  global.io = io; // Make io available globally so any module can emit events

  io.on('connection', (socket) => {
    socket.on('register', (userId) => {
      userSockets.set(userId, socket.id);
      socket.userId = userId;
    });

    // Handle attendance punch events from ZK device
    socket.on('attendance:punch', (data) => {
      // Broadcast punch to all connected clients
      io.emit('attendance:punch', data);
    });

    socket.on('disconnect', () => {
      if (socket.userId) userSockets.delete(socket.userId);
    });
  });
}

function notifyUser(userId, event, payload) {
  const socketId = userSockets.get(userId);
  if (socketId) io?.to(socketId).emit(event, payload);
}

function broadcast(event, payload) {
  io?.emit(event, payload);
}

// Email transport
const SMTP_PORT = parseInt(process.env.SMTP_PORT || '587');
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: SMTP_PORT,
  secure: SMTP_PORT === 465, // 465 = implicit TLS; 587/25 = STARTTLS
  auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
});

// Startup diagnostics — surface SMTP config/connection problems in the logs.
// Deferred so global.logger (created later in server.js) is available.
setImmediate(() => {
  const log = global.logger || console;
  const missing = ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM']
    .filter(k => !process.env[k]);
  if (missing.length) {
    log.warn(`SMTP not fully configured — missing: ${missing.join(', ')} (emails will NOT send)`);
    return;
  }
  transporter.verify()
    .then(() => log.info(`SMTP ready — ${process.env.SMTP_HOST}:${SMTP_PORT} as ${process.env.SMTP_USER}`))
    .catch(err => log.error(`SMTP verify FAILED — ${process.env.SMTP_HOST}:${SMTP_PORT}: ${err.message}`));
});

async function sendEmail(to, subject, html) {
  try {
    const info = await transporter.sendMail({ from: process.env.SMTP_FROM, to, subject, html });
    global.logger?.info(`Email sent to ${to} — "${subject}"`);
    return { success: true, info };
  } catch (err) {
    global.logger?.error(`Email send failed to ${to}: ${err.message}`);
    return { success: false, error: err.message };
  }
}

// Notification helpers
async function notifyLeaveApproval(userId, status, leaveDates) {
  notifyUser(userId, 'leave:updated', { status, dates: leaveDates });
  broadcast('leave:updated', { userId, status, dates: leaveDates });
}

async function notifyPayrollProcessed(userId, month) {
  notifyUser(userId, 'payroll:processed', { month });
}

async function notifyNewApplicant(hrManagerId, jobTitle, applicantName) {
  notifyUser(hrManagerId, 'recruitment:new_applicant', { jobTitle, applicantName });
  broadcast('recruitment:new_applicant', { jobTitle, applicantName });
}

async function notifyAttendanceAnomaly(userId, date, issue) {
  notifyUser(userId, 'attendance:anomaly', { date, issue });
}

module.exports = {
  initSocket, notifyUser, broadcast, sendEmail,
  notifyLeaveApproval, notifyPayrollProcessed,
  notifyNewApplicant, notifyAttendanceAnomaly,
};
