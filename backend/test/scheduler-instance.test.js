/**
 * Scheduler single-instance gate — the fix for duplicate scheduled notifications.
 *
 * Under PM2 cluster mode every worker runs server.js → initJobs(). Without gating,
 * each cron fires once PER worker → duplicate emails (Missing Punch x2, Work
 * Anniversary x2). initJobs must register the scheduler in ONLY the primary instance.
 */
process.env.NODE_ENV = 'test';
process.env.AZURE_CLIENT_ID = process.env.AZURE_CLIENT_ID || 'test-client';
process.env.AZURE_CLIENT_SECRET = process.env.AZURE_CLIENT_SECRET || 'test-secret';
process.env.AZURE_TENANT_ID = process.env.AZURE_TENANT_ID || 'test-tenant';

const { test } = require('node:test');
const assert = require('node:assert');
const cron = require('node-cron');
const { isSchedulerInstance, initJobs } = require('../src/jobs');

function withEnv(vars, fn) {
  const prev = {};
  for (const k of Object.keys(vars)) { prev[k] = process.env[k]; if (vars[k] === undefined) delete process.env[k]; else process.env[k] = vars[k]; }
  try { return fn(); } finally { for (const k of Object.keys(prev)) { if (prev[k] === undefined) delete process.env[k]; else process.env[k] = prev[k]; } }
}

test('isSchedulerInstance: primary (undefined / "" / "0") → true; workers ("1","2") → false', () => {
  assert.strictEqual(withEnv({ NODE_APP_INSTANCE: undefined, SCHEDULER_ENABLED: undefined }, isSchedulerInstance), true);
  assert.strictEqual(withEnv({ NODE_APP_INSTANCE: '', SCHEDULER_ENABLED: undefined }, isSchedulerInstance), true);
  assert.strictEqual(withEnv({ NODE_APP_INSTANCE: '0', SCHEDULER_ENABLED: undefined }, isSchedulerInstance), true);
  assert.strictEqual(withEnv({ NODE_APP_INSTANCE: '1', SCHEDULER_ENABLED: undefined }, isSchedulerInstance), false);
  assert.strictEqual(withEnv({ NODE_APP_INSTANCE: '2', SCHEDULER_ENABLED: undefined }, isSchedulerInstance), false);
});

test('SCHEDULER_ENABLED=false disables the scheduler even on the primary instance', () => {
  assert.strictEqual(withEnv({ NODE_APP_INSTANCE: '0', SCHEDULER_ENABLED: 'false' }, isSchedulerInstance), false);
});

test('initJobs registers ZERO cron jobs on a non-primary worker (kills the duplicate scheduler)', () => {
  const orig = cron.schedule; let calls = 0;
  cron.schedule = () => { calls++; return { stop() {} }; };
  try { withEnv({ NODE_APP_INSTANCE: '1', SCHEDULER_ENABLED: undefined }, () => initJobs()); }
  finally { cron.schedule = orig; }
  assert.strictEqual(calls, 0, 'worker instance schedules nothing');
});

test('initJobs registers the cron jobs on the primary instance', () => {
  const orig = cron.schedule; let calls = 0;
  cron.schedule = () => { calls++; return { stop() {} }; };
  try { withEnv({ NODE_APP_INSTANCE: '0', SCHEDULER_ENABLED: undefined, ATTENDANCE_EXCEPTION_SCAN: undefined, CELEBRATIONS_SCHEDULER: undefined }, () => initJobs()); }
  finally { cron.schedule = orig; }
  assert.ok(calls > 0, 'primary instance schedules the jobs exactly once');
});
