/**
 * getByIdResilient / getListResilient — a single not-yet-provisioned optional column
 * must be stripped WITHOUT dropping every other optional field.
 *
 * Regression guard for the "My Profile shows missing/incomplete data" bug: adding a
 * new column (hr_personalphotourl) to the profile select made the all-or-nothing
 * getByIdOptional blank out Identity/Address/Bank/Emergency/Master when that column
 * wasn't provisioned. The resilient read strips only the missing one.
 */
process.env.NODE_ENV = 'test';
process.env.AZURE_CLIENT_ID = process.env.AZURE_CLIENT_ID || 'test-client';
process.env.AZURE_CLIENT_SECRET = process.env.AZURE_CLIENT_SECRET || 'test-secret';
process.env.AZURE_TENANT_ID = process.env.AZURE_TENANT_ID || 'test-tenant';

const { test } = require('node:test');
const assert = require('node:assert');
const d365 = require('../src/services/d365.service');

function missingPropError(prop) {
  const e = new Error('bad request');
  e.response = { status: 400, data: { error: { message: `Could not find a property named '${prop}' on type 'Microsoft.Dynamics.CRM.hr_hremployee'.` } } };
  return e;
}

test('getByIdResilient strips ONLY the missing column and keeps all other optional fields', async () => {
  const calls = [];
  const orig = d365.getById;
  d365.getById = async (entity, id, opts) => {
    calls.push(opts.select);
    if (/\bhr_personalphotourl\b/.test(opts.select)) throw missingPropError('hr_personalphotourl');
    return { hr_hremployeeid: id, hr_pan: 'ABCDE1234F', hr_aadhaar: '111122223333', hr_photourl: '/uploads/x.jpg', hr_bankname: 'HDFC' };
  };
  try {
    const rec = await d365.getByIdResilient('hr_hremployees', 'emp-1', {
      select: 'hr_hremployeeid,hr_hremployee1',
      optionalSelect: 'hr_pan,hr_aadhaar,hr_personalphotourl,hr_photourl,hr_bankname',
    });
    // Every OTHER field survived (not blanked) — the actual My Profile fix.
    assert.strictEqual(rec.hr_pan, 'ABCDE1234F');
    assert.strictEqual(rec.hr_aadhaar, '111122223333');
    assert.strictEqual(rec.hr_bankname, 'HDFC');
    assert.strictEqual(rec.hr_photourl, '/uploads/x.jpg');
    const finalSelect = calls[calls.length - 1];
    assert.ok(!/hr_personalphotourl/.test(finalSelect), 'the missing column was stripped');
    assert.ok(/hr_pan/.test(finalSelect) && /hr_aadhaar/.test(finalSelect) && /hr_bankname/.test(finalSelect) && /hr_photourl/.test(finalSelect), 'all other optional fields retained');
  } finally { d365.getById = orig; }
});

test('getByIdResilient: all columns valid → ONE call, nothing stripped', async () => {
  const calls = [];
  const orig = d365.getById;
  d365.getById = async (entity, id, opts) => { calls.push(opts.select); return { hr_hremployeeid: id, ok: true }; };
  try {
    const rec = await d365.getByIdResilient('hr_hremployees', 'emp-2', { select: 'hr_hremployeeid', optionalSelect: 'hr_pan,hr_photourl' });
    assert.strictEqual(rec.ok, true);
    assert.strictEqual(calls.length, 1);
    assert.ok(/hr_pan/.test(calls[0]) && /hr_photourl/.test(calls[0]));
  } finally { d365.getById = orig; }
});

test('getListResilient strips only the missing column (Employee ID column survives)', async () => {
  const calls = [];
  const orig = d365.getList;
  d365.getList = async (entity, opts) => {
    calls.push(opts.select);
    if (/hr_personalphotourl/.test(opts.select)) throw missingPropError('hr_personalphotourl');
    return { data: [{ hr_employeeid: 'EMP1039' }], count: 1 };
  };
  try {
    const r = await d365.getListResilient('hr_hremployees', { select: 'hr_hremployeeid', optionalSelect: 'hr_employeeid,hr_personalphotourl' });
    assert.strictEqual(r.data[0].hr_employeeid, 'EMP1039');
    const finalSelect = calls[calls.length - 1];
    assert.ok(!/hr_personalphotourl/.test(finalSelect) && /hr_employeeid/.test(finalSelect));
  } finally { d365.getList = orig; }
});

test('resilient read re-throws a NON-missing-property error (does not swallow real failures)', async () => {
  const orig = d365.getById;
  d365.getById = async () => { const e = new Error('boom'); e.response = { status: 500, data: {} }; throw e; };
  try {
    await assert.rejects(() => d365.getByIdResilient('hr_hremployees', 'x', { select: 'a', optionalSelect: 'b' }), /boom/);
  } finally { d365.getById = orig; }
});
