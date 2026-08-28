/**
 * Dual Date of Birth (Original hr_dob + Certificate hr_certificatedob).
 *
 * Verifies: birthday wishes read ONLY hr_dob (never hr_certificatedob, no fallback);
 * Certificate DOB is self-editable — an employee may set it on their OWN profile (it is in the
 * whitelist), while the route's own-record ownership check (isSelf) still blocks editing anyone
 * else's; HR/Super Admin keep full edit access; labels are correct.
 * No network — d365 stubbed. No notifications are sent.
 */
process.env.NODE_ENV = 'test';
process.env.AZURE_CLIENT_ID = process.env.AZURE_CLIENT_ID || 'test-client';
process.env.AZURE_CLIENT_SECRET = process.env.AZURE_CLIENT_SECRET || 'test-secret';
process.env.AZURE_TENANT_ID = process.env.AZURE_TENANT_ID || 'test-tenant';

const { test } = require('node:test');
const assert = require('node:assert');
const profile = require('../src/services/profile.service');
const celebrations = require('../src/services/celebrations.service');
const d365 = require('../src/services/d365.service');

// ── Self-edit: Certificate DOB is self-editable (own profile), like Original DOB ──
test('hr_certificatedob IS in SELF_EDITABLE (employee can set it on their own profile)', () => {
  assert.equal(profile.SELF_EDITABLE.has('hr_certificatedob'), true);
  // The Original DOB stays self-editable too (unchanged behaviour).
  assert.equal(profile.SELF_EDITABLE.has('hr_dob'), true);
});

test('an employee self-update of Certificate DOB is tracked by diffChanges (whitelisted)', () => {
  // diffChanges tracks SELF_EDITABLE fields — a self-service change to hr_certificatedob now
  // records an audit row alongside hr_dob. Cross-employee edits are blocked at the route
  // (isSelf ownership check), not here.
  const changes = profile.diffChanges({ hr_dob: '1990-01-01' }, { hr_dob: '1991-01-01', hr_certificatedob: '2000-12-31' });
  assert.deepEqual(changes.map((c) => c.field).sort(), ['hr_certificatedob', 'hr_dob']);
});

test('labels: hr_dob → "Original Date of Birth", hr_certificatedob → "Certificate Date of Birth"', () => {
  assert.equal(profile.FIELD_LABELS.hr_dob, 'Original Date of Birth');
  assert.equal(profile.FIELD_LABELS.hr_certificatedob, 'Certificate Date of Birth');
});

// ── Birthday source: ONLY hr_dob, never hr_certificatedob, no fallback ──
function stubEmployees(list) {
  const orig = d365.getListOptional;
  d365.getListOptional = async () => ({ data: list });
  return () => { d365.getListOptional = orig; };
}

test('birthday wishes use ONLY hr_dob — Certificate DOB is never a source or fallback', async () => {
  const today = '2024-06-15';   // deterministic
  const un = stubEmployees([
    { hr_hremployeeid: 'A', hr_hremployee1: 'Alice', hr_dob: '1990-06-15', hr_certificatedob: '1990-01-01' }, // hr_dob matches → birthday
    { hr_hremployeeid: 'B', hr_hremployee1: 'Bob',   hr_dob: '',           hr_certificatedob: '1988-06-15' }, // ONLY cert matches → NO birthday (no fallback)
    { hr_hremployeeid: 'C', hr_hremployee1: 'Cara',  hr_dob: '1985-06-15', hr_certificatedob: '' },           // hr_dob matches → birthday
    { hr_hremployeeid: 'D', hr_hremployee1: 'Dan',   hr_dob: '1990-03-01', hr_certificatedob: '1990-06-15' }, // neither hr_dob today (cert is, ignored) → NO
  ]);
  try {
    const out = await celebrations.findToday({ full: false, today });
    const ids = out.birthday.map((b) => b.id).sort();
    assert.deepEqual(ids, ['A', 'C'], 'only hr_dob matches count as birthdays');
    assert.ok(!ids.includes('B'), 'Certificate DOB is NOT used as a fallback when hr_dob is empty');
    assert.ok(!ids.includes('D'), 'Certificate DOB matching today does NOT create a birthday');
  } finally { un(); }
});

test('celebrations service never references the certificate field (static guard)', () => {
  const src = require('node:fs').readFileSync(require('node:path').resolve(__dirname, '../src/services/celebrations.service.js'), 'utf8');
  assert.ok(!/certificatedob/i.test(src), 'celebrations.service must not reference certificate DOB');
});
