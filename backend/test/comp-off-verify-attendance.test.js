/**
 * Comp-Off attendance verification (the HR "Check Attendance" data + authoritative
 * eligibility). Reads the employee's attendance for the worked date and returns the full
 * display object + eligibility — same rule as approve()/scanMonthCompOff (never rounded up).
 *
 * No network: getRaw (d365.getById) + attendance (d365.getList) + attnCfg stubbed.
 */
process.env.NODE_ENV = 'test';
process.env.AZURE_CLIENT_ID = process.env.AZURE_CLIENT_ID || 'test-client';
process.env.AZURE_CLIENT_SECRET = process.env.AZURE_CLIENT_SECRET || 'test-secret';
process.env.AZURE_TENANT_ID = process.env.AZURE_TENANT_ID || 'test-tenant';

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const d365 = require('../src/services/d365.service');
const attnCfg = require('../src/services/attendance.config');
const compOff = require('../src/services/comp-off.service');
const { toValue } = require('../src/services/picklist');

const EMP = 'e1';
const HOLIDAY = '2026-05-28';
const PRESENT = toValue('hr_attendance_status', 'present');
const DEVICE = toValue('hr_attendance_source', 'etime_device');

let orig;
beforeEach(() => { orig = { gid: d365.getById, gl: d365.getList, woff: attnCfg.weekOffDays }; });
afterEach(() => { d365.getById = orig.gid; d365.getList = orig.gl; attnCfg.weekOffDays = orig.woff; });

const attRow = (over = {}) => ({ _hr_hremployee_value: EMP, hr_date: HOLIDAY, hr_status: PRESENT, hr_intime: '13:30', hr_outtime: '23:41', hr_effectivehours: 9.28, hr_breakduration: 0.9, hr_source: DEVICE, hr_allpunches: '["13:30","23:41"]', hr_punchcount: 2, ...over });

function stub({ type = 'auto', workedDate = HOLIDAY, holidays = [HOLIDAY], weekOff = [0, 6], att } = {}) {
  attnCfg.weekOffDays = weekOff; attnCfg.setDynamicHolidays(holidays);
  const row = { hr_compoffid: 'c1', hr_type: type, hr_employeeid: EMP, hr_employeename: 'Pavan', hr_workeddate: workedDate, hr_status: 'pending', hr_days: '1' };
  d365.getById = async () => row;
  d365.getList = async (entity) => (entity === d365.constructor.entities.attendance ? { data: att ? [att] : [] } : { data: [] });
}
const verify = () => compOff.attendanceVerification('c1');

// ── 1. no attendance ──
test('1. no attendance → NOT ELIGIBLE, attendanceFound false', async () => {
  stub({ att: undefined });
  const v = await verify();
  assert.strictEqual(v.attendanceFound, false);
  assert.strictEqual(v.eligible, false);
  assert.strictEqual(v.eligibleDays, 0);
  assert.strictEqual(v.eligibilityLabel, 'NOT ELIGIBLE');
});

// ── 2–7. hours thresholds on a holiday ──
test('2a. 4h59m → NOT ELIGIBLE (below 5h)', async () => { stub({ att: attRow({ hr_effectivehours: 5 - 1 / 60 }) }); const v = await verify(); assert.strictEqual(v.eligible, false); assert.strictEqual(v.eligibleDays, 0); });
test('2b. exactly 5h → ELIGIBLE 0.5 (new rule)', async () => { stub({ att: attRow({ hr_effectivehours: 5 }) }); const v = await verify(); assert.strictEqual(v.eligible, true); assert.strictEqual(v.eligibleDays, 0.5); });
test('3. 5h01m → 0.5 (HALF DAY)', async () => { stub({ att: attRow({ hr_effectivehours: 5 + 1 / 60 }) }); const v = await verify(); assert.strictEqual(v.eligibleDays, 0.5); assert.strictEqual(v.eligibilityLabel, 'HALF DAY – 0.5'); });
test('4. 6h → 0.5', async () => { stub({ att: attRow({ hr_effectivehours: 6 }) }); assert.strictEqual((await verify()).eligibleDays, 0.5); });
test('5. 7h59m → 0.5', async () => { stub({ att: attRow({ hr_effectivehours: 7 + 59 / 60 }) }); assert.strictEqual((await verify()).eligibleDays, 0.5); });
test('6. 8h → 1 (FULL DAY)', async () => { stub({ att: attRow({ hr_effectivehours: 8 }) }); const v = await verify(); assert.strictEqual(v.eligibleDays, 1); assert.strictEqual(v.eligibilityLabel, 'FULL DAY – 1'); });
test('7. 9h 17m → 1, hours label formatted', async () => { stub({ att: attRow({ hr_effectivehours: 9.28 }) }); const v = await verify(); assert.strictEqual(v.eligibleDays, 1); assert.strictEqual(v.attendance.effectiveHoursLabel, '9h 17m'); });

// ── 8. company holiday + valid attendance → eligible ──
test('8. company holiday + valid attendance → eligible, holiday true', async () => {
  stub({ holidays: [HOLIDAY], att: attRow({ hr_effectivehours: 8 }) });
  const v = await verify();
  assert.strictEqual(v.holiday, true);
  assert.strictEqual(v.eligible, true);
  assert.strictEqual(v.attendance.source, 'Device');
});

// ── 9. weekly off + valid attendance → eligible ──
test('9. weekly-off + valid attendance → eligible, weeklyOff true', async () => {
  const dow = new Date(`${HOLIDAY}T00:00:00Z`).getUTCDay();
  stub({ holidays: [], weekOff: [dow], att: attRow({ hr_effectivehours: 8 }) });
  const v = await verify();
  assert.strictEqual(v.holiday, false);
  assert.strictEqual(v.weeklyOff, true);
  assert.strictEqual(v.eligible, true);
});

// ── 11. missing / invalid punches handled safely ──
test('11a. no in-time (missing punch) → NOT ELIGIBLE (did not work)', async () => {
  stub({ att: attRow({ hr_intime: '', hr_effectivehours: 8 }) });
  const v = await verify();
  assert.strictEqual(v.eligible, false);
  assert.match(v.eligibilityReason, /did not actually work/i);
});
test('11b. malformed punches JSON → handled, empty punches array', async () => {
  stub({ att: attRow({ hr_allpunches: '{not json', hr_effectivehours: 8 }) });
  const v = await verify();
  assert.deepStrictEqual(v.attendance.punches, []);
  assert.strictEqual(v.eligible, true);   // hours still qualify
});

// ── auto record on a NORMAL working day → not eligible (not holiday/weekly-off) ──
test('auto comp-off on a normal working day → NOT ELIGIBLE', async () => {
  stub({ holidays: [], weekOff: [], att: attRow({ hr_effectivehours: 9 }) });
  const v = await verify();
  assert.strictEqual(v.eligible, false);
  assert.match(v.eligibilityReason, /Holiday or Weekly-Off/i);
});

// ── manual grant is not gated on holiday/weekly-off (HR discretion) ──
test('manual grant → eligibility follows hours only (no holiday gate)', async () => {
  stub({ type: 'manual', holidays: [], weekOff: [], att: attRow({ hr_effectivehours: 8 }) });
  const v = await verify();
  assert.strictEqual(v.eligible, true);
  assert.strictEqual(v.eligibleDays, 1);
});
