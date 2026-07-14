/**
 * Cursor paging (getAll) + offset-slice pagination correctness.
 * Dataverse ignores $skip, so lists use $top + server-side slice, and bulk reads
 * follow @odata.nextLink. No network: d365.getList is stubbed.
 */
process.env.NODE_ENV = 'test';
process.env.AZURE_CLIENT_ID = process.env.AZURE_CLIENT_ID || 'test-client';
process.env.AZURE_CLIENT_SECRET = process.env.AZURE_CLIENT_SECRET || 'test-secret';
process.env.AZURE_TENANT_ID = process.env.AZURE_TENANT_ID || 'test-tenant';

const { test } = require('node:test');
const assert = require('node:assert');
const d365 = require('../src/services/d365.service');

test('getAll returns the single page when there is no nextLink', async () => {
  const orig = d365.getList;
  d365.getList = async () => ({ data: [{ id: 1 }, { id: 2 }], count: 2, nextLink: undefined });
  try {
    const r = await d365.getAll('e', {});
    assert.deepStrictEqual(r.data.map(x => x.id), [1, 2]);
    assert.strictEqual(r.count, 2);
  } finally { d365.getList = orig; }
});

test('getAll caps the number of rows returned', async () => {
  const orig = d365.getList;
  d365.getList = async () => ({ data: Array.from({ length: 5 }, (_, i) => ({ i })), count: 5, nextLink: undefined });
  try {
    const r = await d365.getAll('e', {}, 3);
    assert.strictEqual(r.data.length, 3);
  } finally { d365.getList = orig; }
});

// Offset-slice pagination: fetch top=(page*limit), then slice the requested page.
// This is what the list routes do — verify the math returns DISTINCT pages
// (the bug was every page returning page 1 because $skip is ignored).
function pageOf(all, page, limit) {
  const top = all.slice(0, page * limit);      // what $top returns
  return top.slice((page - 1) * limit);        // the requested page
}

test('offset-slice returns distinct, correct pages', () => {
  const all = Array.from({ length: 23 }, (_, i) => i + 1);   // 1..23
  assert.deepStrictEqual(pageOf(all, 1, 10), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.deepStrictEqual(pageOf(all, 2, 10), [11, 12, 13, 14, 15, 16, 17, 18, 19, 20]);
  assert.deepStrictEqual(pageOf(all, 3, 10), [21, 22, 23]);   // last partial page
});
