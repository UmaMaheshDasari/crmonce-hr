/**
 * Celebrations service — pure date-matching + template logic (no network).
 */
process.env.NODE_ENV = 'test';
process.env.AZURE_CLIENT_ID = process.env.AZURE_CLIENT_ID || 'test-client';
process.env.AZURE_CLIENT_SECRET = process.env.AZURE_CLIENT_SECRET || 'test-secret';
process.env.AZURE_TENANT_ID = process.env.AZURE_TENANT_ID || 'test-tenant';

const { test } = require('node:test');
const assert = require('node:assert');
const svc = require('../src/services/celebrations.service');

test('mmdd: parses YYYY-MM-DD and ISO timestamps', () => {
  assert.strictEqual(svc.mmdd('1990-12-25'), '12-25');
  assert.strictEqual(svc.mmdd('2020-05-01T00:00:00Z'), '05-01');
  assert.strictEqual(svc.mmdd(''), '');
  assert.strictEqual(svc.mmdd(null), '');
});

test('yearOf: extracts the year from a date value', () => {
  assert.strictEqual(svc.yearOf('2018-03-10'), 2018);
  assert.strictEqual(svc.yearOf('2015-01-01T00:00:00Z'), 2015);
  assert.strictEqual(svc.yearOf(''), null);
});

test('firstNameOf: first token of the full name', () => {
  assert.strictEqual(svc.firstNameOf('Vishwesh Kumar Reddy'), 'Vishwesh');
  assert.strictEqual(svc.firstNameOf('  Priya  '), 'Priya');
  assert.strictEqual(svc.firstNameOf(''), 'there');
});

test('fill: replaces placeholders, blanks unknown keys', () => {
  assert.strictEqual(svc.fill('Happy Birthday {firstName}!', { firstName: 'Vishwesh' }), 'Happy Birthday Vishwesh!');
  assert.strictEqual(svc.fill('{years} year(s) at {company}', { years: 5, company: 'CRMONCE' }), '5 year(s) at CRMONCE');
  assert.strictEqual(svc.fill('Hi {missing}', {}), 'Hi ');
});

test('matchesToday: exact month/day match (year-independent)', () => {
  assert.strictEqual(svc.matchesToday('1988-05-01', '2026-05-01'), true);
  assert.strictEqual(svc.matchesToday('1988-05-02', '2026-05-01'), false);
});

test('matchesToday: Feb-29 is observed on Feb-28 in non-leap years only', () => {
  assert.strictEqual(svc.matchesToday('1992-02-29', '2025-02-28'), true);   // 2025 non-leap → observe
  assert.strictEqual(svc.matchesToday('1992-02-29', '2024-02-28'), false);  // 2024 leap → wait for the 29th
  assert.strictEqual(svc.matchesToday('1992-02-29', '2024-02-29'), true);   // leap → exact
});

test('matchesToday: empty / unparseable date never matches', () => {
  assert.strictEqual(svc.matchesToday('', '2026-05-01'), false);
  assert.strictEqual(svc.matchesToday('not-a-date', '2026-05-01'), false);
});

test('EVENTS registry: the three shipped event types are present', () => {
  assert.ok(svc.EVENTS.birthday);
  assert.ok(svc.EVENTS.marriage_anniversary);
  assert.ok(svc.EVENTS.work_anniversary);
});
