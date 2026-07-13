const express = require('express');
const router = express.Router();
const activity = require('../../services/activity.service');

/**
 * GET /api/activity — recent important system activities (newest first).
 * Real events only: derived from D365 records + runtime sync events.
 * ?limit=20 (dashboard) … capped at 100 (View All page).
 */
router.get('/', async (req, res, next) => {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 100);
    const items = await activity.recent(limit);
    res.json({ data: items });
  } catch (err) { next(err); }
});

module.exports = router;
