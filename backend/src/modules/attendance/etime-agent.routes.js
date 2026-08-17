/**
 * Office Sync Agent API — mounted at /api/etime WITHOUT the login-JWT middleware. The
 * office agent is not a logged-in user; it authenticates with a shared secret
 * (ETIME_AGENT_KEY) sent as the `x-etime-agent-key` header. This is the ONLY entry point
 * for device punches; the VPS never connects to the office LAN device.
 *
 * Endpoints:
 *   POST /api/etime/sync       — batch of punches → idempotent Dataverse upsert → stats
 *   POST /api/etime/heartbeat  — liveness ping (online status, pending/failed counts)
 *
 * Security: agent-key auth + payload validation + per-punch employee mapping. Internal /
 * Dataverse errors are never returned to the client.
 */
const express = require('express');
const router = express.Router();
const ingest = require('../../services/etime-ingest.service');
const syncState = require('../../services/etime-sync-state');
let activity; try { activity = require('../../services/activity.service'); } catch (_) { activity = null; }

// ── agent authentication (shared secret; NOT a user JWT) ──
function requireAgentKey(req, res, next) {
  const expected = process.env.ETIME_AGENT_KEY;
  if (!expected) return res.status(503).json({ error: 'eTime sync is not configured on the server.' });   // never allow when unset
  const key = req.get('x-etime-agent-key') || req.body?.agentKey;
  if (!key || String(key) !== String(expected)) return res.status(401).json({ error: 'Invalid agent key' });
  next();
}
router.use(requireAgentKey);

// Max punches per batch (protects the server from an oversized payload).
const MAX_BATCH = Number(process.env.ETIME_MAX_BATCH || 2000);

// POST /api/etime/sync — { punches:[{etimeCode,date,time}], agent?:{host,pending,failed,version}, deviceId? }
router.post('/sync', async (req, res, next) => {
  try {
    const punches = req.body?.punches;
    if (!Array.isArray(punches)) return res.status(400).json({ error: 'punches[] is required' });
    if (punches.length > MAX_BATCH) return res.status(413).json({ error: `Too many punches in one batch (max ${MAX_BATCH}).` });

    const stats = await ingest.ingestPunches(punches, { deviceId: req.body?.deviceId });
    syncState.recordSync(stats, req.body?.agent);
    try {
      activity?.record?.({ category: 'Biometric', type: 'sync_completed', title: 'eTime Sync (Office Agent)', name: '',
        meta: `received ${stats.received}, created ${stats.created}, updated ${stats.updated}, dup ${stats.duplicates}, unmapped ${stats.unmapped}, failed ${stats.failed}` });
    } catch (_) {}

    // Stable response contract for the agent + the HR UI (no internal error detail).
    res.json({
      success: true,
      received: stats.received, created: stats.created, updated: stats.updated,
      duplicates: stats.duplicates, unmapped: stats.unmapped, failed: stats.failed,
    });
  } catch (err) {
    global.logger?.error?.(`[etime-agent] sync failed: ${err.message}`);
    res.status(500).json({ success: false, error: 'Sync failed on the server.' });   // no internal detail
  }
});

// POST /api/etime/heartbeat — { agent:{host,pending,failed,version} }
router.post('/heartbeat', (req, res) => {
  syncState.recordHeartbeat(req.body?.agent);
  res.json({ ok: true, onlineWindowMs: syncState.ONLINE_WINDOW_MS });
});

module.exports = router;
