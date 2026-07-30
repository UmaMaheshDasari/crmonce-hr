/**
 * HR Holiday Calendar API. Everyone can read; only HR / Super Admin can add or
 * remove. Adding a holiday refreshes attendance.config so calculations exclude it
 * immediately, and records a "Holiday Added" activity.
 */
const express = require('express');
const router = express.Router();
const d365 = require('../../services/d365.service');
const { requireRole } = require('../../middleware/auth.middleware');
const holidayService = require('../../services/holiday.service');
const { ensureHolidayTable, addMissingColumn } = require('../../services/provision-holiday');

const HOL = d365.constructor.entities.holiday;
const notConfigured = (err) => /Could not find|does not exist|Resource not found|400|404/i.test(err?.message || '');

// Self-healing create: provision the table / add missing columns, then retry.
async function robustCreate(body) {
  const log = global.logger || console;
  let payload = { ...body };
  const tried = new Set();
  for (let i = 0; i < 10; i++) {
    try { return await d365.create(HOL, payload); }
    catch (err) {
      const msg = err.message || '';
      const missing = msg.match(/property '([^']+)' does not exist/i);
      if (missing) {
        const p = missing[1];
        if (!tried.has(p)) { tried.add(p); if (await addMissingColumn(p, log).catch(() => false)) continue; }
        delete payload[p]; continue;
      }
      if (notConfigured(err)) {
        const prov = await ensureHolidayTable(log).catch(() => ({ status: 'unavailable' }));
        if (prov.status === 'unavailable') { const e = new Error('Holiday calendar could not be provisioned. The D365 app registration needs the System Customizer role. ' + (prov.reason || '')); e.status = 503; throw e; }
        continue;
      }
      throw err;
    }
  }
  const e = new Error('Could not save the holiday after schema repair'); e.status = 500; throw e;
}

// GET /api/holidays — the full calendar (any authenticated user).
router.get('/', async (req, res, next) => {
  try { res.json({ data: await holidayService.listHolidays() }); }
  catch (err) { next(err); }
});

// POST /api/holidays — HR adds a holiday.
router.post('/', requireRole('super_admin', 'hr_manager'), async (req, res, next) => {
  try {
    const date = String(req.body.date || '').slice(0, 10);
    const name = String(req.body.name || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'A valid date (YYYY-MM-DD) is required' });
    if (!name) return res.status(400).json({ error: 'Holiday name is required' });

    const created = await robustCreate({ hr_name: name, hr_date: date, hr_description: String(req.body.description || '') });
    await holidayService.refresh(true);   // calculations exclude it immediately
    // NOTE: no activity.record here — the feed derives "Holiday Added" from the
    // table (activity.service.fromHolidays), so recording here too would double it.
    res.status(201).json({ data: { id: created.hr_holidayid, name, date } });
  } catch (err) { if (err.status) return res.status(err.status).json({ error: err.message }); next(err); }
});

// DELETE /api/holidays/:id — HR removes a holiday.
router.delete('/:id', requireRole('super_admin', 'hr_manager'), async (req, res, next) => {
  try {
    await d365.delete(HOL, req.params.id);
    await holidayService.refresh(true);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

module.exports = router;
