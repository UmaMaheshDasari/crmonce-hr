/**
 * FINAL Attendance / Leave / LOP business rule (mandatory — no on/off setting):
 *
 *   Payable Days = Present + ½·Half-day + Approved Paid Leave (CL/SL within cap, Comp Off,
 *                  Earned/Maternity/Paternity).   [Late Login keeps its punch → Present]
 *   Pending leave = held OUT of both Payable and LOP until decided.
 *   LOP Days     = Working − Payable − Pending.   [absence with no approved/pending leave
 *                  is ALWAYS auto-LOP — no waiting for an HR application]
 *
 * No network: d365.getList (attendance) + leaveEngine (split / pending / balance) stubbed.
 */
process.env.NODE_ENV = 'test';
process.env.AZURE_CLIENT_ID = process.env.AZURE_CLIENT_ID || 'test-client';
process.env.AZURE_CLIENT_SECRET = process.env.AZURE_CLIENT_SECRET || 'test-secret';
process.env.AZURE_TENANT_ID = process.env.AZURE_TENANT_ID || 'test-tenant';

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const d365 = require('../src/services/d365.service');
const leaveEngine = require('../src/services/leave-engine.service');
const payrollSettings = require('../src/services/payroll-settings.service');
const attnCfg = require('../src/services/attendance.config');
const { computeMonthFacts } = require('../src/modules/payroll/payroll.routes');

const EMP = 'emp-guid-1';
const YEAR = 2026, MONTH = 11;
const pad2 = (n) => String(n).padStart(2, '0');
const HALF_DAY = 123140002;                              // hr_attendance_status: half_day
const SETTINGS = payrollSettings.resolve(null);          // plain resolved settings — no LOP toggle any more

function workingDates() {
  const out = [];
  for (let day = 1; day <= 30; day++) {
    const ds = `${YEAR}-11-${pad2(day)}`;
    const dow = new Date(`${ds}T00:00:00Z`).getUTCDay();
    if (!attnCfg.weekOffDays.includes(dow) && !attnCfg.holidays.includes(ds)) out.push(ds);
  }
  return out;
}

let orig, WD;
// present = normal punches; lateLogin = LATE punches (still Present); half = half-day rows;
// paidLeave/lopLeave from splitMonthLeave; pending from pendingMonthDays.
function stub({ present = 0, lateLogin = 0, half = 0, paidLeave = 0, lopLeave = 0, pending = 0 } = {}) {
  const dates = workingDates(); WD = dates.length;
  const rows = [];
  let i = 0;
  for (let k = 0; k < present; k++, i++) rows.push({ hr_date: dates[i], hr_intime: '09:30', _hr_hremployee_value: EMP });
  for (let k = 0; k < lateLogin; k++, i++) rows.push({ hr_date: dates[i], hr_intime: '11:45', _hr_hremployee_value: EMP });   // LATE in-time
  for (let k = 0; k < half; k++, i++) rows.push({ hr_date: dates[i], hr_intime: '09:30', hr_status: HALF_DAY, _hr_hremployee_value: EMP });
  d365.getList = async (entity) => (entity === d365.constructor.entities.attendance ? { data: rows } : { data: [] });
  leaveEngine.splitMonthLeave = async () => ({ paidLeaveDays: paidLeave, lopLeaveDays: lopLeave });
  leaveEngine.pendingMonthDays = async () => pending;
  leaveEngine.getBalance = async () => ({ casual: { remaining: 0 }, sick: { remaining: 0 }, earned: { used: 0 }, compOff: { balance: 0 } });
}

beforeEach(() => {
  orig = { gl: d365.getList, split: leaveEngine.splitMonthLeave, pend: leaveEngine.pendingMonthDays, bal: leaveEngine.getBalance };
  attnCfg.weekOffDays = [0, 6]; attnCfg.setDynamicHolidays([]);
});
afterEach(() => { d365.getList = orig.gl; leaveEngine.splitMonthLeave = orig.split; leaveEngine.pendingMonthDays = orig.pend; leaveEngine.getBalance = orig.bal; });

