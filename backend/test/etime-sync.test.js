/**
 * eTime Office-Agent sync: ingestion core (validate, employee-map, idempotent upsert,
 * IST date), the agent-key auth guard, and the sync-status store. No network — d365 is
 * stubbed per entity.
 */
process.env.NODE_ENV = 'test';
process.env.AZURE_CLIENT_ID = process.env.AZURE_CLIENT_ID || 'test-client';
process.env.AZURE_CLIENT_SECRET = process.env.AZURE_CLIENT_SECRET || 'test-secret';
process.env.AZURE_TENANT_ID = process.env.AZURE_TENANT_ID || 'test-tenant';

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const ingest = require('../src/services/etime-ingest.service');
const syncState = require('../src/services/etime-sync-state');
const d365 = require('../src/services/d365.service');

const EMP = d365.constructor.entities.employee;
const ATT = d365.constructor.entities.attendance;

// ── pure helpers ──
test('validatePunch: accepts good, rejects bad date/time/missing code', () => {
  assert.strictEqual(ingest.validatePunch({ etimeCode: '5', date: '2026-08-17', time: '09:00' }).ok, true);
  assert.strictEqual(ingest.validatePunch({ etimeCode: '5', date: '17-08-2026', time: '09:00' }).ok, false);  // wrong date shape
  assert.strictEqual(ingest.validatePunch({ etimeCode: '5', date: '2026-08-17', time: '25:00' }).ok, false);  // bad hour
  assert.strictEqual(ingest.validatePunch({ etimeCode: '', date: '2026-08-17', time: '09:00' }).ok, false);   // missing code
  assert.strictEqual(ingest.validatePunch(null).ok, false);
});

test('mergePunch: idempotent — a time already present is not added again', () => {
  assert.deepStrictEqual(ingest.mergePunch(['09:00'], '09:00'), { punches: ['09:00'], added: false });
  assert.deepStrictEqual(ingest.mergePunch(['12:00', '09:00'], '18:00'), { punches: ['09:00', '12:00', '18:00'], added: true });
  // accepts the {t,d} object form too (web-stored punches)
  assert.strictEqual(ingest.mergePunch([{ t: '09:00' }], '09:00').added, false);
});

// ── ingestPunches with a stubbed Dataverse ──
let orig;
beforeEach(() => { orig = { glo: d365.getListOptional, gl: d365.getList, cr: d365.create, up: d365.update }; });
afterEach(() => { d365.getListOptional = orig.glo; d365.getList = orig.gl; d365.create = orig.cr; d365.update = orig.up; });

/**
 * @param mapped   { etimeCode: {guid,name} }  → employees resolvable by hr_etimecode
 * @param existing { 'guid|date': ['HH:MM',...] }  → existing attendance punches for a day
 */
function stub({ mapped = {}, existing = {} } = {}) {
  const created = [], updated = [];
  d365.getListOptional = async (entity, opts) => {
    if (entity !== EMP) return { data: [] };
    const code = (String(opts.filter).match(/hr_etimecode eq '([^']*)'/) || [])[1];
    const e = mapped[code];
    return { data: e ? [{ hr_hremployeeid: e.guid, hr_hremployee1: e.name, hr_etimecode: code }] : [] };
  };
  d365.getList = async (entity, opts) => {
    if (entity !== ATT) return { data: [] };
    const flt = String(opts.filter);
    const guid = (flt.match(/_hr_hremployee_value eq '([^']*)'/) || [])[1];
    const date = (flt.match(/hr_date eq ([0-9-]+)/) || [])[1];
    const punches = existing[`${guid}|${date}`];
    return { data: punches ? [{ hr_hrattendanceid: `att-${guid}-${date}`, hr_allpunches: JSON.stringify(punches) }] : [] };
  };
  d365.create = async (_e, body) => { created.push(body); return { hr_hrattendanceid: 'NEW' }; };
  d365.update = async (_e, id, body) => { updated.push({ id, body }); return {}; };
  return { created, updated };
}

test('valid punch for a mapped employee → creates an attendance record (source eTime)', async () => {
  const { created } = stub({ mapped: { '5': { guid: 'G5', name: 'Pavan' } } });
  const r = await ingest.ingestPunches([{ etimeCode: '5', date: '2026-08-17', time: '09:00' }]);
  assert.deepStrictEqual([r.received, r.created, r.updated, r.duplicates, r.unmapped, r.failed], [1, 1, 0, 0, 0, 0]);
  assert.strictEqual(created.length, 1);
  assert.strictEqual(created[0].hr_date, '2026-08-17');
  assert.strictEqual(created[0]['hr_hremployee@odata.bind'], '/hr_hremployees(G5)');   // GUID used internally
});

test('unknown device user (no hr_etimecode match) → unmapped, not an error', async () => {
  stub({ mapped: {} });
  const r = await ingest.ingestPunches([{ etimeCode: '999', date: '2026-08-17', time: '09:00' }]);
  assert.strictEqual(r.unmapped, 1);
  assert.strictEqual(r.failed, 0);
});

