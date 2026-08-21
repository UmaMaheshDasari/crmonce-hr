/**
 * Shift History — attendance always uses the shift EFFECTIVE on the attendance date.
 * Pure resolver logic (pickRowForDate / shiftForDateFromMap / shiftFromRow) + late-login
 * boundaries under the resolved historical shift + the change/overlap/same-day flow
 * (d365 stubbed). No network.
 */
process.env.NODE_ENV = 'test';
process.env.AZURE_CLIENT_ID = process.env.AZURE_CLIENT_ID || 'test-client';
process.env.AZURE_CLIENT_SECRET = process.env.AZURE_CLIENT_SECRET || 'test-secret';
process.env.AZURE_TENANT_ID = process.env.AZURE_TENANT_ID || 'test-tenant';

const { test } = require('node:test');
const assert = require('node:assert');
const sh = require('../src/services/shift-history.service');
const d365 = require('../src/services/d365.service');
const { computeSession } = require('../src/services/attendance.util');

// A raw hr_shifthistories row.
const row = (from, to, name, start, end, grace = 5, status = 'active') => ({
  hr_shifthistoryid: `${name}-${from}`, hr_employeeid: 'E1', hr_employeename: 'Vishwesh',
  hr_shiftname: name, hr_shiftstarttime: start, hr_shiftendtime: end, hr_gracemins: String(grace),
  hr_effectivefrom: from, hr_effectiveto: to || '', hr_status: status, createdon: `${from}T00:00:00Z`,
});
// Rows newest-effective-from first (as the resolver expects them loaded).
const desc = (...rs) => rs.slice().sort((a, b) => (a.hr_effectivefrom < b.hr_effectivefrom ? 1 : -1));

const MORNING = row('2026-08-01', '2026-08-20', 'Morning', '09:00', '18:00');
const NIGHT = row('2026-08-21', '', 'Night', '21:00', '06:00');
const EMP_FIELDS = { hr_shiftname: 'Night', hr_shiftstarttime: '21:00', hr_shiftendtime: '06:00' };

// ── pickRowForDate: the attendance date picks the shift ───────────────────────
test('1 — one shift: the date resolves to that shift', () => {
  const rows = desc(row('2026-08-01', '', 'Morning', '09:00', '18:00'));
  assert.strictEqual(sh.pickRowForDate(rows, '2026-08-15').hr_shiftname, 'Morning');
});
test('2/3 — shift changed: yesterday=old, today=new', () => {
  const rows = desc(MORNING, NIGHT);
  assert.strictEqual(sh.pickRowForDate(rows, '2026-08-20').hr_shiftname, 'Morning');
  assert.strictEqual(sh.pickRowForDate(rows, '2026-08-21').hr_shiftname, 'Night');
});
test('4 — future shift does not affect today', () => {
  const rows = desc(row('2026-08-01', '', 'Morning', '09:00', '18:00'), row('2026-08-25', '', 'Night', '21:00', '06:00'));
  assert.strictEqual(sh.pickRowForDate(rows, '2026-08-20').hr_shiftname, 'Morning');   // today, not the future Night
});
test('12 — effective-from boundary is inclusive; the day before is the old shift', () => {
  const rows = desc(MORNING, NIGHT);
  assert.strictEqual(sh.pickRowForDate(rows, '2026-08-21').hr_shiftname, 'Night');       // == effective_from
  assert.strictEqual(sh.pickRowForDate(rows, '2026-08-20').hr_shiftname, 'Morning');     // one day before
});
test('a date before the first assignment → null (caller falls back to current)', () => {
  assert.strictEqual(sh.pickRowForDate(desc(MORNING, NIGHT), '2026-07-31'), null);
});

// ── fallback + map resolution ─────────────────────────────────────────────────
test('15 — no history → falls back to the employee current shift', () => {
  const s = sh.shiftForDateFromMap(new Map(), 'E1', '2026-08-20', EMP_FIELDS);
  assert.strictEqual(s.start, '21:00'); assert.strictEqual(s.isNight, true);
});
test('map resolution: history wins for a past date, current for undated gaps', () => {
  const map = new Map([['E1', desc(MORNING, NIGHT)]]);
  assert.strictEqual(sh.shiftForDateFromMap(map, 'E1', '2026-08-20', EMP_FIELDS).start, '09:00');   // Morning (history)
  assert.strictEqual(sh.shiftForDateFromMap(map, 'E1', '2026-08-22', EMP_FIELDS).start, '21:00');   // Night (history)
});

