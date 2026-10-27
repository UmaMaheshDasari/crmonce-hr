/**
 * Late Login ELIGIBILITY + reconciliation (leave / holiday / week-off aware).
 * classify() is pure (no network). reconcileDate() is exercised with stubbed d365 + late-login.
 * Half-day leave stores only a boolean `hr_halfday` (no AM/PM portion) → classify returns a
 * conservative 'review' verdict (never guesses the half). No real emails. Effective 2026-11-01.
 */
process.env.NODE_ENV = 'test';
process.env.EMAIL_DRY_RUN = 'true';
process.env.WEEK_OFF_DAYS = process.env.WEEK_OFF_DAYS || '0,6';
process.env.AZURE_CLIENT_ID = process.env.AZURE_CLIENT_ID || 'x';
process.env.AZURE_CLIENT_SECRET = process.env.AZURE_CLIENT_SECRET || 'x';
process.env.AZURE_TENANT_ID = process.env.AZURE_TENANT_ID || 'x';

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const d365 = require('../src/services/d365.service');
const shiftHistory = require('../src/services/shift-history.service');
const lateLogin = require('../src/services/late-login.service');
const PP = require('../src/services/permission-policy.service');
const elig = require('../src/services/late-login-eligibility.service');

const SHIFT = { start: '09:00', end: '18:00', grace: 5 };
const NOV = '2026-11-10';   // a Tuesday, post-effective
const rec = (punches, date = NOV) => (punches ? { hr_hrattendanceid: 'att', hr_date: date, hr_allpunches: JSON.stringify(punches) } : null);
const C = (over = {}) => elig.classify({ shift: SHIFT, date: NOV, holidays: [], weekOffDays: [0, 6], effectiveFrom: '2026-11-01', leaves: [], ...over });

// ── classify() — pure eligibility (scenarios 1–13, 18, 20) ────────────────────
test('1 valid late punch, no leave → eligible', () => {
  assert.strictEqual(C({ record: rec(['09:30', '18:00']) }).verdict, 'eligible');
});
test('2 on-time punch → not_late', () => {
  assert.strictEqual(C({ record: rec(['09:00', '18:00']) }).verdict, 'not_late');
});
test('3 within grace (09:05 on a 5-min grace) → not_late', () => {
  assert.strictEqual(C({ record: rec(['09:05', '18:00']) }).verdict, 'not_late');
});
test('4 approved full-day leave, NO punch → no_punch (never a Late Login)', () => {
  const v = C({ record: null, leaves: [{ status: 'approved', halfday: false, from: NOV, to: NOV }] });
  assert.strictEqual(v.verdict, 'no_punch');
});
test('5 approved full-day leave + late punch → excused (approved_full_day_leave)', () => {
  const v = C({ record: rec(['09:30', '18:00']), leaves: [{ status: 'approved', halfday: false, from: NOV, to: NOV }] });
  assert.strictEqual(v.verdict, 'excused'); assert.strictEqual(v.reason, 'approved_full_day_leave');
});
test('6 morning half-day leave + late punch → review (portion unknown)', () => {
  const v = C({ record: rec(['09:30', '18:00']), leaves: [{ status: 'approved', halfday: true, from: NOV, to: NOV }] });
  assert.strictEqual(v.verdict, 'review'); assert.strictEqual(v.reason, 'approved_half_day_leave_portion_unknown');
});
test('7 afternoon half-day leave + late punch → review (same — schema has no portion)', () => {
  const v = C({ record: rec(['09:30', '18:00']), leaves: [{ status: 'approved', halfday: true, from: NOV, to: NOV }] });
  assert.strictEqual(v.verdict, 'review');
});
test('8 half-day portion ambiguous → review (never guessed)', () => {
  assert.strictEqual(C({ record: rec(['09:30', '18:00']), leaves: [{ status: 'approved', halfday: true, from: NOV, to: NOV }] }).verdict, 'review');
});
test('9 no punch by EOD, no leave → no_punch (missing-punch policy owns it)', () => {
  assert.strictEqual(C({ record: null }).verdict, 'no_punch');
});
test('10 pending leave, no punch → no_punch', () => {
  assert.strictEqual(C({ record: null, leaves: [{ status: 'pending', halfday: false, from: NOV, to: NOV }] }).verdict, 'no_punch');
});
test('11 pending leave + late punch → review (pending_leave, not finalised)', () => {
  const v = C({ record: rec(['09:30', '18:00']), leaves: [{ status: 'pending', halfday: false, from: NOV, to: NOV }] });
  assert.strictEqual(v.verdict, 'review'); assert.strictEqual(v.reason, 'pending_leave');
});
test('12 rejected leave + late punch → eligible (rejection never excuses; not in the leaves list)', () => {
  // leavesFor only returns approved+pending, so a rejected leave simply is not present.
  assert.strictEqual(C({ record: rec(['09:30', '18:00']), leaves: [] }).verdict, 'eligible');
});
test('13 rejected leave, no punch → no_punch', () => {
  assert.strictEqual(C({ record: null, leaves: [] }).verdict, 'no_punch');
});
test('18 holiday → excused; weekly-off (Sunday 2026-11-08) → excused', () => {
  assert.strictEqual(C({ record: rec(['09:30', '18:00']), holidays: [NOV] }).reason, 'holiday');
  const sun = elig.classify({ record: rec(['09:30', '18:00'], '2026-11-08'), shift: SHIFT, date: '2026-11-08', holidays: [], weekOffDays: [0, 6], effectiveFrom: '2026-11-01', leaves: [] });
  assert.strictEqual(sun.verdict, 'excused'); assert.strictEqual(sun.reason, 'week_off');
});
test('20 pre-effective date (2026-10-31) → pre_effective (notifications not active early)', () => {
  const v = elig.classify({ record: rec(['09:30', '18:00'], '2026-10-31'), shift: SHIFT, date: '2026-10-31', holidays: [], weekOffDays: [0, 6], effectiveFrom: '2026-11-01', leaves: [] });
  assert.strictEqual(v.verdict, 'pre_effective');
});

