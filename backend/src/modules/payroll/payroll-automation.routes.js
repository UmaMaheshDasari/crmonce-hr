const express = require('express');
const router = express.Router();
const { requireRole } = require('../../middleware/auth.middleware');
const automation = require('../../services/payroll-automation.service');

// GET /jobs  — automation run history (most recent first).
router.get('/jobs', requireRole('super_admin', 'hr_manager'), async (req, res, next) => {
  try { res.json({ data: await automation.listJobs({ top: Number(req.query.top) || 50 }) }); }
  catch (err) { next(err); }
});

// GET /jobs/:id  — one job with per-stage status + full processing log.
router.get('/jobs/:id', requireRole('super_admin', 'hr_manager'), async (req, res, next) => {
  try { res.json(await automation.getJob(req.params.id)); }
  catch (err) { res.status(err.status || 404).json({ error: err.message || 'Job not found' }); }
});

// POST /run  — start a new automation run for a month (background; UI polls).
router.post('/run', requireRole('super_admin', 'hr_manager'), async (req, res, next) => {
  try {
    const month = Number(req.body.month), year = Number(req.body.year);
    if (!month || !year) return res.status(400).json({ error: 'month and year are required.' });
    const job = await automation.runJob({ month, year, employeeIds: req.body.employeeIds, user: req.user, trigger: 'manual' });
    res.status(202).json(job);
  } catch (err) {
    console.error('[automation/run] FAILED:', err.message);
    res.status(err.status || 400).json({ error: err.message || 'Failed to start automation' });
  }
});

// POST /jobs/:id/retry  — re-run the failed / incomplete stages of a job.
router.post('/jobs/:id/retry', requireRole('super_admin', 'hr_manager'), async (req, res, next) => {
  try { res.status(202).json(await automation.retryJob({ jobId: req.params.id, user: req.user })); }
  catch (err) {
    console.error('[automation/retry] FAILED:', err.message);
    res.status(err.status || 400).json({ error: err.message || 'Failed to retry job' });
  }
});

// DELETE /jobs/:id  — HR/Super-Admin removes an automation run's history record. Blocked
// once the run's payroll is finalized (Released / salary-credited / Locked). Deletes ONLY
// the job row; never payroll/employee/attendance/leave/comp-off/salary-structure data.
router.delete('/jobs/:id', requireRole('super_admin', 'hr_manager'), async (req, res, next) => {
  try { res.json(await automation.deleteJob({ jobId: req.params.id })); }
  catch (err) {
    console.error('[automation/delete] FAILED:', err.message);
    res.status(err.status || 400).json({ error: err.message || 'Failed to delete automation run' });
  }
});

module.exports = router;