// ── shiftFromRow: shape + per-shift grace + night detection ───────────────────
test('shiftFromRow returns start/end/isNight/grace from the row', () => {
  const m = sh.shiftFromRow(MORNING);
  assert.strictEqual(m.start, '09:00'); assert.strictEqual(m.isNight, false); assert.strictEqual(m.grace, 5);
  const n = sh.shiftFromRow(row('2026-08-21', '', 'Night', '21:00', '06:00', 7));
  assert.strictEqual(n.start, '21:00'); assert.strictEqual(n.isNight, true); assert.strictEqual(n.grace, 7);
});

// ── Late Login uses the HISTORICAL shift (the core bug) ───────────────────────
test('7/8/11 — Late Login judged by the effective shift (Morning vs Night)', () => {
  const morning = sh.shiftFromRow(MORNING);
  const night = sh.shiftFromRow(NIGHT);
  // 2026-08-20 under Morning 09:00 (+5 grace)
  assert.strictEqual(computeSession(['09:04'], morning, { graceMinutes: morning.grace }).lateEntryMinutes, 0);   // NOT late
  assert.strictEqual(computeSession(['09:06'], morning, { graceMinutes: morning.grace }).lateEntryMinutes, 6);   // Late by 6
  // 2026-08-21 under Night 21:00 (+5 grace) — overnight
  assert.strictEqual(computeSession(['21:04'], night, { graceMinutes: night.grace }).lateEntryMinutes, 0);       // NOT late
  assert.strictEqual(computeSession(['21:06'], night, { graceMinutes: night.grace }).lateEntryMinutes, 6);       // Late by 6
});
test('9 — the OLD bug: a Night 21:04 punch judged under the current Morning shift is falsely very late', () => {
  const morning = sh.shiftFromRow(MORNING);   // simulate the bug: employee moved to Morning, an old Night day recomputed
  // 21:04 vs a 09:00 morning start = ~12h "late" — the exact false positive the fix removes.
  assert.ok(computeSession(['21:04'], morning, { graceMinutes: morning.grace }).lateEntryMinutes > 60);
});

test('8b — Early Out judged by the effective shift END (Morning 18:00)', () => {
  const morning = sh.shiftFromRow(MORNING);   // 09:00–18:00
  const c = computeSession([{ t: '09:00', d: 'in' }, { t: '17:30', d: 'out' }], morning, { graceMinutes: morning.grace });
  assert.strictEqual(c.earlyDepartureMin, 30);   // left 30 min before the Morning end
});

// ── change / overlap / same-day flow (d365 stubbed) ───────────────────────────
function stubStore(initial = []) {
  const rows = initial.slice(); let seq = 0;
  const o = { gl: d365.getListOptional, cr: d365.create, up: d365.update, gb: d365.getById };
  d365.getListOptional = async (_e, opts) => {
    let out = rows.filter(r => String(opts?.filter || '').includes(`'${r.hr_employeeid}'`) || !opts?.filter);
    out = out.sort((a, b) => (a.hr_effectivefrom < b.hr_effectivefrom ? 1 : (a.hr_effectivefrom > b.hr_effectivefrom ? -1 : 0)));
    return { data: out };
  };
  d365.create = async (_e, body) => { const id = `new-${++seq}`; rows.push({ ...body, hr_shifthistoryid: id, createdon: `2026-08-21T00:00:0${seq}Z` }); return { hr_shifthistoryid: id }; };
  d365.update = async (_e, id, patch) => { Object.assign(rows.find(r => r.hr_shifthistoryid === id), patch); };
  d365.getById = async (_e, id) => rows.find(r => r.hr_shifthistoryid === id);
  return { rows, restore() { d365.getListOptional = o.gl; d365.create = o.cr; d365.update = o.up; d365.getById = o.gb; } };
}