test('malformed punch → failed (validation), never written', async () => {
  const { created } = stub({ mapped: { '5': { guid: 'G5', name: 'P' } } });
  const r = await ingest.ingestPunches([{ etimeCode: '5', date: 'BAD', time: '09:00' }]);
  assert.strictEqual(r.failed, 1);
  assert.strictEqual(created.length, 0);
});

test('duplicate punch (already in the day) → counted duplicate, no write (idempotent)', async () => {
  const s = stub({ mapped: { '5': { guid: 'G5', name: 'P' } }, existing: { 'G5|2026-08-17': ['09:00'] } });
  const r = await ingest.ingestPunches([{ etimeCode: '5', date: '2026-08-17', time: '09:00' }]);
  assert.strictEqual(r.duplicates, 1);
  assert.strictEqual(s.created.length, 0);
  assert.strictEqual(s.updated.length, 0);
});

test('multiple punches same day: first creates, later ones update the same record', async () => {
  const s = stub({ mapped: { '5': { guid: 'G5', name: 'P' } } });
  // create the day
  await ingest.ingestPunches([{ etimeCode: '5', date: '2026-08-17', time: '09:00' }]);
  // now the day exists with 09:00 → a second punch updates it
  s.created.length = 0;
  d365.getList = async (entity) => (entity === ATT ? { data: [{ hr_hrattendanceid: 'att1', hr_allpunches: JSON.stringify(['09:00']) }] } : { data: [] });
  const r = await ingest.ingestPunches([{ etimeCode: '5', date: '2026-08-17', time: '18:00' }]);
  assert.strictEqual(r.updated, 1);
  assert.strictEqual(s.updated.length, 1);
  const punches = JSON.parse(s.updated[0].body.hr_allpunches);
  assert.deepStrictEqual(punches, ['09:00', '18:00']);
});

test('IST date is preserved — a 00:30 punch keeps its own date (no UTC shift)', async () => {
  const { created } = stub({ mapped: { '5': { guid: 'G5', name: 'P' } } });
  await ingest.ingestPunches([{ etimeCode: '5', date: '2026-08-17', time: '00:30' }]);
  assert.strictEqual(created[0].hr_date, '2026-08-17', 'date is stored exactly as received, never rolled back a day');
});

test('a Dataverse write failure is isolated: one punch fails, others still succeed', async () => {
  const s = stub({ mapped: { '5': { guid: 'G5', name: 'P' }, '6': { guid: 'G6', name: 'Q' } } });
  let n = 0;
  d365.create = async (_e, body) => { n++; if (n === 1) throw new Error('boom'); return { hr_hrattendanceid: 'NEW' }; };
  const r = await ingest.ingestPunches([
    { etimeCode: '5', date: '2026-08-17', time: '09:00' },
    { etimeCode: '6', date: '2026-08-17', time: '09:05' },
  ]);
  assert.strictEqual(r.failed, 1);
  assert.strictEqual(r.created, 1);
  assert.ok(r.errors.every(e => !/boom/.test(e.reason)), 'internal error text is NOT leaked in the result');
});

// ── agent-key auth guard ──
function callRouter(url, headers) {
  const router = require('../src/modules/attendance/etime-agent.routes');
  return new Promise((resolve) => {
    const req = { method: 'POST', url, headers, body: {}, get: (h) => headers[h.toLowerCase()] };
    const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(o) { resolve({ code: this.statusCode, body: o }); } };
    router.handle(req, res, () => resolve({ code: 404, body: null }));
  });
}

test('agent auth: 401 without/with wrong key, 200 with the right key', async () => {
  process.env.ETIME_AGENT_KEY = 'secret-key';
  assert.strictEqual((await callRouter('/heartbeat', {})).code, 401, 'no key → 401');
  assert.strictEqual((await callRouter('/heartbeat', { 'x-etime-agent-key': 'wrong' })).code, 401, 'wrong key → 401');
  assert.strictEqual((await callRouter('/heartbeat', { 'x-etime-agent-key': 'secret-key' })).code, 200, 'right key → 200');
});

test('agent auth: 503 when the server key is not configured', async () => {
  const saved = process.env.ETIME_AGENT_KEY;
  delete process.env.ETIME_AGENT_KEY;
  try { assert.strictEqual((await callRouter('/heartbeat', { 'x-etime-agent-key': 'anything' })).code, 503); }
  finally { if (saved !== undefined) process.env.ETIME_AGENT_KEY = saved; }
});

// ── sync-state store ──
test('sync-state: records a sync, reports online, and accumulates totals', () => {
  syncState.recordSync({ received: 5, created: 2, updated: 3, duplicates: 0, unmapped: 0, failed: 0, lastPunch: { etimeCode: '5', date: '2026-08-17', time: '09:00' } }, { host: 'OFFICE-PC', pending: 0, version: '1.0.0' });
  const s = syncState.snapshot();
  assert.strictEqual(s.online, true);
  assert.strictEqual(s.lastResult.received, 5);
  assert.strictEqual(s.lastPunch.time, '09:00');
  assert.strictEqual(s.agent.host, 'OFFICE-PC');
  assert.ok(s.totals.received >= 5);
});