const facts = () => computeMonthFacts(EMP, MONTH, YEAR, SETTINGS);

// ── 1. Present every working day → payable = Working, LOP 0 ──
test('1. Present every working day → Payable = Working, LOP 0', async () => {
  stub({ present: 999 });
  const a = await facts();
  assert.strictEqual(a.presentDays, WD);
  assert.strictEqual(a.payDays, WD);
  assert.strictEqual(a.lopDays, 0);
});

// ── 2. Late Login is FULL Present (no half-day, no LOP, no deduction) ──
test('2. Late Login counts as full Present — never half-day, never LOP', async () => {
  stub({ present: 5, lateLogin: 3 });
  const a = await facts();
  assert.strictEqual(a.presentDays, 8, '5 normal + 3 late = 8 present');
  assert.strictEqual(a.halfDays, 0, 'a late login is NOT a half day');
  assert.strictEqual(a.payDays, 8, 'all 8 payable');
  assert.strictEqual(a.lopDays, WD - 8);
});

// ── 3. No leave + absent → auto-LOP (the old 23/19/4→23 bug must NOT happen) ──
test('3. Absent with no leave → automatically LOP (Present 19-style → Payable 19)', async () => {
  stub({ present: WDminus(4) });                          // 4 uncovered absents
  const a = await facts();
  assert.strictEqual(a.payDays, a.presentDays, 'Payable = Present (no leave)');
  assert.strictEqual(a.lopDays, 4, 'the 4 unapplied absents are LOP');
  assert.strictEqual(a.payDays + a.lopDays, WD);
});

// ── 4. Approved CL / SL → paid, payable, no LOP ──
test('4. Approved CL + SL → Payable = Present + Paid Leave', async () => {
  stub({ present: 5, paidLeave: 3 });                     // present 5 + 3 paid leave
  const a = await facts();
  assert.strictEqual(a.approvedLeaveDays, 3);
  assert.strictEqual(a.payDays, 8, 'Present 5 + Paid 3');
  assert.strictEqual(a.lopDays, WD - 8);
});

// ── 5. Approved Comp Off → paid (stored as Earned Leave → category 'other' → paid) ──
test('5. Comp Off is classified as PAID leave (Earned Leave → other)', () => {
  assert.strictEqual(leaveEngine.categoryOfType('Earned Leave'), 'other');
  const split = leaveEngine.computeMonthSplit({ leaves: [{ category: 'other', days: 2, month: MONTH }], policy: { casual: 12, sick: 6 }, month: MONTH });
  assert.strictEqual(split.paidLeaveDays, 2, 'Comp Off / Earned = fully paid, never LOP');
  assert.strictEqual(split.lopLeaveDays, 0);
});

// ── 6. Pending CL — held from LOP until decided (present 20 / pending 1 / absent 2) ──
test('6. Pending leave is held from LOP (not paid yet, not LOP yet)', async () => {
  stub({ present: WDminus(3), pending: 1 });              // 3 uncovered: 1 pending + 2 absent
  const a = await facts();
  assert.strictEqual(a.payDays, a.presentDays, 'pending is NOT payable yet');
  assert.strictEqual(a.pendingLeaveDays, 1);
  assert.strictEqual(a.lopDays, 2, 'only the 2 truly-unapplied absents are LOP');
  assert.strictEqual(a.payDays + a.pendingLeaveDays + a.lopDays, WD, 'reconciles');
});

// ── 7. Pending → Approved: the day becomes PAID, LOP unchanged ──
test('7. Pending CL approved → Payable +1, LOP unchanged', async () => {
  stub({ present: WDminus(3), paidLeave: 1, pending: 0 });   // the pending CL is now approved (paid)
  const a = await facts();
  assert.strictEqual(a.payDays, a.presentDays + 1);
  assert.strictEqual(a.pendingLeaveDays, 0);
  assert.strictEqual(a.lopDays, 2, 'the other 2 absents stay LOP');
});

