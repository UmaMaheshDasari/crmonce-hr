const { test } = require('node:test');
const assert = require('node:assert');
const t = require('../src/services/time.util');

// ── 12-hour formatting (bare IST "HH:MM" → h:MM AM/PM) ──────────────────────
test('to12h: all required conversions', () => {
  assert.strictEqual(t.to12h('03:44'), '3:44 AM');
  assert.strictEqual(t.to12h('09:05'), '9:05 AM');
  assert.strictEqual(t.to12h('12:00'), '12:00 PM');
  assert.strictEqual(t.to12h('15:31'), '3:31 PM');
  assert.strictEqual(t.to12h('18:45'), '6:45 PM');
  assert.strictEqual(t.to12h('21:10'), '9:10 PM');
  assert.strictEqual(t.to12h('23:55'), '11:55 PM');
  assert.strictEqual(t.to12h('00:05'), '12:05 AM');   // midnight hour
});

// ── UTC instant → Asia/Kolkata (the actual bug: 03:44 UTC == 9:14 AM IST) ────
test('UTC 03:44 renders as 9:14 AM IST', () => {
  const d = new Date('2026-07-14T03:44:00Z');
  assert.strictEqual(t.istHHMM(d), '09:14');
  assert.strictEqual(t.fmtTime(d), '9:14 AM');
  assert.strictEqual(t.istDateStr(d), '2026-07-14');
});

test('UTC evening crosses into next IST day', () => {
  const d = new Date('2026-07-13T20:00:00Z');           // 01:30 IST on the 14th
  assert.strictEqual(t.fmtTime(d), '1:30 AM');
  assert.strictEqual(t.istDateStr(d), '2026-07-14');
});

test('fmtDate: YYYY-MM-DD → DD Mon YYYY', () => {
  assert.strictEqual(t.fmtDate('2026-07-10'), '10 Jul 2026');
  assert.strictEqual(t.fmtDate('2026-01-01'), '01 Jan 2026');
});

// ── Relative time (right-hand column) ───────────────────────────────────────
test('relative: Just now / minutes / hours / Yesterday / days', () => {
  const now = new Date('2026-07-14T12:00:00Z');
  const ago = (ms) => new Date(now.getTime() - ms).toISOString();
  assert.strictEqual(t.relative(ago(10 * 1000), now), 'Just now');
  assert.strictEqual(t.relative(ago(1 * 60000), now), '1 minute ago');
  assert.strictEqual(t.relative(ago(15 * 60000), now), '15 minutes ago');
  assert.strictEqual(t.relative(ago(60 * 60000), now), '1 hour ago');
  assert.strictEqual(t.relative(ago(26 * 3600000), now), 'Yesterday');
  assert.strictEqual(t.relative(ago(3 * 24 * 3600000), now), '3 days ago');
});

// ── Day + time (leave events) ───────────────────────────────────────────────
test('dayTime: Today / Yesterday with IST time', () => {
  const now = new Date('2026-07-14T12:00:00Z');         // 17:30 IST on the 14th
  assert.strictEqual(t.dayTime('2026-07-14T05:55:00Z', now), 'Today 11:25 AM');
  assert.strictEqual(t.dayTime('2026-07-13T09:15:00Z', now), 'Yesterday 2:45 PM');
});
