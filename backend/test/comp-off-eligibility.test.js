/**
 * Comp Off — NEW 5-hour eligibility rule (auto + manual).
 *
 *   effective worked hours < 5h  → NOT eligible (no auto comp-off; manual rejected)
 *   effective worked hours >= 5h → eligible (0.5 day; >= 8h → 1 day)
 * Hours are ALWAYS computed from real attendance punches (never trusted from input),
 * using the SAME computeSession calc + the shift effective ON that date (shift history).
 * Manual requests are validated server-side and go to HR review (never auto-approved).
 */
process.env.NODE_ENV = 'test';
process.env.AZURE_CLIENT_ID = process.env.AZURE_CLIENT_ID || 'x';
process.env.AZURE_CLIENT_SECRET = process.env.AZURE_CLIENT_SECRET || 'x';
process.env.AZURE_TENANT_ID = process.env.AZURE_TENANT_ID || 'x';

const { test } = require('node:test');
const assert = require('node:assert');
const compOff = require('../src/services/comp-off.service');
const d365 = require('../src/services/d365.service');
const shiftHistory = require('../src/services/shift-history.service');

const ATT = d365.constructor.entities.attendance;
const COMP = d365.constructor.entities.compOff;
const EMP = 'emp-1';

// Build an attendance record with a punch pair for N effective hours (no breaks).
const attRec = (hours, date = '2026-08-16') => {
  const end = 9 * 60 + Math.round(hours * 60);
  const out = `${String(Math.floor(end / 60)).padStart(2, '0')}:${String(end % 60).padStart(2, '0')}`;
  return { hr_hrattendanceid: 'a1', hr_date: date, hr_intime: '09:00', hr_outtime: out, hr_allpunches: JSON.stringify(['09:00', out]), hr_punchcount: 2, hr_status: 123140001 };
};

// Stub d365 + shift-history. attendance() supplies the day's record (or null); comp() the
// existing comp-offs for dedup. Records the shift-history date it was asked for.
function stub({ attendance = null, comp = [] } = {}) {
  const o = { gl: d365.getList, sr: shiftHistory.resolveShiftForDate };
  const seen = { shiftDate: null };
  d365.getList = async (entity, opts) => {
    if (entity === ATT) return { data: attendance ? [attendance] : [] };
    if (entity === COMP) return { data: comp };
    return { data: [] };
  };
  shiftHistory.resolveShiftForDate = async (empId, ds) => { seen.shiftDate = ds; return { code: 'GEN', name: 'General', start: '09:00', end: '18:00', durationHours: 9, isNight: false, grace: 5 }; };
  return { seen, restore() { d365.getList = o.gl; shiftHistory.resolveShiftForDate = o.sr; } };
}

// ── The hours→days rule + eligibility boundary (auto tests 1–5) ────────
test('compOffDaysForHours: <5h → 0, exactly 5h → 0.5, >=8h → 1', () => {
  assert.equal(compOff.compOffDaysForHours(4), 0);       // 4h → no comp-off
  assert.equal(compOff.compOffDaysForHours(4.983), 0);   // 4h 59m → no comp-off
  assert.equal(compOff.compOffDaysForHours(5), 0.5);     // exactly 5h → eligible
  assert.equal(compOff.compOffDaysForHours(5.017), 0.5); // 5h 1m → eligible
  assert.equal(compOff.compOffDaysForHours(7), 0.5);     // 7h → eligible
  assert.equal(compOff.compOffDaysForHours(8), 1);       // 8h → full day
});

test('isEligibleHours: 5h is the floor', () => {
  assert.equal(compOff.isEligibleHours(4.999), false);
  assert.equal(compOff.isEligibleHours(5), true);
});

// ── workedHoursForDate: real punches, historical shift (tests 6, 17) ───
test('workedHoursForDate computes effective hours from punches + historical shift', async () => {
  const s = stub({ attendance: attRec(6, '2026-08-20') });
  try {
    const w = await compOff.workedHoursForDate(EMP, '2026-08-20');
    assert.equal(w.hasAttendance, true);
    assert.equal(w.effectiveHours, 6);
    assert.equal(w.eligible, true);
    assert.equal(w.firstPunch, '09:00');
    assert.equal(w.shiftName, 'General');
    assert.equal(s.seen.shiftDate, '2026-08-20');   // shift resolved for THAT date (history)
  } finally { s.restore(); }
});

