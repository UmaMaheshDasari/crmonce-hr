/**
 * Interim run-history (JSONL, single-host, best-effort) for the Late Login scanner/reconciler.
 * Uses an isolated temp dir; never touches the repo or real services.
 */
const os = require('os');
const path = require('path');
const fs = require('fs');

const TMP = path.join(os.tmpdir(), `ll-runhistory-${process.pid}-${Date.now()}`);
process.env.NODE_ENV = 'test';
process.env.LATE_LOGIN_RUN_HISTORY_DIR = TMP;
process.env.LATE_LOGIN_RUN_HISTORY_MAX_BYTES = '1024';   // small so rotation is testable
delete process.env.LATE_LOGIN_RUN_HISTORY;               // ensure enabled by default

const { test, beforeEach, afterEach, after } = require('node:test');
const assert = require('node:assert');
const H = require('../src/services/late-login-run-history.service');
const { requireAnyPermission } = require('../src/middleware/auth.middleware');

function clean() { try { for (const f of fs.readdirSync(TMP)) fs.unlinkSync(path.join(TMP, f)); } catch { /* dir not yet created */ } }
beforeEach(clean);
after(() => { try { clean(); fs.rmdirSync(TMP); } catch { /* best effort */ } });

test('records success/partial/failed; list is newest-first and PII-free', () => {
  H.record({ jobType: 'scanner', status: 'success', window: { from: '2026-11-01', to: '2026-11-10' }, counters: { created: 2 } });
  H.record({ jobType: 'reconciler', status: 'partial', counters: { events: 5 }, errorCount: 1, partial: true });
  H.record({ jobType: 'scanner', status: 'failed', errorCount: 1 });
  const out = H.list({ limit: 10 });
  assert.strictEqual(out.available, true);
  assert.strictEqual(out.runs.length, 3);
  assert.deepStrictEqual(out.runs.map(r => r.status), ['failed', 'partial', 'success']);   // newest first
  // No employee identifiers / names / secrets in any record.
  const blob = JSON.stringify(out.runs);
  assert.ok(!/employeeId|employeeName|hr_employee|token|secret|password/i.test(blob), 'no PII/secrets persisted');
  assert.ok(out.runs.every(r => r.runId && r.jobType && r.finishedAt));
});

test('status + jobType filters', () => {
  H.record({ jobType: 'scanner', status: 'success' });
  H.record({ jobType: 'reconciler', status: 'failed', errorCount: 1 });
  assert.strictEqual(H.list({ jobType: 'reconciler' }).runs.length, 1);
  assert.strictEqual(H.list({ status: 'success' }).runs.length, 1);
});

test('malformed lines are skipped safely (read never throws)', () => {
  H.record({ jobType: 'scanner', status: 'success' });
  fs.appendFileSync(H.FILE, '{ this is not json\n');        // corrupt/partial line
  fs.appendFileSync(H.FILE, '\n');                            // blank line
  H.record({ jobType: 'reconciler', status: 'success' });
  const out = H.list({ limit: 10 });
  assert.strictEqual(out.runs.length, 2, 'valid records still returned');
  assert.ok(out.malformedSkipped >= 1, 'malformed line counted, not fatal');
});

test('a write failure is non-fatal (record returns null, never throws)', () => {
  const orig = fs.appendFileSync;
  fs.appendFileSync = () => { throw new Error('disk full'); };
  try {
    let threw = false, ret;
    try { ret = H.record({ jobType: 'scanner', status: 'success' }); } catch { threw = true; }
    assert.strictEqual(threw, false, 'record must not throw');
    assert.strictEqual(ret, null);
  } finally { fs.appendFileSync = orig; }
});

test('append-only rotation bounds growth (backup file created past the threshold)', () => {
  for (let i = 0; i < 20; i++) H.record({ jobType: 'scanner', status: 'success', counters: { created: i, note: 'xxxxxxxxxxxxxxxxxxxx' } });
  assert.ok(fs.existsSync(`${H.FILE}.1`), 'a rotated backup exists once the size threshold is exceeded');
  // Original entries are never rewritten — they live in the backup, not mutated.
  assert.ok(H.list({ limit: 500 }).available);
});

test('disabled gate: LATE_LOGIN_RUN_HISTORY=false → record no-op, list unavailable', () => {
  process.env.LATE_LOGIN_RUN_HISTORY = 'false';
  try {
    assert.strictEqual(H.record({ jobType: 'scanner', status: 'success' }), null);
    const out = H.list({});
    assert.strictEqual(out.available, false);
  } finally { delete process.env.LATE_LOGIN_RUN_HISTORY; }
});

test('endpoint authorization: reports.view required (HR allow, employee deny)', () => {
  const run = (role) => { const mw = requireAnyPermission('reports.view'); const req = { user: { role, id: 'u' } }; let s = 200, p = false; const res = { status(c) { s = c; return this; }, json() { return this; } }; mw(req, res, () => { p = true; }); return { p, s }; };
  assert.deepEqual(run('hr_manager'), { p: true, s: 200 });
  assert.deepEqual(run('super_admin'), { p: true, s: 200 });
  assert.strictEqual(run('employee').p, false);
  assert.strictEqual(run('employee').s, 403);
});
