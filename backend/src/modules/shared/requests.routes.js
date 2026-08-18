/**
 * Shared Request Lifecycle API — mounted at /api/requests.
 *
 * ONE generic surface for every request module (Leave, Late Login, Attendance
 * Correction, Comp Off, Document, and future modules). The :type segment selects
 * the registered adapter; all status rules, audit and notifications live in
 * request-lifecycle.service.js — routes here are thin.
 *
 *   GET    /:type/:id                     canonical status + allowed actions
 *   GET    /:type/:id/audit               lifecycle audit trail (owner or HR)
 *   DELETE /:type/:id                     permanent delete (pending/rejected)
 *   POST   /:type/:id/resubmit            edit & resubmit (rejected → new cycle)
 *   POST   /:type/:id/cancellation        request cancellation (approved)
 *   PATCH  /:type/:id/cancellation/manager   manager decision
 *   PATCH  /:type/:id/cancellation/hr         HR decision (HR only)
 *   GET    /cancellations                 pending cancellation queue (HR)
 */
const express = require('express');
const router = express.Router();
const { requireRole } = require('../../middleware/auth.middleware');
const lifecycle = require('../../services/request-lifecycle.service');
require('../../services/request-adapters');   // registers all module adapters

const HR = ['super_admin', 'hr_manager'];
const isHR = (u) => HR.includes(u.role);

// Pending cancellation queue (HR review surface). Must be BEFORE '/:type/:id'.
router.get('/cancellations', requireRole(...HR), async (req, res, next) => {
  try { res.json({ data: await lifecycle.listCancellations({ status: req.query.status || 'pending' }) }); }
  catch (err) { next(err); }
});

// Canonical status + capabilities (owner or HR).
router.get('/:type/:id', async (req, res, next) => {
  try {
    const v = await lifecycle.view({ type: req.params.type, id: req.params.id });
    if (!isHR(req.user) && v.ownerId !== req.user.id) return res.status(403).json({ error: 'Access denied' });
    res.json({
      type: req.params.type, id: req.params.id, status: v.canonical,
      summary: v.summary, cancellation: v.cancellation,
      capabilities: {
        canEdit: v.adapter.canEdit !== false && v.canonical === 'pending',
        canDelete: v.adapter.canDelete !== false && ['pending', 'rejected'].includes(v.canonical),
        canResubmit: v.adapter.canResubmit !== false && v.canonical === 'rejected',
        // Also gated by the adapter's eligibility rule (Leave: date + Present-attendance).
        canRequestCancellation: v.adapter.canCancel !== false && ['approved', 'manager_approved'].includes(v.canonical) && !v.cancellation && (v.cancelEligibility?.ok !== false),
        // Reason to show when cancellation is blocked by the rule (tooltip).
        cancelReason: v.cancelEligibility && v.cancelEligibility.ok === false ? v.cancelEligibility.reason : undefined,
      },
    });
  } catch (err) { if (err.status) return res.status(err.status).json({ error: err.message }); next(err); }
});

router.get('/:type/:id/audit', async (req, res, next) => {
  try {
    const v = await lifecycle.view({ type: req.params.type, id: req.params.id });
    if (!isHR(req.user) && v.ownerId !== req.user.id) return res.status(403).json({ error: 'Access denied' });
    res.json({ data: await lifecycle.getAudit({ type: req.params.type, id: req.params.id }) });
  } catch (err) { if (err.status) return res.status(err.status).json({ error: err.message }); next(err); }
});

router.delete('/:type/:id', async (req, res, next) => {
  try { res.json(await lifecycle.remove({ type: req.params.type, id: req.params.id, user: req.user })); }
  catch (err) { if (err.status) return res.status(err.status).json({ error: err.message }); next(err); }
});

// Edit a PENDING request in place (owner only). 2-segment path — never collides with
// the 4-segment cancellation PATCH routes below.
router.patch('/:type/:id', async (req, res, next) => {
  try { res.json(await lifecycle.edit({ type: req.params.type, id: req.params.id, edits: req.body?.edits || {}, user: req.user })); }
  catch (err) { if (err.status) return res.status(err.status).json({ error: err.message }); next(err); }
});

router.post('/:type/:id/resubmit', async (req, res, next) => {
  try { res.json(await lifecycle.resubmit({ type: req.params.type, id: req.params.id, edits: req.body?.edits || {}, user: req.user })); }
  catch (err) { if (err.status) return res.status(err.status).json({ error: err.message }); next(err); }
});

router.post('/:type/:id/cancellation', async (req, res, next) => {
  try { res.json(await lifecycle.requestCancellation({ type: req.params.type, id: req.params.id, reason: req.body?.reason, user: req.user })); }
  catch (err) { if (err.status) return res.status(err.status).json({ error: err.message }); next(err); }
});

// Manager step — mirrors the existing per-module manager routes (no extra role gate;
// the manager acts, HR may also act). HR finalises via the /hr route below.
router.patch('/:type/:id/cancellation/manager', async (req, res, next) => {
  try {
    const action = req.body?.action === 'rejected' ? 'rejected' : 'approved';
    res.json(await lifecycle.cancellationManagerDecide({ type: req.params.type, id: req.params.id, action, approver: req.user, remarks: req.body?.remarks }));
  } catch (err) { if (err.status) return res.status(err.status).json({ error: err.message }); next(err); }
});

router.patch('/:type/:id/cancellation/hr', requireRole(...HR), async (req, res, next) => {
  try {
    const action = req.body?.action === 'rejected' ? 'rejected' : 'approved';
    res.json(await lifecycle.cancellationHrDecide({ type: req.params.type, id: req.params.id, action, approver: req.user, remarks: req.body?.remarks }));
  } catch (err) { if (err.status) return res.status(err.status).json({ error: err.message }); next(err); }
});

module.exports = router;