// ── 8. Pending → Rejected: the day becomes LOP ──
test('8. Pending CL rejected → the day becomes LOP', async () => {
  stub({ present: WDminus(3), paidLeave: 0, pending: 0 });   // rejected → no paid, no pending
  const a = await facts();
  assert.strictEqual(a.payDays, a.presentDays);
  assert.strictEqual(a.pendingLeaveDays, 0);
  assert.strictEqual(a.lopDays, 3, 'all 3 uncovered days are now LOP');
});

// ── 9. Insufficient balance: the excess (beyond cap) is NOT paid → becomes LOP ──
test('9. Insufficient leave balance → the excess leave day is LOP, not paid', async () => {
  stub({ present: 5, paidLeave: 2, lopLeave: 1 });        // applied 3 leave, only 2 within cap
  const a = await facts();
  assert.strictEqual(a.payDays, 7, 'only Present 5 + Paid 2 are payable');
  assert.strictEqual(a.lopDays, WD - 7, 'the excess leave day is among the LOP days');
});

// ── 10. Mixed Present + CL + SL + LOP ──
test('10. Mixed Present + CL + SL + LOP reconciles', async () => {
  stub({ present: 10, paidLeave: 4 });                    // 2 CL + 2 SL
  const a = await facts();
  assert.strictEqual(a.payDays, 14);
  assert.strictEqual(a.lopDays, WD - 14);
  assert.strictEqual(a.payDays + a.lopDays + a.pendingLeaveDays, WD);
});

// ── 11. Late Login + LOP (the spec example, scaled to the real WD) ──
test('11. Late Login stays payable while a genuine absence is LOP', async () => {
  stub({ present: WDminus(4), lateLogin: 2, paidLeave: 1 });   // present, 2 late, 1 paid, remainder absent
  const a = await facts();
  // presentDays = (WD-4-2... ) let the numbers reconcile: payable = present + paid, lop = WD - payable - pending
  assert.strictEqual(a.payDays, a.presentDays + 1, 'late logins are inside Present; +1 paid leave');
  assert.strictEqual(a.pendingLeaveDays, 0);
  assert.strictEqual(a.payDays + a.lopDays, WD);
  assert.ok(a.lopDays >= 1, 'the genuine absence is LOP; the 2 late days are NOT');
});

// ── 12. Half-day = 0.5 payable ──
test('12. Half-day counts as 0.5 payable', async () => {
  stub({ present: 5, half: 2 });
  const a = await facts();
  assert.strictEqual(a.halfDays, 2);
  assert.strictEqual(a.payDays, 6, 'Present 5 + 2×0.5');
});

// ── 13. No attendance at all → Payable 0, LOP = Working ──
test('13. No attendance → Payable 0, LOP = Working, flagged', async () => {
  stub({ present: 0 });
  const a = await facts();
  assert.strictEqual(a.payDays, 0);
  assert.strictEqual(a.lopDays, WD);
  assert.ok(a.warnings.some((w) => w.code === 'attendance_missing'));
});

// ── 14. Reconciliation always holds: Payable + Pending + LOP = Working ──
test('14. Payable + Pending + LOP always reconcile to Working Days', async () => {
  stub({ present: 8, lateLogin: 1, half: 2, paidLeave: 2, pending: 1 });
  const a = await facts();
  assert.strictEqual(a.payDays + a.pendingLeaveDays + a.lopDays, a.workingDays);
  assert.strictEqual(a.payDays, a.presentDays + a.halfDays * 0.5 + a.approvedLeaveDays);
});

// helper: present count that leaves exactly `absent` uncovered working days
function WDminus(absent) { const dates = workingDates(); WD = dates.length; return WD - absent; }