test('workedHoursForDate: no attendance → not eligible', async () => {
  const s = stub({ attendance: null });
  try {
    const w = await compOff.workedHoursForDate(EMP, '2026-08-20');
    assert.equal(w.hasAttendance, false);
    assert.equal(w.eligible, false);
  } finally { s.restore(); }
});

// ── validateManualCompOff (manual tests 8–16) ─────────────────────────
const MSG_5H = 'Comp Off is not available for this date. A minimum of 5 working hours is required.';

test('manual 4h → rejected with the 5-hour message (test 8)', async () => {
  const s = stub({ attendance: attRec(4) });
  try {
    const v = await compOff.validateManualCompOff({ employeeId: EMP, workedDate: '2026-08-16', workReport: 'Fixed prod bug' });
    assert.equal(v.ok, false);
    assert.equal(v.status, 400);
    assert.equal(v.error, MSG_5H);
  } finally { s.restore(); }
});

test('manual 4h 59m → rejected (test 9)', async () => {
  const s = stub({ attendance: attRec(4.983) });
  try {
    const v = await compOff.validateManualCompOff({ employeeId: EMP, workedDate: '2026-08-16', workReport: 'Work' });
    assert.equal(v.ok, false);
  } finally { s.restore(); }
});

test('manual exactly 5h → allowed, 0.5 day (test 10)', async () => {
  const s = stub({ attendance: attRec(5) });
  try {
    const v = await compOff.validateManualCompOff({ employeeId: EMP, workedDate: '2026-08-16', workReport: 'Work' });
    assert.equal(v.ok, true);
    assert.equal(v.days, 0.5);
  } finally { s.restore(); }
});

test('manual 6h → allowed (test 11)', async () => {
  const s = stub({ attendance: attRec(6) });
  try {
    const v = await compOff.validateManualCompOff({ employeeId: EMP, workedDate: '2026-08-16', workReport: 'Work' });
    assert.equal(v.ok, true);
  } finally { s.restore(); }
});

test('manual missing work report → rejected (test 12)', async () => {
  const s = stub({ attendance: attRec(6) });
  try {
    const v = await compOff.validateManualCompOff({ employeeId: EMP, workedDate: '2026-08-16', workReport: '   ' });
    assert.equal(v.ok, false);
    assert.equal(v.status, 400);
    assert.match(v.error, /work report/i);
  } finally { s.restore(); }
});

test('manual required-evidence gate honoured when the process requires it (test 13)', async () => {
  const s = stub({ attendance: attRec(6) });
  try {
    const no = await compOff.validateManualCompOff({ employeeId: EMP, workedDate: '2026-08-16', workReport: 'Work', requireEvidence: true, hasEvidence: false });
    assert.equal(no.ok, false);
    const yes = await compOff.validateManualCompOff({ employeeId: EMP, workedDate: '2026-08-16', workReport: 'Work', requireEvidence: true, hasEvidence: true });
    assert.equal(yes.ok, true);
  } finally { s.restore(); }
});

test('manual no attendance → rejected (test 6/16 direct-API bypass)', async () => {
  const s = stub({ attendance: null });
  try {
    const v = await compOff.validateManualCompOff({ employeeId: EMP, workedDate: '2026-08-16', workReport: 'Work' });
    assert.equal(v.ok, false);
    assert.match(v.error, /no valid attendance/i);
  } finally { s.restore(); }
});

test('manual duplicate → rejected 409 (test 7)', async () => {
  const s = stub({ attendance: attRec(6), comp: [{ hr_compoffid: 'c1', hr_status: 'pending' }] });
  try {
    const v = await compOff.validateManualCompOff({ employeeId: EMP, workedDate: '2026-08-16', workReport: 'Work' });
    assert.equal(v.ok, false);
    assert.equal(v.status, 409);
    assert.match(v.error, /already exists/i);
  } finally { s.restore(); }
});

test('valid manual request is eligible but NOT auto-approved — returns days for a PENDING create (tests 14, 15)', async () => {
  const s = stub({ attendance: attRec(6), comp: [] });
  try {
    const v = await compOff.validateManualCompOff({ employeeId: EMP, workedDate: '2026-08-16', workReport: 'Deployed release' });
    assert.equal(v.ok, true);
    assert.equal(v.days, 0.5);
    assert.ok(!('status' in v && v.status >= 400));   // eligibility only; HR review still decides approval
  } finally { s.restore(); }
});
