/**
 * RBAC Security Audit middleware — mounted once, globally, before the route mounts.
 * It registers a res 'finish' handler and returns immediately (never blocks the
 * request). At finish, req.user has been populated by the per-route authenticateToken
 * and the RBAC guards have stashed what they checked on req._audit, so we can record a
 * best-effort audit row for RBAC-protected mutations and denied (403) attempts.
 *
 * Zero route-handler changes; all business logic/calculations are untouched.
 */
const auditLog = require('../services/audit-log.service');

function auditSensitiveActions(req, res, next) {
  res.on('finish', () => {
    try {
      if (!auditLog.shouldAudit(req, res)) return;
      // fire-and-forget; record() is itself best-effort and swallows all errors
      auditLog.record(auditLog.buildEntry(req, res));
    } catch (_) { /* never let auditing affect the response */ }
  });
  next();
}

module.exports = { auditSensitiveActions };