// ── reconcileDate() — retrospective reconciliation (scenarios 14–17, 21) ──────
let orig;
beforeEach(() => {
  orig = { gio: d365.getByIdOptional, gl: d365.getList, glr: d365.getListResilient, rs: shiftHistory.resolveShiftForDate, ex: lateLogin.existingLateFor, rec: lateLogin.recordPunchLateEvent, mark: lateLogin.markAutoRecordIneligible };
  d365.getByIdOptional = async () => ({ hr_hremployeeid: 'E1', hr_hremployee1: 'Amy', hr_shiftstarttime: '09:00', hr_shiftendtime: '18:00' });
  shiftHistory.resolveShiftForDate = async () => SHIFT;
  d365.getList = async (entity, opts) => {   // attendance record for the date
    if (String(opts?.filter || '').includes('hr_date eq')) return { data: [rec(['09:30', '18:00'])] };
    return { data: [] };
  };
  d365.getListResilient = async () => ({ data: [] });   // no leaves by default
});
afterEach(() => { Object.assign(d365, { getByIdOptional: orig.gio, getList: orig.gl, getListResilient: orig.glr }); shiftHistory.resolveShiftForDate = orig.rs; Object.assign(lateLogin, { existingLateFor: orig.ex, recordPunchLateEvent: orig.rec, markAutoRecordIneligible: orig.mark }); });

test('14 retrospective full-day leave approval → an existing AUTO late event is marked INELIGIBLE (kept, not counted)', async () => {
  // Approved full-day leave covering the date:
  d365.getListResilient = async () => ({ data: [{ hr_status: require('../src/services/picklist').toValue('hr_leave_status', 'approved'), hr_fromdate: NOV, hr_todate: NOV, hr_halfday: 'false' }] });
  lateLogin.existingLateFor = async () => ({ hr_lateloginid: 'L1', hr_date: NOV, hr_status: 'auto_approved', hr_createdby: lateLogin.AUTO_CREATED_BY });
  let marked;
  lateLogin.markAutoRecordIneligible = async (r, reason) => { marked = { r, reason }; return { cancelled: true, reason }; };
  lateLogin.recordPunchLateEvent = async () => { throw new Error('must not create'); };
  const out = await elig.reconcileDate({ employeeId: 'E1', employeeName: 'Amy', date: NOV });
  assert.strictEqual(out.verdict, 'excused');
  assert.strictEqual(out.cancelled, true);
  assert.strictEqual(marked.reason, 'approved_full_day_leave');
});

test('15 retrospective rejection/cancellation (no leave now) + late punch, no record → creates the eligible event', async () => {
  lateLogin.existingLateFor = async () => null;   // was cancelled earlier → not returned
  let created = false;
  lateLogin.recordPunchLateEvent = async () => { created = true; return { recordId: 'N1', status: 'auto_approved' }; };
  const out = await elig.reconcileDate({ employeeId: 'E1', employeeName: 'Amy', date: NOV });
  assert.strictEqual(out.verdict, 'eligible');
  assert.strictEqual(created, true);
});

test('16 reconcileDate is idempotent: eligible + already-counted record → no-op (no duplicate create)', async () => {
  lateLogin.existingLateFor = async () => ({ hr_lateloginid: 'L1', hr_status: 'auto_approved', hr_createdby: lateLogin.AUTO_CREATED_BY });
  lateLogin.recordPunchLateEvent = async () => { throw new Error('must not create'); };
  const out = await elig.reconcileDate({ employeeId: 'E1', employeeName: 'Amy', date: NOV });
  assert.strictEqual(out.noop, 'already_counted');
});

test('21 monthly count: a cancelled (ineligible) record does NOT qualify (PP.isQualifying excludes cancelled)', () => {
  assert.strictEqual(PP.isQualifying('cancelled'), false);
  assert.strictEqual(PP.isQualifying('auto_approved'), true);
});
