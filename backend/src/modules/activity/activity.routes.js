const express = require('express');
const router = express.Router();
const activity = require('../../services/activity.service');
const { requireAnyPermission } = require('../../middleware/auth.middleware');

/**
 * GET /api/activity — recent important system activities (newest first).
 * Real events only: derived from D365 records + runtime sync events.
 * ?limit=20 (dashboard) … capped at 100 (View All page).
 *
 * ── WHY THIS IS PERMISSION-GATED ─────────────────────────────────────
 * This route had no guard beyond authentication, so any signed-in user
 * could pull up to 100 company-wide events — including payroll_generated
 * carrying other employees' names, PT, net salary, working days and LOP.
 * An employee holds none of payroll.*, salary.view or reports.view, so it
 * returned exactly what those flags deny. Hiding the UI did not help: the
 * endpoint stayed reachable from devtools or any saved session.
 *
 * activity.recent() is not scoped to the caller, and scoping it would mean
 * redesigning the feed — out of scope here. Gating the route is what
 * actually stops the exposure.
 *
 * reports.view is used because it already guards /dashboard/admin-summary,
 * which serves this same feed. No new permission, catalogue unchanged:
 * employee does not hold it, hr_manager does, super_admin has '*'.
 */
router.get('/', requireAnyPermission('reports.view'), async (req, res, next) => {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 100);
    const items = await activity.recent(limit);
    res.json({ data: items });
  } catch (err) { next(err); }
});

module.exports = router;
