/**
 * INTERIM durable run-history for the Late Login scanner + reconciler.
 *
 * Append-only JSON Lines on the SINGLE SCHEDULER HOST's filesystem — it is NOT replicated and is
 * only as durable as that host's disk (ephemeral/containerised filesystems lose it on redeploy).
 * It exists so HR/ops can see whether the nightly jobs ran, and their status/counters, until a
 * durable Dataverse-backed run table is approved.
 *
 * Safety: every write is best-effort and wrapped — a history failure NEVER throws into the
 * scheduler and NEVER affects a policy decision. Records carry ONLY run metadata + counts (no
 * employee identifiers, names, tokens, or secrets). Entries are append-only; growth is bounded by
 * a simple size-based rotation keeping a small number of backups.
 */
const fs = require('fs');
const path = require('path');

// Config-gated. Default directory is resolved from cwd; override with LATE_LOGIN_RUN_HISTORY_DIR.
// Disable entirely with LATE_LOGIN_RUN_HISTORY=false.
const DIR = path.resolve(process.env.LATE_LOGIN_RUN_HISTORY_DIR || './run-history');
const FILE = path.join(DIR, 'late-login-runs.jsonl');
const MAX_BACKUPS = 2;   // runs.jsonl.1, runs.jsonl.2
// Rotation threshold (bytes), read dynamically so it is configurable/testable. Default ~5 MB, 1 KB floor.
const maxBytes = () => Math.max(1024, Number(process.env.LATE_LOGIN_RUN_HISTORY_MAX_BYTES) || 5 * 1024 * 1024);
const STORE_LABEL = 'jsonl (single-host, not replicated)';

function featureOff() { return process.env.LATE_LOGIN_RUN_HISTORY === 'false'; }

// Ensure the directory exists; return false (disabled) if it cannot be created/written.
let _ready = null;
function ensureReady() {
  if (featureOff()) return false;
  if (_ready !== null) return _ready;
  try { fs.mkdirSync(DIR, { recursive: true }); _ready = true; }
  catch (e) { _ready = false; global.logger?.warn?.(`[late-login-runhistory] disabled — cannot create ${STORE_LABEL} dir: ${e.message}`); }
  return _ready;
}

const uid = (jobType) => `${jobType}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

// Build a sanitized, PII-free record. Only metadata + numeric counters.
function shape({ jobType, trigger, startedAt, finishedAt, status, window, counters, truncated, partial, errorCount } = {}) {
  return {
    runId: uid(jobType || 'run'),
    jobType: jobType === 'reconciler' ? 'reconciler' : 'scanner',
    trigger: trigger || 'scheduler',
    instance: String(process.env.NODE_APP_INSTANCE ?? ''),
    pid: process.pid,
    startedAt: startedAt || null,
    finishedAt: finishedAt || new Date().toISOString(),
    status: ['success', 'partial', 'failed'].includes(status) ? status : 'success',
    window: window && (window.from || window.to) ? { from: window.from || null, to: window.to || null } : null,
    counters: counters && typeof counters === 'object' ? counters : {},
    truncated: !!truncated,
    partial: !!partial,
    errorCount: Number(errorCount) || 0,
  };
}

// Rotate when the file grows beyond MAX_BYTES (best-effort; append-only within a file).
function rotateIfNeeded() {
  try {
    const st = fs.statSync(FILE);
    if (st.size < maxBytes()) return;
    for (let i = MAX_BACKUPS; i >= 1; i--) {
      const src = i === 1 ? FILE : `${FILE}.${i - 1}`;
      const dst = `${FILE}.${i}`;
      if (fs.existsSync(src)) { try { fs.renameSync(src, dst); } catch { /* ignore */ } }
    }
  } catch { /* no file yet, or stat failed → nothing to rotate */ }
}

/** Append ONE run record. Best-effort; never throws. Returns the record (or null if not written). */
function record(run) {
  try {
    if (!ensureReady()) return null;
    const rec = shape(run);
    rotateIfNeeded();
    fs.appendFileSync(FILE, JSON.stringify(rec) + '\n');
    return rec;
  } catch (e) {
    global.logger?.warn?.(`[late-login-runhistory] write skipped (non-fatal): ${e.message}`);
    return null;
  }
}

/** Read recent runs newest-first. Skips malformed lines safely. Never throws. */
function list({ limit = 100, jobType, status } = {}) {
  const cap = Math.min(500, Math.max(1, Math.trunc(Number(limit) || 100)));
  if (featureOff()) return { available: false, store: STORE_LABEL, runs: [], note: 'Run history disabled (LATE_LOGIN_RUN_HISTORY=false).' };
  let text = '';
  try {
    if (fs.existsSync(FILE)) text = fs.readFileSync(FILE, 'utf8');
  } catch (e) {
    return { available: false, store: STORE_LABEL, runs: [], note: `Run-history file unreadable on this host: ${e.message}` };
  }
  const runs = [];
  let malformed = 0;
  for (const line of text.split('\n')) {
    const s = line.trim();
    if (!s) continue;
    try {
      const r = JSON.parse(s);
      if (jobType && r.jobType !== jobType) continue;
      if (status && r.status !== status) continue;
      runs.push(r);
    } catch { malformed++; }   // skip a corrupt/partial line — never abort the read
  }
  runs.reverse();   // newest first
  return {
    available: true,
    store: STORE_LABEL,
    note: 'Interim single-host store; not replicated and only as durable as this host\'s filesystem. Not a substitute for a durable run-history table.',
    malformedSkipped: malformed,
    total: runs.length,
    runs: runs.slice(0, cap),
  };
}

module.exports = { record, list, shape, ensureReady, STORE_LABEL, FILE, DIR };
