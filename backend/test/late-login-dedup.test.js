/**
 * Late Login email — ONE email per (employee, attendance date, LATE_LOGIN), enforced
 * by a PERSISTENT, cross-process claim in the notification ledger (§8–§11, req #10).
 *
 * The Dataverse `hr_notificationlogs` table is modelled here as a shared in-memory
 * "DB" (an array). A backend "process" is one store instance over that DB — two
 * processes share the DB but each has its own in-process lock, exactly like two PM2
 * instances. This lets us assert: same event twice → 1 email; restart → not resent;
 * two processes racing → 1 email; next day → new email; send failure → retryable.
 *
 * No network: the notification transport is the in-memory outbox.
 */
process.env.NODE_ENV = 'test';
process.env.AZURE_CLIENT_ID = process.env.AZURE_CLIENT_ID || 'test-client';
process.env.AZURE_CLIENT_SECRET = process.env.AZURE_CLIENT_SECRET || 'test-secret';
process.env.AZURE_TENANT_ID = process.env.AZURE_TENANT_ID || 'test-tenant';

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const notification = require('../src/services/notification.service');
const ledger = require('../src/services/notification-ledger.service');

const tick = () => new Promise((r) => setTimeout(r, 0));
const keyOf = (e, d, t) => `${e}|${String(d ?? '').slice(0, 10)}|${t}`;
const CLAIM_TTL_MS = 2 * 60 * 1000;   // mirrors the ledger's abandoned-claim window

// A shared persistent "DB" (survives a simulated restart because the array persists).
function makeDb() {
  const rows = [];
  let seq = 0;
  return { rows, nextId: () => `id-${String(++seq).padStart(6, '0')}` };   // globally-unique, sortable (like a GUID)
}

// One backend PROCESS: a ledger store over the shared DB, mirroring d365Store's
// claim/arbitrate/finalize semantics (insert pending → lowest-id winner → finalize).
function proc(db) {
  const drop = (id) => { const i = db.rows.findIndex((r) => r.id === id); if (i >= 0) db.rows.splice(i, 1); };
  return {
    async hasSent(e, d, t) { await tick(); return db.rows.some((r) => r.k === keyOf(e, d, t) && r.status === 'sent'); },
    async claim(rec) {
      const k = keyOf(rec.employeeId, rec.date, rec.type);
      await tick();
      const id = db.nextId();
      const now = Date.now();
      db.rows.push({ k, id, status: 'pending', attemptedAt: now, ...rec });
      await tick();
      const set = db.rows.filter((r) => r.k === k && (r.status === 'pending' || r.status === 'sent'));
      if (set.some((r) => r.status === 'sent')) { drop(id); return { won: false, id }; }
      // Ignore abandoned (stale) pending claims so a crashed sender never blocks a retry.
      const live = set.filter((r) => r.id === id || (now - (r.attemptedAt || 0)) <= CLAIM_TTL_MS);
      const winner = live.map((r) => r.id).sort()[0];
      if (winner === id) return { won: true, id };
      drop(id);
      return { won: false, id };
    },
    async finalize(id, rec) {
      const row = db.rows.find((r) => r.id === id);
      if (row) { row.status = rec.status; row.error = rec.error || ''; }
      else db.rows.push({ k: keyOf(rec.employeeId, rec.date, rec.type), id: db.nextId(), status: rec.status, ...rec });
    },
    async record(rec) { db.rows.push({ k: keyOf(rec.employeeId, rec.date, rec.type), id: db.nextId(), status: rec.status, ...rec }); },
  };
}

const LATE = (over = {}) => ({
  employeeId: 'EMP-A', date: '2026-08-13', type: 'LATE_LOGIN',
  to: 'a@crmonce.com', subject: 'Late Login Notification - 13 Aug 2026', html: '<p>late</p>', entity: 'attendance', ...over,
});

beforeEach(() => { notification.clearOutbox(); notification.setTransport(() => {}); });
afterEach(() => { notification.resetTransport(); ledger.setStore(null); notification.clearOutbox(); });

// 3 + 4: same attendance event processed again / browser refresh → still ONE email.
test('same (employee,date) sent twice → exactly ONE email', async () => {
  const db = makeDb(); ledger.setStore(proc(db));
  const r1 = await ledger.sendOnce(LATE());
  const r2 = await ledger.sendOnce(LATE());   // refresh / re-POST / recalc
  assert.strictEqual(r1.sent, true);
  assert.strictEqual(r2.skipped, true);
  assert.strictEqual(notification.getOutbox().length, 1);
  assert.strictEqual(db.rows.filter((r) => r.status === 'sent').length, 1);
});

