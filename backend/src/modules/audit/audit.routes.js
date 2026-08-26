/**
 * Audit Log — read API, mounted at /api/audit. RBAC security audit of admin actions.
 * Read access is gated by the granular 'audit.view' permission (super_admin + HR).
 * Write is server-side only (the audit middleware); there is no create/update/delete API.
 */
const express = require('express');
const router = express.Router();
const { requireAnyPermission } = require('../../middleware/auth.middleware');
const auditLog = require('../../services/audit-log.service');

// GET /  — audit rows, newest first. Filters: action, actor, actorRole, outcome, category, from, to, top.
router.get('/', requireAnyPermission('audit.view'), async (req, res, next) => {
  try {
    const { action, actor, actorRole, outcome, category, from, to } = req.query;
    const top = Math.min(Number(req.query.top) || 500, 2000);
    const rows = await auditLog.list({ action, actor, actorRole, outcome, category, from, to, top });
    res.json({ data: rows, count: rows.length });
  } catch (err) { next(err); }
});

module.exports = router;
