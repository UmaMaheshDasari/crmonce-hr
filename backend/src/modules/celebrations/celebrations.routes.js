/**
 * Celebrations — mounted at /api/celebrations.
 *
 *   GET  /today      any authenticated user — privacy-safe list for the dashboard
 *                    (photo, name, employee id, department, designation only).
 *   GET  /settings   HR — the celebration settings (toggles, templates, send time).
 *   PUT  /settings   HR — update settings.
 *   GET  /logs       HR — the audit trail (email + notification status per send).
 *   POST /run        HR — manually run today's celebrations now (respects the
 *                    duplicate-email guard; bypasses the send-time gate).
 */
const express = require('express');
const router = express.Router();
const { requireRole } = require('../../middleware/auth.middleware');
const celebrations = require('../../services/celebrations.service');
const { ensureCelebrationTables } = require('../../services/provision-celebrations');

const HR = ['super_admin', 'hr_manager'];

// Self-heal the tables if a query hits a not-yet-provisioned table.
async function withTables(fn) {
  try { return await fn(); }
  catch (err) {
    if (/Resource not found for the segment|does not exist|Could not find/i.test(err.message || '')) {
      await ensureCelebrationTables(global.logger || console).catch(() => {});
      return await fn();
    }
    throw err;
  }
}

// GET /today — dashboard celebrations (any authenticated user; no dates exposed).
router.get('/today', async (req, res, next) => {
  try { res.json(await celebrations.celebrationsToday()); }
  catch (err) { next(err); }
});

// GET /settings — HR.
router.get('/settings', requireRole(...HR), async (req, res, next) => {
  try { res.json(await celebrations.getSettings()); }
  catch (err) { next(err); }
});

// PUT /settings — HR. Accepts the raw hr_* columns (whitelisted in the service).
router.put('/settings', requireRole(...HR), async (req, res, next) => {
  try { res.json(await withTables(() => celebrations.updateSettings(req.body || {}))); }
  catch (err) { next(err); }
});

// GET /logs — HR audit trail (filters: type, date, employeeId).
router.get('/logs', requireRole(...HR), async (req, res, next) => {
  try { res.json({ data: await withTables(() => celebrations.listLogs({ type: req.query.type, date: req.query.date, employeeId: req.query.employeeId })) }); }
  catch (err) { next(err); }
});

// POST /run — HR manual trigger (Run Now). Bypasses the send-time gate; dedupe still applies.
router.post('/run', requireRole(...HR), async (req, res, next) => {
  try { res.json(await withTables(() => celebrations.runDaily({ scheduled: false, force: true }))); }
  catch (err) { next(err); }
});

module.exports = router;
