/**
 * Employee experience (tenure) — calendar Years/Months/Days from DOJ to an as-of date.
 * Verifies the calendar borrow (NOT days/365), leap years, month-end edges, and the safe
 * handling of missing / invalid / future joining dates, plus the exported row/column shape.
 */
process.env.NODE_ENV = 'test';
const { test } = require('node:test');
const assert = require('node:assert');
const { calcExperience, experienceRow, EXPERIENCE_COLUMNS } = require('../src/services/experience.util');

test('whole years only — 2020-01-15 → 2026-01-15 = 6 Years, 0 Months, 0 Days', () => {
  const e = calcExperience('2020-01-15', '2026-01-15');
  assert.deepStrictEqual([e.years, e.months, e.days], [6, 0, 0]);
  assert.strictEqual(e.text, '6 Years, 0 Months, 0 Days');
  assert.strictEqual(e.valid, true);
  assert.strictEqual(e.future, false);
});

test('mixed Y/M/D with a day-borrow — 2021-03-20 → 2026-10-19 = 5 Years, 6 Months, 29 Days', () => {
  // From Mar 20: day 19 < 20 → borrow Sep (30 days): 19 + 30 − 20 = 29 days; months 10−3−1 = 6.
  const e = calcExperience('2021-03-20', '2026-10-19');
  assert.deepStrictEqual([e.years, e.months, e.days], [5, 6, 29]);
});

test('spec example format — 3 Years, 4 Months, 12 Days', () => {
  const e = calcExperience('2023-06-07', '2026-10-19');
  assert.deepStrictEqual([e.years, e.months, e.days], [3, 4, 12]);
  assert.strictEqual(e.text, '3 Years, 4 Months, 12 Days');
});

test('singular pluralisation — 1 Year, 1 Month, 1 Day', () => {
  const e = calcExperience('2025-09-18', '2026-10-19');
  assert.deepStrictEqual([e.years, e.months, e.days], [1, 1, 1]);
  assert.strictEqual(e.text, '1 Year, 1 Month, 1 Day');
});

test('leap day — joined 2020-02-29, as of 2021-02-28 = 1 Year (Feb 29 anniversary clamps to Feb 28)', () => {
  // Feb 29 + 1 year clamps to Feb 28 2021, which equals the as-of date → a full year, 0M 0D.
  const e = calcExperience('2020-02-29', '2021-02-28');
  assert.deepStrictEqual([e.years, e.months, e.days], [1, 0, 0]);
});

test('leap day exact anniversary — 2020-02-29 → 2024-02-29 = 4 Years, 0 Months, 0 Days', () => {
  const e = calcExperience('2020-02-29', '2024-02-29');
  assert.deepStrictEqual([e.years, e.months, e.days], [4, 0, 0]);
});

test('month-end edge — 2026-01-31 to 2026-03-01 = 0 Years, 1 Month, 1 Day (never negative days)', () => {
  // Jan 31 + 1 month clamps to Feb 28 2026; Feb 28 to Mar 1 is 1 day. A naive day-borrow would
  // produce a nonsensical negative day count here — this is the case that drove the clamped
  // incremental algorithm.
  const e = calcExperience('2026-01-31', '2026-03-01');
  assert.deepStrictEqual([e.years, e.months, e.days], [0, 1, 1]);
  assert.ok(e.days >= 0 && e.months >= 0 && e.years >= 0);
});

test('same day — DOJ equals as-of → 0 Years, 0 Months, 0 Days', () => {
  const e = calcExperience('2026-10-19', '2026-10-19');
  assert.deepStrictEqual([e.years, e.months, e.days], [0, 0, 0]);
  assert.strictEqual(e.text, '0 Years, 0 Months, 0 Days');
});

test('missing DOJ → No Joining Date, not valid, zeroed', () => {
  for (const bad of ['', null, undefined, '   ']) {
    const e = calcExperience(bad, '2026-10-19');
    assert.strictEqual(e.valid, false);
    assert.strictEqual(e.text, 'No Joining Date');
    assert.deepStrictEqual([e.years, e.months, e.days], [0, 0, 0]);
    assert.strictEqual(e.dojDisplay, '—');
  }
});

test('invalid / impossible DOJ → No Joining Date', () => {
  for (const bad of ['not-a-date', '2026-13-01', '2026-02-30', '19-10-2026']) {
    const e = calcExperience(bad, '2026-10-19');
    assert.strictEqual(e.valid, false, `expected ${bad} invalid`);
    assert.strictEqual(e.text, 'No Joining Date');
  }
});

test('future DOJ → never negative; clearly flagged as not joined yet', () => {
  const e = calcExperience('2027-01-01', '2026-10-19');
  assert.strictEqual(e.future, true);
  assert.strictEqual(e.valid, true);
  assert.deepStrictEqual([e.years, e.months, e.days], [0, 0, 0]);
  assert.match(e.text, /^Not joined yet \(joins 01-01-2027\)$/);
});

test('ISO datetime DOJ is accepted (only the date part is used)', () => {
  const e = calcExperience('2023-06-07T00:00:00Z', '2026-10-19');
  assert.deepStrictEqual([e.years, e.months, e.days], [3, 4, 12]);
});

// ── Exported row / column contents (what lands in the .xlsx cells) ──────────────
test('columns match the required spec order and headers', () => {
  assert.deepStrictEqual(EXPERIENCE_COLUMNS.map(c => c.header), [
    'Employee ID', 'Employee Name', 'Date of Joining', 'Current Date', 'Total Experience',
  ]);
});

test('experienceRow — normal employee: dates DD-MM-YYYY, readable experience', () => {
  const row = experienceRow({ eid: 'EMP1039', name: 'Boina Vishwesh', doj: '2023-06-07' }, '2026-10-19');
  assert.deepStrictEqual(row, {
    eid: 'EMP1039', name: 'Boina Vishwesh', doj: '07-06-2023', current: '19-10-2026', experience: '3 Years, 4 Months, 12 Days',
  });
});

test('experienceRow — missing DOJ: dash + No Joining Date, still shows id/name/current date', () => {
  const row = experienceRow({ eid: 'EMP1040', name: 'Shaik Samrin', doj: null }, '2026-10-19');
  assert.strictEqual(row.doj, '—');
  assert.strictEqual(row.experience, 'No Joining Date');
  assert.strictEqual(row.current, '19-10-2026');
  assert.strictEqual(row.eid, 'EMP1040');
});

test('experienceRow — future DOJ: experience flagged, DOJ shown, not negative', () => {
  const row = experienceRow({ eid: 'EMP9999', name: 'New Hire', doj: '2027-01-01' }, '2026-10-19');
  assert.strictEqual(row.doj, '01-01-2027');
  assert.match(row.experience, /Not joined yet/);
});

test('experienceRow — blank id/name fall back to dash (never undefined cells)', () => {
  const row = experienceRow({ eid: '', name: '', doj: '2020-01-01' }, '2026-10-19');
  assert.strictEqual(row.eid, '—');
  assert.strictEqual(row.name, '—');
});
