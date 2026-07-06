const axios = require('axios');
const { ConfidentialClientApplication } = require('@azure/msal-node');

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

// ── Email transport: Microsoft Graph (app-only OAuth2 client credentials) ──
// Reuses the existing Azure AD app registration (same credentials as D365).
// Prerequisite: the app needs the Graph "Mail.Send" APPLICATION permission with
// admin consent (recommended: scope it to GRAPH_SENDER via an Application Access
// Policy). This replaces the previous Nodemailer/SMTP transport; the public
// sendEmail(to, subject, html) contract is unchanged so all callers keep working.
const GRAPH_SENDER = process.env.GRAPH_SENDER || 'info@crmonce.com';
const GRAPH_SCOPE = 'https://graph.microsoft.com/.default';

const graphMsal = new ConfidentialClientApplication({
  auth: {
    clientId: process.env.AZURE_CLIENT_ID,
    clientSecret: process.env.AZURE_CLIENT_SECRET,
    authority: `https://login.microsoftonline.com/${process.env.AZURE_TENANT_ID}`,
  },
});

// MSAL caches the token internally and refreshes it as needed.
async function getGraphToken() {
  const result = await graphMsal.acquireTokenByClientCredential({ scopes: [GRAPH_SCOPE] });
  return result.accessToken;
}

/**
 * Send an email via Microsoft Graph. Backward-compatible: the (to, subject, html)
 * signature is unchanged; an optional 4th arg adds a Reply-To without changing
 * the sender (Graph app-only can only send AS the licensed GRAPH_SENDER mailbox).
 *   to: string — a single address or a comma-separated list
 *   opts.replyTo: string | { email, name } — "Reply" goes here (e.g. the employee)
 * Best-effort: never throws; returns { success } (+ error on failure).
 */
async function sendEmail(to, subject, html, opts = {}) {
  try {
    const toRecipients = String(to)
      .split(',')
      .map(a => a.trim())
      .filter(Boolean)
      .map(address => ({ emailAddress: { address } }));

    if (toRecipients.length === 0) {
      global.logger?.warn('Graph sendMail skipped: no recipients');
      return { success: false, error: 'no recipients' };
    }

    const message = {
      subject,
      body: { contentType: 'HTML', content: html },
      toRecipients,
    };

    // Reply-To (does not spoof From) — makes "Reply" target the employee.
    if (opts.replyTo) {
      const emailAddress = typeof opts.replyTo === 'string'
        ? { address: opts.replyTo }
        : { address: opts.replyTo.email, name: opts.replyTo.name };
      if (emailAddress.address) message.replyTo = [{ emailAddress }];
    }

    // Optional attachments (e.g. .ics calendar invite) — Graph fileAttachment.
    if (Array.isArray(opts.attachments) && opts.attachments.length) {
      message.attachments = opts.attachments.map(a => ({
        '@odata.type': '#microsoft.graph.fileAttachment',
        name: a.name, contentType: a.contentType, contentBytes: a.contentBytes,
      }));
    }

    const token = await getGraphToken();
    await axios.post(
      `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(GRAPH_SENDER)}/sendMail`,
      { message, saveToSentItems: true },
      {
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        timeout: 20000,
      }
    );

    global.logger?.info(`Graph email sent to ${to} — "${subject}"`);
    global.logger?.info(`EMAIL_AUDIT ${JSON.stringify({ to, subject, type: opts.meta?.type || 'generic', status: 'sent', at: new Date().toISOString() })}`);
    return { success: true };
  } catch (err) {
    const msg = err.response?.data?.error?.message || err.message;
    global.logger?.error(`Graph email failed to ${to}: ${msg}`);
    global.logger?.error(`EMAIL_AUDIT ${JSON.stringify({ to, subject, type: opts.meta?.type || 'generic', status: 'failed', error: msg, at: new Date().toISOString() })}`);
    return { success: false, error: msg };
  }
}

// Startup diagnostic — confirm app-only Graph auth is obtainable (sends no mail).
// A successful token does NOT prove Mail.Send is granted; a missing permission
// surfaces as a 403 on the first real send (logged by sendEmail).
setImmediate(() => {
  const log = global.logger || console;
  const missing = ['AZURE_TENANT_ID', 'AZURE_CLIENT_ID', 'AZURE_CLIENT_SECRET']
    .filter(k => !process.env[k]);
  if (missing.length) {
    log.warn(`Graph email not configured — missing: ${missing.join(', ')} (emails will NOT send)`);
    return;
  }
  getGraphToken()
    .then(() => log.info(`Graph email ready — sender ${GRAPH_SENDER} (requires Mail.Send app permission)`))
    .catch(err => log.error(`Graph token acquisition FAILED: ${err.message}`));
});

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
