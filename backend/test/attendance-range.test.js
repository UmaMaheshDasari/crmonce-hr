/**
 * Dynamic Attendance Start Date — each employee's earliest attendance record (of
 * ANY source) becomes their minimum selectable date, and every range is clamped to
 * it. No hardcoded dates.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const { earliestAttendanceDate, clampRangeToStart } = require('../src/services/attendance-range.util');

test('Earliest date is the min across ALL sources (device / web / manual)', () => {
  const records = [
    { hr_date: '2026-07-01', hr_source: 123140000 }, // device
    { hr_date: '2026-04-07', hr_source: 123140002 }, // web check-in — earliest
    { hr_date: '2026-06-18', hr_source: 123140001 }, // manual correction
  ];
  assert.strictEqual(earliestAttendanceDate(records), '2026-04-07');
});

test('Earliest date reads either hr_date (raw) or date (computed session)', () => {
  assert.strictEqual(earliestAttendanceDate([{ date: '2026-05-10' }, { date: '2026-05-02' }]), '2026-05-02');
});

test('No attendance history → null (never a hardcoded fallback date)', () => {
  assert.strictEqual(earliestAttendanceDate([]), null);
  assert.strictEqual(earliestAttendanceDate([{ hr_date: '' }, {}]), null);
});

// Each employee has a DIFFERENT first attendance date → a different clamped range.
const EMPLOYEES = [
  { name: 'A', firstDate: '2026-04-07' },
  { name: 'B', firstDate: '2026-06-18' },
  { name: 'C', firstDate: '2026-07-01' },
];

test('This Year (Jan 1 → today) is clamped to each employee\'s own first date', () => {
  const today = '2026-07-30';
  for (const e of EMPLOYEES) {
    const r = clampRangeToStart('2026-01-01', today, e.firstDate);
    assert.strictEqual(r.from, e.firstDate, `employee ${e.name} starts at their own first date`);
    assert.strictEqual(r.to, today);
    assert.strictEqual(r.clamped, true);
  }
  // Every employee sees a DIFFERENT minimum selectable date.
  const mins = EMPLOYEES.map(e => clampRangeToStart('2026-01-01', today, e.firstDate).from);
  assert.strictEqual(new Set(mins).size, EMPLOYEES.length);
});

test('A range that already starts on/after the first date is untouched', () => {
  const r = clampRangeToStart('2026-07-01', '2026-07-31', '2026-06-18');
  assert.deepStrictEqual(r, { from: '2026-07-01', to: '2026-07-31', clamped: false });
});

test('A range entirely before the first date is pulled up to it (from may exceed to)', () => {
  // Employee C (01 Jul) selecting "Last Month" (June) → clamped to 01 Jul → empty.
  const r = clampRangeToStart('2026-06-01', '2026-06-30', '2026-07-01');
  assert.strictEqual(r.from, '2026-07-01');
  assert.strictEqual(r.clamped, true);
  assert.ok(r.from > r.to, 'no attendance exists before the start date → empty range');
});

test('No start date (no history) → range unchanged, never clamped to a fixed date', () => {
  const r = clampRangeToStart('2026-01-01', '2026-07-30', null);
  assert.deepStrictEqual(r, { from: '2026-01-01', to: '2026-07-30', clamped: false });
});