// 5: PM2 / server restart → the day's email is NOT sent again (DB persisted).
test('after a simulated restart the same day is not re-sent', async () => {
  const db = makeDb();
  ledger.setStore(proc(db));
  await ledger.sendOnce(LATE());
  // "restart": brand-new process (new store, fresh in-process lock) over the SAME db.
  ledger.setStore(proc(db));
  const again = await ledger.sendOnce(LATE());
  assert.strictEqual(again.skipped, true, 'persistent ledger blocks the re-send');
  assert.strictEqual(notification.getOutbox().length, 1);
});

// 6 + 7: the restriction is per-DATE — the next day (and 5 different days) each send.
test('same employee late on 5 different days → 5 emails', async () => {
  const db = makeDb(); ledger.setStore(proc(db));
  for (const d of ['2026-08-13', '2026-08-14', '2026-08-15', '2026-08-16', '2026-08-17']) {
    await ledger.sendOnce(LATE({ date: d, subject: `Late Login Notification - ${d}` }));
  }
  assert.strictEqual(notification.getOutbox().length, 5);
});

// 8: two different employees late on the same day → 2 separate emails.
test('two employees late on the same day → 2 emails', async () => {
  const db = makeDb(); ledger.setStore(proc(db));
  await ledger.sendOnce(LATE({ employeeId: 'EMP-A', to: 'a@crmonce.com' }));
  await ledger.sendOnce(LATE({ employeeId: 'EMP-B', to: 'b@crmonce.com' }));
  assert.strictEqual(notification.getOutbox().length, 2);
});

// 10: two backend PROCESSES claim the SAME event simultaneously → exactly one wins.
//     Tests the DB arbitration directly (each process has its own in-proc lock).
test('two processes racing the same event → exactly ONE claim wins (no double email)', async () => {
  const db = makeDb();
  const p1 = proc(db), p2 = proc(db);
  const rec = { employeeId: 'EMP-A', date: '2026-08-13', type: 'LATE_LOGIN' };
  const [c1, c2] = await Promise.all([p1.claim(rec), p2.claim(rec)]);
  const winners = [c1, c2].filter((c) => c.won).length;
  assert.strictEqual(winners, 1, 'exactly one process may send');
  // The loser dropped its pending row → the winner's single row is all that remains.
  assert.strictEqual(db.rows.filter((r) => r.k === keyOf('EMP-A', '2026-08-13', 'LATE_LOGIN')).length, 1);
});

// Many-way race: 6 processes, still exactly one winner.
test('six processes racing → exactly ONE winner', async () => {
  const db = makeDb();
  const rec = { employeeId: 'EMP-A', date: '2026-08-13', type: 'LATE_LOGIN' };
  const claims = await Promise.all(Array.from({ length: 6 }, () => proc(db).claim(rec)));
  assert.strictEqual(claims.filter((c) => c.won).length, 1);
});

// 9: email send FAILURE → recorded 'failed' (never 'sent'), so a later retry still
//     delivers exactly one — a failure never blocks nor duplicates.
test('send failure is retryable and never duplicates after success', async () => {
  const db = makeDb(); ledger.setStore(proc(db));
  notification.setTransport(() => { throw new Error('graph down'); });
  const r1 = await ledger.sendOnce(LATE());
  assert.strictEqual(r1.sent, false);
  assert.strictEqual(db.rows.filter((r) => r.status === 'sent').length, 0, 'never marked sent on failure');

  notification.setTransport(() => {});                 // service recovers
  const r2 = await ledger.sendOnce(LATE());             // retry → delivers
  assert.strictEqual(r2.sent, true);
  const r3 = await ledger.sendOnce(LATE());             // now deduped
  assert.strictEqual(r3.skipped, true);
  // Exactly one SUCCESSFUL delivery is recorded, and none after it (the earlier failed
  // attempt is retryable, never counted as a delivered email).
  assert.strictEqual(db.rows.filter((r) => r.status === 'sent').length, 1, 'exactly one successful send recorded');
});

// A stale pending claim (crashed sender) must NOT permanently block a later retry.
test('a leftover pending claim does not block the next real send (self-heals)', async () => {
  const db = makeDb();
  // Simulate an abandoned pending row (a process that claimed then died before sending),
  // older than the abandoned-claim window so it must not block the retry.
  db.rows.push({ k: keyOf('EMP-A', '2026-08-13', 'LATE_LOGIN'), id: db.nextId(), status: 'pending', attemptedAt: Date.now() - 5 * 60 * 1000, employeeId: 'EMP-A', date: '2026-08-13', type: 'LATE_LOGIN' });
  ledger.setStore(proc(db));
  const r = await ledger.sendOnce(LATE());
  assert.strictEqual(r.sent, true, 'a stale pending never suppresses a genuine email');
  assert.strictEqual(notification.getOutbox().length, 1);
});
