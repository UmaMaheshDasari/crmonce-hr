/**
 * getActiveStructure — payroll selects the Salary Structure by Effective From ONLY.
 *
 * Rule: the LATEST revision whose hr_effectivefrom <= payroll period wins, regardless
 * of the mutable active/superseded flag. No date-blind fallback: a future/current
 * structure is NEVER used for an earlier period — no applicable revision → null.
 *
 * No network: d365.getListOptional is stubbed to emulate Dataverse (filter by the
 * `hr_effectivefrom le 'asOf'` clause, order by effectivefrom desc, top 1).
 */
process.env.NODE_ENV = 'test';
process.env.AZURE_CLIENT_ID = process.env.AZURE_CLIENT_ID || 'test-client';
process.env.AZURE_CLIENT_SECRET = process.env.AZURE_CLIENT_SECRET || 'test-secret';
process.env.AZURE_TENANT_ID = process.env.AZURE_TENANT_ID || 'test-tenant';

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const d365 = require('../src/services/d365.service');
const svc = require('../src/services/salary-structure.service');

const EMP = 'emp-guid-1';

// Three revisions. NOTE only the newest (Sep) is 'active' — Jun/Aug are 'superseded',
// exactly as resequence() leaves them. If status were (wrongly) honoured, Jun/Aug
// months could never resolve; these tests prove status is IGNORED.
const REVISIONS = [
  { hr_salarystructureid: 'r-jun', hr_employeeid: EMP, hr_effectivefrom: '2026-06-01', hr_basic: 10000, hr_status: 'superseded', createdon: '2026-06-01T00:00:00Z' },
  { hr_salarystructureid: 'r-aug', hr_employeeid: EMP, hr_effectivefrom: '2026-08-01', hr_basic: 12000, hr_status: 'superseded', createdon: '2026-08-01T00:00:00Z' },
  { hr_salarystructureid: 'r-sep', hr_employeeid: EMP, hr_effectivefrom: '2026-09-01', hr_basic: 15000, hr_status: 'active',     createdon: '2026-09-01T00:00:00Z' },
];

// Last day of a month (the asOf payroll actually passes).
const monthEnd = (y, m) => `${y}-${String(m).padStart(2, '0')}-${String(new Date(y, m, 0).getDate()).padStart(2, '0')}`;

let origGetListOptional;
function stubDataverse(dataset) {
  // Emulate Dataverse: apply the `hr_effectivefrom le 'YYYY-MM-DD'` clause the resolver
  // builds, sort by effectivefrom desc then createdon desc, honour top.
  d365.getListOptional = async (_entity, params = {}) => {
    const m = /hr_effectivefrom le '(\d{4}-\d{2}-\d{2})'/.exec(params.filter || '');
    const asOf = m ? m[1] : null;
    let rows = dataset.filter((r) => r.hr_employeeid === EMP);
    if (asOf) rows = rows.filter((r) => r.hr_effectivefrom <= asOf);
    rows = rows.sort((a, b) => (b.hr_effectivefrom.localeCompare(a.hr_effectivefrom)) || (b.createdon.localeCompare(a.createdon)));
    if (params.top) rows = rows.slice(0, params.top);
    return { data: rows, count: rows.length };
  };
}

beforeEach(() => { origGetListOptional = d365.getListOptional; stubDataverse(REVISIONS); });
afterEach(() => { d365.getListOptional = origGetListOptional; });

const basicFor = async (y, m) => {
  const s = await svc.getActiveStructure(d365, EMP, monthEnd(y, m));
  return s ? s.basic : null;
};

// ── The exact table from the requirement ──
test('June payroll → ₹10,000 (01-Jun revision)', async () => {
  assert.strictEqual(await basicFor(2026, 6), 10000);
});
test('July payroll → ₹10,000 (still 01-Jun; no July revision)', async () => {
  assert.strictEqual(await basicFor(2026, 7), 10000);
});
test('August payroll → ₹12,000 (01-Aug revision, though superseded)', async () => {
  const s = await svc.getActiveStructure(d365, EMP, monthEnd(2026, 8));
  assert.strictEqual(s.basic, 12000);
  assert.strictEqual(s.id, 'r-aug');
  assert.strictEqual(s.status, 'superseded', 'status is ignored — a superseded revision still applies to its period');
});
test('September payroll → ₹15,000 (01-Sep revision)', async () => {
  assert.strictEqual(await basicFor(2026, 9), 15000);
});

// ── Future-dated structure must NOT leak backwards ──
test('a future-dated structure is NOT used for an earlier payroll (no fallback)', async () => {
  // May 2026: nothing is effective on/before May → must be null, NEVER the Sep ₹15,000.
  const s = await svc.getActiveStructure(d365, EMP, monthEnd(2026, 5));
  assert.strictEqual(s, null, 'no revision effective ≤ May → null (never the current/latest structure)');
});
test('with ONLY a future Sep revision, an August payroll resolves to null', async () => {
  stubDataverse([REVISIONS[2]]);   // only 01-Sep ₹15,000 exists
  const s = await svc.getActiveStructure(d365, EMP, monthEnd(2026, 8));
  assert.strictEqual(s, null, 'August must not fall back to the future Sep structure');
});

// ── Latest Effective From <= period wins among multiple ──
test('multiple revisions → the latest Effective From ≤ period wins', async () => {
  // October: Jun/Aug/Sep all ≤ Oct → the latest (Sep) wins.
  assert.strictEqual(await basicFor(2026, 10), 15000);
  // Late August: Jun and Aug ≤ 31-Aug → the latest (Aug) wins, not Jun.
  const s = await svc.getActiveStructure(d365, EMP, '2026-08-31');
  assert.strictEqual(s.id, 'r-aug');
});

// ── No structure at all → null (→ clear validation message in payroll) ──
test('no structures exist → null', async () => {
  stubDataverse([]);
  assert.strictEqual(await svc.getActiveStructure(d365, EMP, monthEnd(2026, 8)), null);
});
