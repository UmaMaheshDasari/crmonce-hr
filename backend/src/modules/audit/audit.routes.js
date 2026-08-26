/**
 * Audit Log — read API, mounted at /api/audit. RBAC security audit of admin actions.
 * Read access is gated by the granular 'audit.view' permission (super_admin + HR).
 * Write is server-side only (the audit middleware); there is no create/update/delete API.
 */
const express = require('express');
const router = express.Router();
const { requireAnyPermission } = require('../../middleware/auth.middleware');
const auditLog = require('../../services/audit-log.service');

// GET /  — audit rows, newest first. Filters: action, actor, actorRole, outcome, category,
// targetId (the "Employee"/target filter — RBAC Phase E), from, to, top.
router.get('/', requireAnyPermission('audit.view'), async (req, res, next) => {
  try {
    const { action, actor, actorRole, outcome, category, targetId, from, to } = req.query;
    const top = Math.min(Number(req.query.top) || 500, 2000);
    const rows = await auditLog.list({ action, actor, actorRole, outcome, category, targetId, from, to, top });
    res.json({ data: rows, count: rows.length });
  } catch (err) { next(err); }
});

// CSV escaping: wrap in quotes and double any embedded quotes.
const csv = (v) => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`;

// GET /export  — same query as the listing, streamed as CSV. Gated by audit.export.
// Uses the SAME Phase C audit service (no second data source).
router.get('/export', requireAnyPermission('audit.export'), async (req, res, next) => {
  try {
    const { action, actor, actorRole, outcome, category, targetId, from, to } = req.query;
    const top = Math.min(Number(req.query.top) || 5000, 10000);
    const rows = await auditLog.list({ action, actor, actorRole, outcome, category, targetId, from, to, top });
    const cols = ['occurredOn', 'actor', 'actorRole', 'category', 'action', 'targetId', 'outcome', 'method', 'path', 'ip', 'details'];
    const header = cols.map(csv).join(',');
    const body = (rows || []).map((r) => cols.map((c) => csv(r[c])).join(',')).join('\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="audit-log-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send(`${header}\n${body}`);
  } catch (err) { next(err); }
});

module.exports = router;
