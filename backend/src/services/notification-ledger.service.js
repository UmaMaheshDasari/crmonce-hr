/**
 * Notification Ledger — the ONE idempotency + audit layer for informational emails
 * that a recurring process could otherwise send many times (§8–§11, §17).
 *
 * Logical key = `${employeeId}|${date}|${type}` (e.g. EMP1039|2026-08-10|MISSING_PUNCH).
 * sendOnce():
 *   1. if the key was already recorded 'sent' → SKIP (no duplicate).
 *   2. else send via notification.service.sendEmail.
 *   3. record 'sent' ONLY on Graph success; on failure record 'failed' (+error) so
 *      it can be retried later WITHOUT ever duplicating a successful send (§11).
 *
 * Storage is the self-provisioned `hr_notificationlogs` table. The store is
 * injectable (setStore) so the dedupe logic is unit-tested with an in-memory store
 * and the notification test transport — no network, no Dataverse.
 */
const d365 = require('./d365.service');
const notification = require('./notification.service');
const { ensureNotificationLogTable, LOG_SET } = require('./provision-notification-log');

const SET = LOG_SET; // 'hr_notificationlogs'
const esc = (v) => String(v ?? '').replace(/'/g, "''");
const iso = () => new Date().toISOString();
const dstr = (d) => String(d ?? '').slice(0, 10);
const keyOf = (employeeId, date, type) => `${employeeId}|${dstr(date)}|${type}`;
const ccStr = (cc) => (Array.isArray(cc) ? cc.map(c => (typeof c === 'string' ? c : c?.email)).filter(Boolean).join(',') : String(cc || ''));

// ── Dataverse-backed store (default) ──────────────────────────────────────────
let _ensured = false;
async function ensureTable() {
  if (_ensured) return true;
  try { await d365.getList(SET, { top: 1 }); _ensured = true; return true; }
  catch (_) {
    try { const r = await ensureNotificationLogTable(global.logger || console); _ensured = (r.status === 'created' || r.status === 'exists'); }
    catch { _ensured = false; }
    return _ensured;
  }
}

// A pending claim older than this is treated as abandoned (a crashed/lost sender), so
// it never permanently blocks a later legitimate retry of the same (employee,date,type).
const CLAIM_TTL_MS = 2 * 60 * 1000;
const ageMs = (isoStr) => { const t = Date.parse(isoStr || ''); return Number.isFinite(t) ? (Date.parse(iso()) - t) : Infinity; };

const d365Store = {
  async hasSent(employeeId, date, type) {
    try {
      const { data } = await d365.getList(SET, {
        select: 'hr_notificationlogid,hr_status',
        filter: `hr_key eq '${esc(keyOf(employeeId, date, type))}' and hr_status eq 'sent'`, top: 1,
      });
      return !!(data && data[0]);
    } catch { return false; }   // can't confirm → allow the send (never permanently suppress)
  },

  /**
   * Atomically-as-possible RESERVE the (employee,date,type) slot BEFORE the email is
   * sent, so two backend processes (PM2 instances) racing the SAME event cannot both
   * send. Dataverse has no unique constraint here, so we insert a 'pending' marker and
   * arbitrate DETERMINISTICALLY by row GUID: every racer sees the same rows and picks
   * the same lowest-GUID winner. FAIL-OPEN — any ledger error returns won:true so a
   * genuine notice is never suppressed (a rare duplicate is safer than a lost email).
   * @returns {Promise<{won:boolean, id:string|null}>}
   */
  async claim(rec) {
    const key = keyOf(rec.employeeId, rec.date, rec.type);
    let mineId = null;
    try {
      const created = await d365.create(SET, {
        hr_name: `${rec.type} · ${rec.employeeId} · ${dstr(rec.date)}`.slice(0, 250),
        hr_key: key, hr_employeeid: String(rec.employeeId || ''), hr_date: dstr(rec.date), hr_type: rec.type,
        hr_status: 'pending', hr_to: String(rec.to || '').slice(0, 300), hr_cc: ccStr(rec.cc).slice(0, 400),
        hr_subject: String(rec.subject || '').slice(0, 300), hr_entity: rec.entity || '', hr_requestid: rec.requestId || '',
        hr_attemptedat: iso(),
      });
      mineId = created?.hr_notificationlogid || null;
    } catch (e) { global.logger?.warn?.(`[notif-ledger] claim insert failed (fail-open): ${e.message}`); return { won: true, id: null }; }
    if (!mineId) return { won: true, id: null };   // couldn't read our own id → fail open
    try {
      const { data } = await d365.getList(SET, {
        select: 'hr_notificationlogid,hr_status,hr_attemptedat',
        filter: `hr_key eq '${esc(key)}' and (hr_status eq 'pending' or hr_status eq 'sent')`, top: 50,
      });
      const rows = data || [];
      if (rows.some(r => r.hr_status === 'sent')) { await this._drop(mineId); return { won: false, id: mineId }; }
      // Live competitors = my row + any OTHER fresh pending claim; stale pendings ignored.
      const live = rows.filter(r => r.hr_notificationlogid === mineId || ageMs(r.hr_attemptedat) <= CLAIM_TTL_MS);
      const winner = live.map(r => r.hr_notificationlogid).filter(Boolean).sort()[0];
      if (winner === mineId) return { won: true, id: mineId };
      await this._drop(mineId);
      return { won: false, id: mineId };
    } catch (e) { global.logger?.warn?.(`[notif-ledger] claim arbitrate failed (fail-open): ${e.message}`); return { won: true, id: mineId }; }
  },

  /** Turn the winner's pending claim into the terminal sent/failed record. */
  async finalize(id, rec) {
    if (!id) return this.record(rec);
    try {
      await d365.update(SET, id, {
        hr_status: rec.status, hr_error: rec.error ? String(rec.error).slice(0, 4000) : '',
        ...(rec.status === 'sent' ? { hr_sentat: iso() } : {}),
      });
    } catch (e) { global.logger?.warn?.(`[notif-ledger] finalize failed: ${e.message}`); await this.record(rec); }
  },

  async _drop(id) { try { await d365.delete(SET, id); } catch (_) { /* stale pending self-expires via CLAIM_TTL_MS */ } },

  async record(rec) {
    try {
      await d365.create(SET, {
        hr_name: `${rec.type} · ${rec.employeeId} · ${dstr(rec.date)}`.slice(0, 250),
        hr_key: keyOf(rec.employeeId, rec.date, rec.type),
        hr_employeeid: String(rec.employeeId || ''), hr_date: dstr(rec.date), hr_type: rec.type,
        hr_status: rec.status, hr_to: String(rec.to || '').slice(0, 300), hr_cc: ccStr(rec.cc).slice(0, 400),
        hr_subject: String(rec.subject || '').slice(0, 300), hr_entity: rec.entity || '', hr_requestid: rec.requestId || '',
        hr_attemptedat: iso(), ...(rec.status === 'sent' ? { hr_sentat: iso() } : {}),
        hr_error: rec.error ? String(rec.error).slice(0, 4000) : '',
      });
    } catch (e) { global.logger?.warn?.(`[notif-ledger] record failed: ${e.message}`); }
  },
};

let store = d365Store;
/** Inject a custom store (tests). Pass nothing to restore the Dataverse store. */
function setStore(s) { store = s || d365Store; }

// In-process serialization per event key. Two overlapping sends of the SAME logical
// event in this process (e.g. a cron run + a manual "Run Now") must not both pass the
// hasSent check and double-send — the second waits for the first, then sees it
// recorded and skips. (Cross-process duplication is prevented by running the scheduler
// in ONE process — see jobs/index.isSchedulerInstance.)
const _inflight = new Map();   // key → Promise

/**
 * Send an informational email AT MOST ONCE per (employeeId, date, type).
 * @returns {Promise<{sent?:boolean, skipped?:boolean, reason?:string, error?:string}>}
 */
async function sendOnce(opts) {
  if (!opts.to) return { skipped: true, reason: 'no_recipient' };
  const key = keyOf(opts.employeeId, opts.date, opts.type);
  while (_inflight.has(key)) { await _inflight.get(key).catch(() => {}); }   // await any in-flight same-key send
  const run = _sendOnce(opts, key);
  _inflight.set(key, run);
  try { return await run; }
  finally { if (_inflight.get(key) === run) _inflight.delete(key); }
}

async function _sendOnce({ employeeId, date, type, to, cc, subject, html, from, attachments, requestId, entity }, key) {
  if (store === d365Store) await ensureTable();

  // 1) Fast path: a prior SUCCESSFUL send for this key → never duplicate.
  if (await store.hasSent(employeeId, date, type)) {
    global.logger?.info?.(`[notif-ledger] duplicate suppressed: ${key} → ${to}`);
    return { skipped: true, reason: 'already_sent' };
  }

  // 2) Cross-process guard: claim the slot BEFORE sending so two PM2 instances racing
  //    the same event yield exactly ONE winner (see store.claim). Stores without claim
  //    fall back to the legacy record-after-send path (still at-most-once via hasSent).
  let claimId;
  if (typeof store.claim === 'function') {
    const c = await store.claim({ employeeId, date, type, to, cc, subject, requestId, entity });
    if (!c.won) {
      global.logger?.info?.(`[notif-ledger] duplicate suppressed (lost claim): ${key} → ${to}`);
      return { skipped: true, reason: 'already_claimed' };
    }
    claimId = c.id;
  }

  const r = await notification.sendEmail(to, subject, html, { from, cc, attachments, meta: { type } });
  const ok = !!r?.success;
  const rec = { employeeId, date, type, status: ok ? 'sent' : 'failed', to, cc, subject, error: ok ? '' : (r?.error || 'send failed'), requestId, entity };
  // Record 'sent' ONLY after the email service accepted it (never before). The winner's
  // pending claim becomes the terminal record; a failure stays retryable (not 'sent').
  if (typeof store.finalize === 'function') await store.finalize(claimId, rec);
  else await store.record(rec);
  return ok ? { sent: true } : { sent: false, error: r?.error || 'send failed' };
}

module.exports = { sendOnce, keyOf, setStore, SET };
