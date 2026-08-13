/**
 * Company config — mergeSaved priority (column > blob > default) + locale typing.
 * Multi-company: each company's saved value wins; nothing hard-coded. Pure, no I/O.
 */
process.env.NODE_ENV = 'test';
process.env.AZURE_CLIENT_ID = process.env.AZURE_CLIENT_ID || 'test';
process.env.AZURE_CLIENT_SECRET = process.env.AZURE_CLIENT_SECRET || 'test';
process.env.AZURE_TENANT_ID = process.env.AZURE_TENANT_ID || 'test';

const { test } = require('node:test');
const assert = require('node:assert');
const company = require('../src/services/company.service');
const cc = require('../src/services/company-config.service');

test('company defaults exist for OUR company but are only defaults (not hard-coded)', () => {
  const d = company.COMPANY_DEFAULTS;
  assert.strictEqual(d.hr_currency, 'INR');
  assert.strictEqual(d.hr_currencysymbol, '₹');
  assert.strictEqual(d.hr_timezone, 'Asia/Kolkata');
  assert.strictEqual(d.hr_country, 'India');
});

test('mergeSaved: a live column WINS over a stale blob (Company B: USD over INR)', () => {
  const m = company.mergeSaved({ hr_currency: 'USD', hr_settingsjson: JSON.stringify({ hr_currency: 'INR' }) });
  assert.strictEqual(m.hr_currency, 'USD');
});

test('mergeSaved: blob fills a column that is absent/empty; else default', () => {
  const filled = company.mergeSaved({ hr_settingsjson: JSON.stringify({ hr_timezone: 'America/New_York' }) });
  assert.strictEqual(filled.hr_timezone, 'America/New_York');
  const def = company.mergeSaved({});
  assert.strictEqual(def.hr_timezone, 'Asia/Kolkata');
});

test('localeOf: two companies resolve independently (multi-tenant intent)', () => {
  const a = cc.localeOf({ hr_name: 'Company A', hr_currency: 'INR', hr_currencysymbol: '₹', hr_timezone: 'Asia/Kolkata' });
  const b = cc.localeOf({ hr_name: 'Company B', hr_currency: 'USD', hr_currencysymbol: '$', hr_timezone: 'America/New_York', hr_country: 'USA' });
  assert.strictEqual(a.currency, 'INR'); assert.strictEqual(a.currencySymbol, '₹');
  assert.strictEqual(b.currency, 'USD'); assert.strictEqual(b.currencySymbol, '$'); assert.strictEqual(b.country, 'USA');
});

test('localeOf: sensible defaults when unset', () => {
  const l = cc.localeOf({});
  assert.strictEqual(l.currency, 'INR');
  assert.strictEqual(l.timezone, 'Asia/Kolkata');
  assert.strictEqual(l.dateFormat, 'DD-MM-YYYY');
  assert.strictEqual(l.financialYearStart, '04-01');
});
