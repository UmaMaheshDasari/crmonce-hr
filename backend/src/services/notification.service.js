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

/** Normalize a recipient input (string, comma-list, or array of str/{email,name})
 *  into Graph recipient objects. */
function toRecipientList(v) {
  if (!v) return [];
  const arr = Array.isArray(v) ? v : String(v).split(',');
  return arr
    .map(x => (typeof x === 'string' ? { address: x.trim() } : { address: x?.email || x?.address, name: x?.name }))
    .filter(x => x.address)
    .map(({ address, name }) => ({ emailAddress: name ? { address, name } : { address } }));
}

/**
 * PURE builder — assembles the exact Microsoft Graph /sendMail request WITHOUT
 * any network call. Exposed so tests can assert Sender/To/CC/Subject/Body/
 * Attachments without touching Graph.
 *   from: sender mailbox (defaults to GRAPH_SENDER for backward compatibility)
 */
function buildSendMailRequest({ from, to, cc, subject, html, replyTo, attachments }) {
  const sender = from || GRAPH_SENDER;
  const message = {
    subject,
    body: { contentType: 'HTML', content: html },
    toRecipients: toRecipientList(to),
    ccRecipients: toRecipientList(cc),
  };
  if (replyTo) {
    const ea = typeof replyTo === 'string' ? { address: replyTo } : { address: replyTo.email, name: replyTo.name };
    if (ea.address) message.replyTo = [{ emailAddress: ea }];
  }
  if (Array.isArray(attachments) && attachments.length) {
    message.attachments = attachments.map(a => ({
      '@odata.type': '#microsoft.graph.fileAttachment',
      name: a.name, contentType: a.contentType, contentBytes: a.contentBytes,
    }));
  }
  return {
    sender,
    url: `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(sender)}/sendMail`,
    body: { message, saveToSentItems: true },
  };
}

// ── Transport (injectable for tests) + dry-run safety switch ──────────────────
// transport === null → real Graph. Tests call setTransport() to capture requests
// so NO email is ever sent. EMAIL_DRY_RUN=true also blocks all live sends.
let transport = null;
const outbox = [];
function setTransport(fn) { transport = fn; }
function resetTransport() { transport = null; }
function getOutbox() { return outbox.slice(); }
function clearOutbox() { outbox.length = 0; }
const isDryRun = () => process.env.EMAIL_DRY_RUN === 'true';

/**
 * Send an email via Microsoft Graph. Backward-compatible: the (to, subject, html)
 * signature is unchanged and `from` defaults to GRAPH_SENDER.
 *   opts.from        — sender mailbox (dynamic; e.g. the employee/approver). Graph
 *                      app-only can send AS any real mailbox in the tenant.
 *   opts.cc          — string | array of addresses/{email,name} (real CC line)
 *   opts.replyTo     — string | { email, name }
 *   opts.attachments — [{ name, contentType, contentBytes }]
 * Best-effort: never throws; returns { success } (+ error/dryRun/request).
 */
async function sendEmail(to, subject, html, opts = {}) {
  const req = buildSendMailRequest({ from: opts.from, to, cc: opts.cc, subject, html, replyTo: opts.replyTo, attachments: opts.attachments });
  try {
    if (req.body.message.toRecipients.length === 0) {
      global.logger?.warn('Graph sendMail skipped: no recipients');
      return { success: false, error: 'no recipients' };
    }

    // Test transport OR dry-run: build + record, but NEVER call Microsoft Graph.
    if (transport || isDryRun()) {
      const rec = { from: req.sender, to, cc: opts.cc || null, subject, type: opts.meta?.type || 'generic', at: new Date().toISOString() };
      outbox.push({ ...rec, request: req });
      if (transport) await transport(req, { subject, html, ...opts });
      global.logger?.info(`EMAIL_AUDIT ${JSON.stringify({ ...rec, status: transport ? 'mock' : 'dry_run' })}`);
      return { success: true, dryRun: !transport, mocked: !!transport, request: req };
    }

    const token = await getGraphToken();
    await axios.post(req.url, req.body, {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      timeout: 20000,
    });

    global.logger?.info(`Graph email sent from ${req.sender} to ${to} — "${subject}"`);
    global.logger?.info(`EMAIL_AUDIT ${JSON.stringify({ from: req.sender, to, subject, type: opts.meta?.type || 'generic', status: 'sent', at: new Date().toISOString() })}`);
    return { success: true };
  } catch (err) {
    const msg = err.response?.data?.error?.message || err.message;
    global.logger?.error(`Graph email failed (from ${req.sender}) to ${to}: ${msg}`);
    global.logger?.error(`EMAIL_AUDIT ${JSON.stringify({ from: req.sender, to, subject, type: opts.meta?.type || 'generic', status: 'failed', error: msg, at: new Date().toISOString() })}`);
    return { success: false, error: msg };
  }
}

// Startup diagnostic — confirm app-only Graph auth is obtainable (sends no mail).
// A successful token does NOT prove Mail.Send is granted; a missing permission
// surfaces as a 403 on the first real send (logged by sendEmail).
setImmediate(() => {
  if (process.env.NODE_ENV === 'test') return;   // never touch the network in tests
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
  // Email internals (dynamic sender + test/dry-run tooling)
  buildSendMailRequest, toRecipientList, GRAPH_SENDER,
  setTransport, resetTransport, getOutbox, clearOutbox,
};
