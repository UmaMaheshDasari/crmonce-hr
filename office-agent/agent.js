#!/usr/bin/env node
/**
 * CRMONCE HR — Office eTime Sync Agent
 * ------------------------------------
 * Runs on an OFFICE Windows PC/server that can reach the ZK/eTime device on the LAN
 * (e.g. 192.168.1.199:4370). It reads punches from the device and pushes them to the
 * production HR backend over HTTPS. The VPS never connects to the office LAN.
 *
 *   ZK device (LAN) → THIS agent → HTTPS → https://hr.crmonce.com/api/etime/sync → Dataverse
 *
 * Robust by design:
 *   - Local disk SPOOL (spool.json): punches are queued before sending; nothing is lost
 *     if the internet or the VPS is temporarily down. Sent punches are removed on success.
 *   - IDEMPOTENT: punches are keyed by etimeCode|date|time; the backend also de-dupes, so
 *     re-sending the same punch is a no-op (one attendance record only).
 *   - IST-safe: date/time are read as the device's LOCAL wall-clock (the office PC must be
 *     on IST) — never converted to UTC, so a 00:30 IST punch keeps its own date.
 *   - Retries every cycle; heartbeats so HR can see the agent is online.
 *
 * Secrets come from environment / .env only (see .env.example). Nothing is hardcoded.
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const os = require('os');
const axios = require('axios');
const ZKLib = require('zklib-js');

const CFG = {
  apiUrl: (process.env.HR_API_URL || '').replace(/\/$/, ''),      // e.g. https://hr.crmonce.com
  agentKey: process.env.ETIME_AGENT_KEY || '',
  deviceIp: process.env.ZK_DEVICE_IP || '192.168.1.199',
  devicePort: parseInt(process.env.ZK_DEVICE_PORT || '4370', 10),
  deviceTimeout: parseInt(process.env.ZK_TIMEOUT || '10000', 10),
  intervalMs: parseInt(process.env.SYNC_INTERVAL_MS || '60000', 10),   // pull+push cycle
  batchSize: parseInt(process.env.SYNC_BATCH_SIZE || '500', 10),
  spoolFile: process.env.SPOOL_FILE || path.join(__dirname, 'spool.json'),
  // BACKFILL controls: run one cycle then exit, and/or only sync a date window
  // (YYYY-MM-DD inclusive). Use these to pull the punches missed during the outage.
  runOnce: /^(1|true|yes)$/i.test(process.env.RUN_ONCE || ''),
  fromDate: (process.env.SYNC_FROM_DATE || '').trim(),
  toDate: (process.env.SYNC_TO_DATE || '').trim(),
  version: '1.1.0',
};

if (!CFG.apiUrl || !CFG.agentKey) {
  console.error('[agent] HR_API_URL and ETIME_AGENT_KEY are required (see .env.example). Exiting.');
  process.exit(1);
}

const pad = (n) => String(n).padStart(2, '0');
const log = (level, msg) => console.log(`${new Date().toISOString()} [${level}] ${msg}`);
const keyOf = (p) => `${p.etimeCode}|${p.date}|${p.time}`;

// ── local spool (survives restarts) ──
function loadSpool() {
  try { const arr = JSON.parse(fs.readFileSync(CFG.spoolFile, 'utf8')); return Array.isArray(arr) ? arr : []; }
  catch { return []; }
}
function saveSpool(arr) {
  try { fs.writeFileSync(CFG.spoolFile, JSON.stringify(arr), 'utf8'); }
  catch (e) { log('WARN', `could not persist spool: ${e.message}`); }
}
let spool = loadSpool();
const spooled = new Set(spool.map(keyOf));

// ── device read ──
async function readDevicePunches() {
  const zk = new ZKLib(CFG.deviceIp, CFG.devicePort, CFG.deviceTimeout, 4000);
  try {
    await zk.createSocket();
    const res = await zk.getAttendances();
    await zk.disconnect().catch(() => {});
    const rows = res?.data || [];
    const out = [];
    for (const r of rows) {
      if (!r.recordTime) continue;
      const d = new Date(r.recordTime);                    // device local time = office PC (IST) clock
      if (Number.isNaN(d.getTime())) continue;
      out.push({
        etimeCode: String(r.deviceUserId ?? r.userId ?? '').trim(),
        date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,   // IST civil date
        time: `${pad(d.getHours())}:${pad(d.getMinutes())}`,                       // IST civil time
      });
    }
    // Optional backfill window (inclusive) — pull only the outage period.
    const inRange = (dt) => (!CFG.fromDate || dt >= CFG.fromDate) && (!CFG.toDate || dt <= CFG.toDate);
    return out.filter((p) => inRange(p.date));
  } catch (err) {
    try { await zk.disconnect(); } catch (_) {}
    throw new Error(`ZK device ${CFG.deviceIp}:${CFG.devicePort} unavailable: ${err.message || err.code || 'connection failed'}`);
  }
}

// ── backend push ──
async function pushBatch(batch, pending) {
  const body = {
    punches: batch,
    deviceId: `${CFG.deviceIp}`,
    agent: { host: os.hostname(), pending, failed: 0, version: CFG.version },
  };
  const { data } = await axios.post(`${CFG.apiUrl}/api/etime/sync`, body, {
    headers: { 'x-etime-agent-key': CFG.agentKey },
    timeout: 30000,
  });
  return data;
}
async function heartbeat(pending, extra = {}) {
  try {
    await axios.post(`${CFG.apiUrl}/api/etime/heartbeat`,
      { agent: { host: os.hostname(), pending, version: CFG.version, ...extra } },
      { headers: { 'x-etime-agent-key': CFG.agentKey }, timeout: 15000 });
  } catch (_) { /* heartbeat is best-effort */ }
}

