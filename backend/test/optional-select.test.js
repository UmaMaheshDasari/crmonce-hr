/**
 * getListOptional / getByIdOptional — graceful degradation when an optional
 * Dataverse column (e.g. hr_optcol) doesn't exist yet. No network: d365.getList /
 * getById are stubbed on the instance.
 */
process.env.NODE_ENV = 'test';
process.env.AZURE_CLIENT_ID = process.env.AZURE_CLIENT_ID || 'test-client';
process.env.AZURE_CLIENT_SECRET = process.env.AZURE_CLIENT_SECRET || 'test-secret';
process.env.AZURE_TENANT_ID = process.env.AZURE_TENANT_ID || 'test-tenant';

const { test } = require('node:test');
const assert = require('node:assert');
const d365 = require('../src/services/d365.service');

const missingPropErr = () => {
  const e = new Error('bad request');
  e.response = { status: 400, data: { error: { message: "Could not find a property named 'hr_optcol' on type 'Microsoft.Dynamics.CRM.hr_hremployee'." } } };
  return e;
};

test('_isMissingProperty detects the Dataverse "property not found" 400', () => {
  assert.strictEqual(d365._isMissingProperty(missingPropErr()), true);
  assert.strictEqual(d365._isMissingProperty({ response: { status: 500, data: {} } }), false);
  assert.strictEqual(d365._isMissingProperty({ response: { status: 400, data: { error: { message: 'Some other error' } } } }), false);
});

test('getListOptional: retries WITHOUT optional columns when they do not exist', async () => {
  const calls = [];
  const orig = d365.getList;
  d365.getList = async (entity, params) => {
    calls.push(params.select);
    if (params.select.includes('hr_optcol')) throw missingPropErr();
    return { data: [{ hr_hremployeeid: '1' }], count: 1 };
  };
  try {
    const r = await d365.getListOptional('emps', { select: 'hr_hremployeeid', optionalSelect: 'hr_optcol,hr_optcol2' });
    assert.strictEqual(r.count, 1);                                   // list NOT empty
    assert.strictEqual(calls.length, 2);                             // tried full, then base
    assert.ok(calls[0].includes('hr_optcol'));
    assert.ok(!calls[1].includes('hr_optcol'));
  } finally { d365.getList = orig; }
});

test('getListOptional: single call when optional columns exist', async () => {
  const calls = [];
  const orig = d365.getList;
  d365.getList = async (entity, params) => { calls.push(params.select); return { data: [], count: 0 }; };
  try {
    await d365.getListOptional('emps', { select: 'hr_hremployeeid', optionalSelect: 'hr_optcol' });
    assert.strictEqual(calls.length, 1);
    assert.ok(calls[0].includes('hr_optcol'));
  } finally { d365.getList = orig; }
});

test('getListOptional: re-throws unrelated errors (does not mask real failures)', async () => {
  const orig = d365.getList;
  d365.getList = async () => { const e = new Error('boom'); e.response = { status: 500, data: {} }; throw e; };
  try {
    await assert.rejects(() => d365.getListOptional('e', { select: 'a', optionalSelect: 'b' }), /boom/);
  } finally { d365.getList = orig; }
});

test('getByIdOptional: retries without optional columns on missing property', async () => {
  const calls = [];
  const orig = d365.getById;
  d365.getById = async (entity, id, params) => {
    calls.push(params.select);
    if (params.select.includes('hr_optcol')) throw missingPropErr();
    return { hr_hremployeeid: id };
  };
  try {
    const r = await d365.getByIdOptional('emps', 'E1', { select: 'hr_hremployeeid', optionalSelect: 'hr_optcol,hr_optcol2' });
    assert.strictEqual(r.hr_hremployeeid, 'E1');
    assert.strictEqual(calls.length, 2);
  } finally { d365.getById = orig; }
});
