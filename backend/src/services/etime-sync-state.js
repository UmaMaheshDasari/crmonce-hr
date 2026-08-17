/**
 * Office Sync Agent status (in-memory, per backend process). Powers the HR "eTime sync
 * status" panel — NOT a source of attendance truth (Dataverse is). The agent updates it
 * on every /sync and /heartbeat; the agent is considered ONLINE if it contacted us within
 * ETIME_AGENT_ONLINE_MS (default 15 min).
 */
const ONLINE_WINDOW_MS = Number(process.env.ETIME_AGENT_ONLINE_MS || 15 * 60 * 1000);

const state = {
  lastSyncAt: null,        // last successful /sync (ISO)
  lastAttemptAt: null,     // last agent contact of any kind (ISO)
  lastResult: null,        // stats of the last /sync
  lastPunch: null,         // { etimeCode, date, time } of the last ingested punch
  agent: null,             // { host, pending, failed, version }
  totals: { received: 0, created: 0, updated: 0, duplicates: 0, failed: 0, unmapped: 0 },
};

const nowIso = () => new Date().toISOString();

function recordSync(result = {}, agent) {
  state.lastAttemptAt = nowIso();
  state.lastSyncAt = state.lastAttemptAt;
  state.lastResult = { received: result.received || 0, created: result.created || 0, updated: result.updated || 0, duplicates: result.duplicates || 0, unmapped: result.unmapped || 0, failed: result.failed || 0 };
  if (result.lastPunch) state.lastPunch = result.lastPunch;
  if (agent) state.agent = pickAgent(agent);
  for (const k of Object.keys(state.totals)) state.totals[k] += Number(result[k] || 0);
}

function recordHeartbeat(agent) {
  state.lastAttemptAt = nowIso();
  if (agent) state.agent = pickAgent(agent);
}

function pickAgent(a) {
  return {
    host: String(a.host || a.hostname || '').slice(0, 120),
    pending: Number(a.pending) || 0, failed: Number(a.failed) || 0,
    version: String(a.version || '').slice(0, 40),
    // The agent tells us WHAT it couldn't reach so HR sees a precise message. The agent
    // can only report deviceError while it CAN reach us — if it can't reach us at all,
    // that surfaces here as "offline" (which also covers "HR server unavailable").
    deviceError: !!a.deviceError,
  };
}

function online() {
  const t = Date.parse(state.lastAttemptAt || '');
  return Number.isFinite(t) && (Date.now() - t) <= ONLINE_WINDOW_MS;
}

/** A single machine-readable status the HR UI maps to an exact message. */
function condition() {
  if (!online()) return 'offline';                       // agent process down OR agent can't reach the HR server
  if (state.agent && state.agent.deviceError) return 'device_unavailable';   // agent up, ZK device unreachable
  return 'ok';
}

/** Safe snapshot for the HR UI — no secrets, no internal errors. */
function snapshot() {
  return {
    online: online(),
    condition: condition(),
    lastSyncAt: state.lastSyncAt,
    lastAttemptAt: state.lastAttemptAt,
    lastResult: state.lastResult,
    lastPunch: state.lastPunch,
    agent: state.agent,
    totals: state.totals,
  };
}

module.exports = { recordSync, recordHeartbeat, online, snapshot, ONLINE_WINDOW_MS };