// ── one cycle: read device → spool → push spool in batches ──
let running = false;
async function cycle() {
  if (running) return;
  running = true;
  let deviceRead = false;
  try {
    // 1) Read the device (if reachable) and add NEW punches to the spool.
    try {
      const punches = await readDevicePunches();
      deviceRead = true;
      let added = 0;
      for (const p of punches) {
        if (!p.etimeCode) continue;
        const k = keyOf(p);
        if (!spooled.has(k)) { spooled.add(k); spool.push(p); added++; }
      }
      if (added) { saveSpool(spool); log('INFO', `read device: +${added} new punch(es), spool=${spool.length}`); }
    } catch (e) {
      log('WARN', e.message);                 // device down — keep going, we still flush the spool
      await heartbeat(spool.length, { deviceError: true });
    }

    // 2) Flush the spool to the backend in batches; drop only what the server accepted.
    while (spool.length) {
      const batch = spool.slice(0, CFG.batchSize);
      let res;
      try {
        res = await pushBatch(batch, spool.length);
      } catch (e) {
        const status = e.response?.status;
        log('WARN', `backend unreachable/failed (${status || e.code || 'network'}): keeping ${spool.length} punch(es) spooled`);
        await heartbeat(spool.length, { backendError: true });
        break;                                // try again next cycle — nothing lost
      }
      // Server processed the batch (created/updated/duplicate/unmapped/failed all mean
      // "received & handled"); it is idempotent, so remove the batch from the spool.
      spool = spool.slice(batch.length);
      for (const p of batch) spooled.delete(keyOf(p));
      saveSpool(spool);
      log('INFO', `pushed ${batch.length} → received ${res.received}, created ${res.created}, updated ${res.updated}, dup ${res.duplicates}, unmapped ${res.unmapped}, failed ${res.failed}; spool=${spool.length}`);
    }
    await heartbeat(spool.length);

    // Backfill mode: run one cycle then exit with a clear status.
    if (CFG.runOnce) {
      if (!deviceRead) { log('ERROR', 'RUN_ONCE aborted: the ZK device could not be read (check LAN/IP).'); process.exit(2); }
      if (spool.length === 0) { log('INFO', 'RUN_ONCE complete: all fetched punches were pushed (missing days backfilled; duplicates skipped by the server).'); process.exit(0); }
      log('WARN', `RUN_ONCE: ${spool.length} punch(es) still spooled (backend issue) — re-run to finish; nothing lost.`); process.exit(1);
    }
  } finally {
    running = false;
  }
}

const windowNote = (CFG.fromDate || CFG.toDate) ? ` | window ${CFG.fromDate || '…'}→${CFG.toDate || '…'}` : '';
const modeNote = CFG.runOnce ? ' | RUN_ONCE (backfill)' : ` | every ${CFG.intervalMs}ms`;
log('INFO', `Office eTime Sync Agent v${CFG.version} → ${CFG.apiUrl} | device ${CFG.deviceIp}:${CFG.devicePort}${modeNote}${windowNote} | spool=${spool.length}`);
cycle();
if (!CFG.runOnce) setInterval(cycle, CFG.intervalMs);   // continuous mode; RUN_ONCE exits inside cycle()
process.on('SIGINT', () => { saveSpool(spool); log('INFO', 'stopped'); process.exit(0); });
process.on('SIGTERM', () => { saveSpool(spool); process.exit(0); });
