/**
 * Web Check-In access control — the per-employee permission gate.
 *
 * Verifies: default DISABLED (absent flag), enable/disable via the stored string
 * flag, fail-closed on read errors, and the checkin/checkout guard contract
 * (403 when disabled, pass-through when enabled). No network — d365 stubbed.
 */
process.env.NODE_ENV = 'test';
process.env.AZURE_CLIENT_ID = process.env.AZURE_CLIENT_ID || 'test-client';
process.env.AZURE_CLIENT_SECRET = process.env.AZURE_CLIENT_SECRET || 'test-secret';
process.env.AZURE_TENANT_ID = process.env.AZURE_TENANT_ID || 'test-tenant';

const { test } = require('node:test');
const assert = require('node:assert');
const webCheckin = require('../src/services/web-checkin.service');
const d365 = require('../src/services/d365.service');

// Stub d365.getByIdOptional to serve an in-memory employee map. Restores in finally.
function stubEmployees(map) {
  const orig = d365.getByIdOptional;
  d365.getByIdOptional = async (_e, id) => {
    if (map[id] instanceof Error) throw map[id];
    return map[id] || null;
  };
  return { restore() { d365.getByIdOptional = orig; } };
}

// ── bool() coercion ───────────────────────────────────────────────────
test('bool(): truthy strings only', () => {
  for (const v of ['true', 'TRUE', 'True', '1', 'yes', 'on', true]) assert.equal(webCheckin.bool(v), true, `expected ${v} → true`);
  for (const v of ['false', 'FALSE', '0', 'no', 'off', '', null, undefined, 'random']) assert.equal(webCheckin.bool(v), false, `expected ${v} → false`);
});

// ── isEnabled(): default DISABLED ─────────────────────────────────────
test('isEnabled: absent flag → false (default DISABLED)', async () => {
  const s = stubEmployees({ A: { hr_hremployeeid: 'A' } });   // no flag column
  try { assert.equal(await webCheckin.isEnabled('A'), false); } finally { s.restore(); }
});

test('isEnabled: flag "false" → false', async () => {
  const s = stubEmployees({ A: { hr_hremployeeid: 'A', hr_webcheckinenabled: 'false' } });
  try { assert.equal(await webCheckin.isEnabled('A'), false); } finally { s.restore(); }
});

test('isEnabled: flag "true" → true', async () => {
  const s = stubEmployees({ A: { hr_hremployeeid: 'A', hr_webcheckinenabled: 'true' } });
  try { assert.equal(await webCheckin.isEnabled('A'), true); } finally { s.restore(); }
});

test('isEnabled: empty employeeId → false', async () => {
  assert.equal(await webCheckin.isEnabled(''), false);
  assert.equal(await webCheckin.isEnabled(null), false);
});

test('isEnabled: read error → false (fail-closed)', async () => {
  const s = stubEmployees({ A: new Error('Dataverse 500') });
  try { assert.equal(await webCheckin.isEnabled('A'), false); } finally { s.restore(); }
});

// ── Guard contract used by /checkin and /checkout ─────────────────────
// Mirrors requireWebCheckinEnabled: enabled → next(); disabled → 403 with the
// exact message. Uses the REAL service so a regression in isEnabled fails here too.
async function runGuard(employeeId) {
  const res = { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
  let nexted = false;
  if (await webCheckin.isEnabled(employeeId)) nexted = true;
  else res.status(403).json({ error: 'Web Check-In access is not enabled for this employee.' });
  return { nexted, res };
}

test('guard: disabled employee → 403 with the exact message', async () => {
  const s = stubEmployees({ A: { hr_hremployeeid: 'A', hr_webcheckinenabled: 'false' } });
  try {
    const { nexted, res } = await runGuard('A');
    assert.equal(nexted, false);
    assert.equal(res.statusCode, 403);
    assert.equal(res.body.error, 'Web Check-In access is not enabled for this employee.');
  } finally { s.restore(); }
});

test('guard: enabled employee → passes through (no 403)', async () => {
  const s = stubEmployees({ A: { hr_hremployeeid: 'A', hr_webcheckinenabled: 'true' } });
  try {
    const { nexted, res } = await runGuard('A');
    assert.equal(nexted, true);
    assert.equal(res.statusCode, 200);
  } finally { s.restore(); }
});

test('guard: employee never configured → 403 (default DISABLED)', async () => {
  const s = stubEmployees({ A: { hr_hremployeeid: 'A' } });
  try {
    const { nexted, res } = await runGuard('A');
    assert.equal(nexted, false);
    assert.equal(res.statusCode, 403);
  } finally { s.restore(); }
});