test('first change seeds the OLD shift (from joining) + opens the NEW shift', async () => {
  const s = stubStore([]);
  try {
    await sh.changeShift({
      employeeId: 'E1', employeeName: 'Vishwesh', shiftName: 'Night', shiftStart: '21:00', shiftEnd: '06:00',
      effectiveFrom: '2026-08-21', changedBy: 'HR', joiningDate: '2026-08-01',
      oldShift: { shiftName: 'Morning', shiftStart: '09:00', shiftEnd: '18:00' },
    });
    assert.strictEqual(s.rows.length, 2);
    const morning = s.rows.find(r => r.hr_shiftname === 'Morning');
    const night = s.rows.find(r => r.hr_shiftname === 'Night');
    assert.strictEqual(morning.hr_effectivefrom, '2026-08-01');   // seeded from joining date
    assert.strictEqual(morning.hr_effectiveto, '2026-08-20');     // closed the day before the change
    assert.strictEqual(morning.hr_status, 'superseded');
    assert.strictEqual(night.hr_effectivefrom, '2026-08-21');
    assert.strictEqual(night.hr_effectiveto, '');                 // open / current
    assert.strictEqual(night.hr_status, 'active');
    // And now a past date resolves to Morning, the change date to Night.
    assert.strictEqual((await sh.resolveShiftForDate('E1', '2026-08-19')).start, '09:00');
    assert.strictEqual((await sh.resolveShiftForDate('E1', '2026-08-21')).start, '21:00');
  } finally { s.restore(); }
});

test('resolveShiftForDate falls back to the passed employee record when there is no history', async () => {
  const s = stubStore([]);   // empty history table
  try {
    const shift = await sh.resolveShiftForDate('E1', '2026-08-20', { hr_shiftname: 'Morning', hr_shiftstarttime: '09:00', hr_shiftendtime: '18:00' });
    assert.strictEqual(shift.start, '09:00');
    assert.strictEqual(shift.isNight, false);
  } finally { s.restore(); }
});

test('14 — backdating inserts a historical assignment and resequences boundaries (no overlap)', async () => {
  const s = stubStore([MORNING, NIGHT]);   // Morning 08-01..08-20, Night 08-21..open
  try {
    await sh.changeShift({ employeeId: 'E1', employeeName: 'Vishwesh', shiftName: 'Day', shiftStart: '08:00', shiftEnd: '17:00', effectiveFrom: '2026-08-10', changedBy: 'HR' });
    assert.strictEqual(s.rows.length, 3);
    const byFrom = Object.fromEntries(s.rows.map((r) => [r.hr_effectivefrom, r]));
    assert.strictEqual(byFrom['2026-08-01'].hr_effectiveto, '2026-08-09');   // Morning re-closed the day before Day
    assert.strictEqual(byFrom['2026-08-10'].hr_shiftname, 'Day');
    assert.strictEqual(byFrom['2026-08-10'].hr_effectiveto, '2026-08-20');   // Day runs until the day before Night
    assert.strictEqual(byFrom['2026-08-21'].hr_effectiveto, '');             // Night still open-ended
    assert.strictEqual((await sh.resolveShiftForDate('E1', '2026-08-05')).start, '09:00');  // Morning
    assert.strictEqual((await sh.resolveShiftForDate('E1', '2026-08-15')).start, '08:00');  // Day
    assert.strictEqual((await sh.resolveShiftForDate('E1', '2026-08-25')).start, '21:00');  // Night
  } finally { s.restore(); }
});

test('13 — same-day change corrects the open row in place (no new row)', async () => {
  const s = stubStore([row('2026-08-21', '', 'Night', '21:00', '06:00')]);
  try {
    await sh.changeShift({ employeeId: 'E1', employeeName: 'Vishwesh', shiftName: 'Day', shiftStart: '08:00', shiftEnd: '17:00', effectiveFrom: '2026-08-21', changedBy: 'HR' });
    assert.strictEqual(s.rows.length, 1);                     // corrected, not stacked
    assert.strictEqual(s.rows[0].hr_shiftname, 'Day');
    assert.strictEqual(s.rows[0].hr_shiftstarttime, '08:00');
  } finally { s.restore(); }
});
