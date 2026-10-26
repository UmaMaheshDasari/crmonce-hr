/**
 * "Late Present" attendance-grid label (approvedOn / approvedSet) must come from LATE LOGIN
 * records only. Early Logout permission records live on the SAME table (hr_requesttype) and
 * must NEVER cause a day to be labelled late-present. Legacy Late Login rows with a null
 * request type keep their label (`ne 'early_logout'` is null-safe in OData).
 *
 * The stub emulates Dataverse applying the OData filter the service builds — proving the
 * exclusion is enforced at the QUERY, not just in post-processing. No network.
 */
process.env.NODE_ENV = 'test';
process.env.AZURE_CLIENT_ID = process.env.AZURE_CLIENT_ID || 'test-client';
process.env.AZURE_CLIENT_SECRET = process.env.AZURE_CLIENT_SECRET || 'test-secret';
process.env.AZURE_TENANT_ID = process.env.AZURE_TENANT_ID || 'test-tenant';

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const d365 = require('../src/services/d365.service');
const lateLogin = require('../src/services/late-login.service');

// Mixed rows on the shared hr_lateLogin table for one employee across three days.
const ROWS = [
  { hr_employeeid: 'E1', hr_date: '2026-05-10', hr_status: 'submitted', hr_requesttype: 'late_login' },
  { hr_employeeid: 'E1', hr_date: '2026-05-11', hr_status: 'submitted', hr_requesttype: 'early_logout' },
  { hr_employeeid: 'E1', hr_date: '2026-05-12', hr_status: 'submitted', hr_requesttype: null },   // legacy → treated as Late Login
];

let orig;
beforeEach(() => { orig = d365.getList; });
afterEach(() => { d365.getList = orig; });

// Emulate Dataverse honouring the relevant predicates in the service's OData filter.
function stubDb() {
  let lastFilter = '';
  d365.getList = async (_e, opts) => {
    const f = lastFilter = String(opts.filter || '');
    const eq = f.match(/hr_date eq '?(\d{4}-\d{2}-\d{2})'?/);
    const ge = f.match(/hr_date ge '?(\d{4}-\d{2}-\d{2})'?/);
    const le = f.match(/hr_date le '?(\d{4}-\d{2}-\d{2})'?/);
    const excludeEarly = /hr_requesttype ne 'early_logout'/.test(f);
    let rows = ROWS.slice();
    if (eq) rows = rows.filter(r => r.hr_date === eq[1]);
    if (ge) rows = rows.filter(r => r.hr_date >= ge[1]);
    if (le) rows = rows.filter(r => r.hr_date <= le[1]);
    if (excludeEarly) rows = rows.filter(r => r.hr_requesttype !== 'early_logout');   // null-safe: null kept
    return { data: rows.map(r => ({ hr_employeeid: r.hr_employeeid, hr_date: r.hr_date, hr_lateloginid: 'x' })) };
  };
  return () => lastFilter;
}

test('approvedSet: Early Logout day is NOT labelled late-present; Late Login + legacy days are', async () => {
  const getFilter = stubDb();
  const set = await lateLogin.approvedSet({ from: '2026-05-01', to: '2026-05-31', employeeId: 'E1' });
  assert.match(getFilter(), /hr_requesttype ne 'early_logout'/, 'query excludes early_logout at the source');
  assert.ok(set.has('E1|2026-05-10'), 'Late Login day → late-present');
  assert.ok(set.has('E1|2026-05-12'), 'legacy null-type Late Login day retained');
  assert.ok(!set.has('E1|2026-05-11'), 'Early Logout day must NOT be late-present');
});

test('approvedOn: true for a Late Login day, false for an Early-Logout-only day', async () => {
  stubDb();
  assert.strictEqual(await lateLogin.approvedOn('E1', '2026-05-10'), true, 'Late Login → labelled');
  assert.strictEqual(await lateLogin.approvedOn('E1', '2026-05-11'), false, 'Early Logout → not labelled');
  assert.strictEqual(await lateLogin.approvedOn('E1', '2026-05-12'), true, 'legacy null-type → labelled');
});
