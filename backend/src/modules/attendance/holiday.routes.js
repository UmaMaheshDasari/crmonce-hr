/**
 * HR Holiday Calendar API. Everyone can read; only HR / Super Admin can add or
 * remove. Adding a holiday refreshes attendance.config so calculations exclude it
 * immediately, and records a "Holiday Added" activity.
 */
const express = require('express');
const router = express.Router();
const d365 = require('../../services/d365.service');
const { requireRole, requireAnyPermission } = require('../../middleware/auth.middleware');
const holidayService = require('../../services/holiday.service');
const { ensureHolidayTable, addMissingColumn } = require('../../services/provision-holiday');
let activity; try { activity = require('../../services/activity.service'); } catch (_) { activity = null; }
const audit = (p) => { try { activity?.record?.(p); } catch (_) {} };

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

// POST /api/holidays — HR adds a holiday (including historical / past dates).
router.post('/', requireAnyPermission('attendance.edit'), async (req, res, next) => {
  try {
    const date = String(req.body.date || '').slice(0, 10);
    const name = String(req.body.name || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'A valid date (YYYY-MM-DD) is required' });
    if (!name) return res.status(400).json({ error: 'Holiday name is required' });

    // Duplicate-date guard (validation): warn unless overwrite is explicitly set.
    const existing = await holidayService.listHolidays().catch(() => []);
    if (!req.body.overwrite && existing.some(h => h.date === date)) {
      return res.status(409).json({ error: `A holiday already exists on ${date}.`, duplicate: true });
    }

    const created = await robustCreate({
      hr_name: name, hr_date: date, hr_description: String(req.body.description || ''),
      hr_type: String(req.body.type || ''), hr_department: String(req.body.department || ''),
      hr_status: String(req.body.status || 'active'), hr_remarks: String(req.body.remarks || ''),
    });
    await holidayService.refresh(true);   // calculations exclude it immediately
    audit({ category: 'Holiday', type: 'holiday_added', title: 'Holiday added', name, meta: { date, type: req.body.type || '', by: req.user?.name } });
    res.status(201).json({ data: { id: created.hr_holidayid, name, date } });
  } catch (err) { if (err.status) return res.status(err.status).json({ error: err.message }); next(err); }
});

// PUT /api/holidays/:id — HR edits a holiday (name/date/type/department/status/remarks).
router.put('/:id', requireAnyPermission('attendance.edit'), async (req, res, next) => {
  try {
    const patch = {};
    if (req.body.name !== undefined) patch.hr_name = String(req.body.name).trim();
    if (req.body.date !== undefined) patch.hr_date = String(req.body.date).slice(0, 10);
    if (req.body.description !== undefined) patch.hr_description = String(req.body.description || '');
    if (req.body.type !== undefined) patch.hr_type = String(req.body.type || '');
    if (req.body.department !== undefined) patch.hr_department = String(req.body.department || '');
    if (req.body.status !== undefined) patch.hr_status = String(req.body.status || 'active');
    if (req.body.remarks !== undefined) patch.hr_remarks = String(req.body.remarks || '');
    // Strip any not-yet-provisioned column and retry so an edit never hard-fails.
    let payload = { ...patch };
    for (let i = 0; i < 8; i++) {
      try { await d365.update(HOL, req.params.id, payload); break; }
      catch (err) {
        const missing = (err.message || '').match(/property '([^']+)' does not exist/i);
        if (missing && payload[missing[1]] !== undefined) { await addMissingColumn(missing[1], global.logger || console).catch(() => {}); delete payload[missing[1]]; continue; }
        throw err;
      }
    }
    await holidayService.refresh(true);
    audit({ category: 'Holiday', type: 'holiday_updated', title: 'Holiday updated', name: patch.hr_name || '', meta: { id: req.params.id, by: req.user?.name } });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// DELETE /api/holidays/:id — HR removes a holiday.
router.delete('/:id', requireAnyPermission('attendance.edit'), async (req, res, next) => {
  try {
    await d365.delete(HOL, req.params.id);
    await holidayService.refresh(true);
    audit({ category: 'Holiday', type: 'holiday_removed', title: 'Holiday removed', meta: { id: req.params.id, by: req.user?.name } });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

module.exports = router;
