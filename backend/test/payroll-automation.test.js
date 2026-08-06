/**
 * Payroll Automation — pure job-status / retry logic (no network).
 */
process.env.NODE_ENV = 'test';
process.env.AZURE_CLIENT_ID = process.env.AZURE_CLIENT_ID || 'test-client';
process.env.AZURE_CLIENT_SECRET = process.env.AZURE_CLIENT_SECRET || 'test-secret';
process.env.AZURE_TENANT_ID = process.env.AZURE_TENANT_ID || 'test-tenant';

const { test } = require('node:test');
const assert = require('node:assert');
const a = require('../src/services/payroll-automation.service');

const mk = (arr) => arr.map(([key, status, critical = false]) => ({ key, status, critical }));

test('blankStages: all pending, payroll + payslip are critical', () => {
  const s = a.blankStages();
  assert.ok(s.every(x => x.status === 'pending'));
  assert.strictEqual(s.find(x => x.key === 'payroll').critical, true);
  assert.strictEqual(s.find(x => x.key === 'attendance').critical, false);
});

test('deriveStatus: all success → completed', () => {
  assert.strictEqual(a.deriveStatus(mk([['attendance', 'success'], ['payroll', 'success', true], ['payslip', 'success', true]])), 'completed');
});

test('deriveStatus: a critical failure → failed', () => {
  assert.strictEqual(a.deriveStatus(mk([['attendance', 'success'], ['payroll', 'failed', true], ['payslip', 'pending', true]])), 'failed');
});

test('deriveStatus: only a non-critical failure (rest done) → partial', () => {
  assert.strictEqual(a.deriveStatus(mk([['attendance', 'failed'], ['leave', 'success'], ['lop', 'success'], ['payroll', 'success', true], ['payslip', 'success', true]])), 'partial');
});

test('deriveStatus: still running while pending remain', () => {
  assert.strictEqual(a.deriveStatus(mk([['attendance', 'success'], ['payroll', 'running', true], ['payslip', 'pending', true]])), 'running');
});

test('stagesToRetry: only the not-succeeded stages', () => {
  const keys = a.stagesToRetry(mk([['attendance', 'success'], ['leave', 'failed'], ['payroll', 'pending', true], ['payslip', 'success', true]]));
  assert.deepStrictEqual(keys, ['leave', 'payroll']);
});

test('shapeJob: parses stage/log/summary JSON and numbers', () => {
  const job = a.shapeJob({
    hr_payrolljobid: 'j1', hr_month: '8', hr_year: '2026', hr_status: 'completed',
    hr_stages: JSON.stringify([{ key: 'payroll', status: 'success' }]),
    hr_logs: JSON.stringify([{ level: 'info', message: 'ok' }]),
    hr_summary: JSON.stringify({ payroll: { created: 3 } }),
  });
  assert.strictEqual(job.month, 8);
  assert.strictEqual(job.year, 2026);
  assert.strictEqual(job.stages[0].key, 'payroll');
  assert.strictEqual(job.summary.payroll.created, 3);
  assert.strictEqual(job.logs.length, 1);
});

test('shapeJob: tolerates missing/broken JSON', () => {
  const job = a.shapeJob({ hr_payrolljobid: 'j2', hr_stages: 'not json' });
  assert.deepStrictEqual(job.stages, []);
  assert.deepStrictEqual(job.logs, []);
});
