const { test } = require('node:test');
const assert = require('node:assert');
const { computeSession, computeFromPunches, punchesFromRecord, normalizePunches, earlyLogoutHours } = require('../src/services/attendance.util');

// Default shift = GENERAL 09:00–18:00 (9h). Daily rule (fixed): >=7h Full Day,
// >0 & <7h Half Day, no punch Absent. No 'incomplete' status.
const S = (start, end, dur, night = false) => ({ code: 'X', name: 'X', start, end, durationHours: dur, isNight: night });

// ── Early Logout hours = shift end − requested logout (§29 TEST 1–4) ───────────
test('§29 Early Logout: shift 09:00-18:00, logout 15:00 → 3h', () => {
  assert.strictEqual(earlyLogoutHours(S('09:00', '18:00', 9), '15:00'), 3);
});
test('§29 Early Logout: logout 16:30 → 1.5h (1h30m)', () => {
  assert.strictEqual(earlyLogoutHours(S('09:00', '18:00', 9), '16:30'), 1.5);
});
test('§29 Early Logout: logout 18:00 (= shift end) → 0 → invalid/reject', () => {
  assert.ok(earlyLogoutHours(S('09:00', '18:00', 9), '18:00') <= 0);
});
test('§29 Early Logout: logout 19:00 (after shift end) → negative → invalid/reject', () => {
  assert.ok(earlyLogoutHours(S('09:00', '18:00', 9), '19:00') <= 0);
});
test('Early Logout respects the employee shift (10:00-19:00, logout 17:30 → 1.5h)', () => {
  assert.strictEqual(earlyLogoutHours(S('10:00', '19:00', 9), '17:30'), 1.5);
});

test('single punch (open session) → IN, in_progress (NOT Half Day, NOT Absent)', () => {
  const c = computeSession(['09:00']);
  assert.strictEqual(c.state, 'in');
  assert.strictEqual(c.status, 'in_progress');    // still working — day not finalized
  assert.notStrictEqual(c.status, 'half_day');    // the reported bug — must NOT be Half Day
  assert.notStrictEqual(c.status, 'absent');
  assert.strictEqual(c.attendanceIssue, 'Missing Check Out');
  assert.strictEqual(c.count, 1);
  assert.deepStrictEqual(c.sessions, []);         // no completed IN→OUT session yet
  assert.deepStrictEqual(c.openSession, { inTime: '09:00' });
  assert.strictEqual(c.totalWorkedMinutes, 0);
});

test('IN / OUT → present, span & effective, no overtime', () => {
  const c = computeSession(['09:00', '18:00']);
  assert.strictEqual(c.totalSpanHours, 9);
  assert.strictEqual(c.effectiveHours, 9);
  assert.strictEqual(c.overtimeHours, 0);      // 9 - 9
  assert.strictEqual(c.status, 'present');
});

// ── Spec §22 test cases — punch pairing, breaks excluded, no premature finalize ──
test('§22 TEST 2: 09:00 IN, 12:00 OUT → one 3h session, out state', () => {
  const c = computeSession(['09:00', '12:00']);
  assert.strictEqual(c.state, 'out');
  assert.deepStrictEqual(c.sessions, [{ inTime: '09:00', outTime: '12:00', minutes: 180 }]);
  assert.strictEqual(c.openSession, null);
  assert.strictEqual(c.totalWorkedMinutes, 180);
});

test('§22 TEST 3: 09:00-12:00, 13:00-18:00 → 8h worked (1h break excluded), Full Day', () => {
  const c = computeSession(['09:00', '12:00', '13:00', '18:00']);
  assert.strictEqual(c.effectiveHours, 8);     // 3h + 5h, the 1h break not counted
  assert.strictEqual(c.totalWorkedMinutes, 480);
  assert.strictEqual(c.status, 'present');
  assert.deepStrictEqual(c.sessions.map(s => s.minutes), [180, 300]);
});

test('§22 TEST 8: 3 sessions with breaks → 7h30m worked, Full Day', () => {
  const c = computeSession(['09:00', '11:00', '11:30', '14:00', '15:00', '18:00']);
  assert.strictEqual(c.totalWorkedMinutes, 450);   // 120 + 150 + 180 = 7h30m
  assert.strictEqual(c.effectiveHours, 7.5);
  assert.strictEqual(c.status, 'present');
  assert.deepStrictEqual(c.sessions.map(s => s.minutes), [120, 150, 180]);
  assert.strictEqual(c.openSession, null);
});

test('§22 TEST 4/5/6: closed sessions classify by actual hours; overtime not added to worked', () => {
  assert.strictEqual(computeSession(['09:00', '14:00']).status, 'half_day');   // 5h → Half Day
  assert.strictEqual(computeSession(['09:00', '16:00']).status, 'present');    // 7h → Full Day
  const ot = computeSession(['09:00', '19:00']);                               // 10h
  assert.strictEqual(ot.effectiveHours, 10);        // monthly worked uses the actual 10h…
  assert.strictEqual(ot.overtimeHours, 1);          // …overtime (1h) is reported separately, never added
  assert.strictEqual(ot.totalWorkedMinutes, 600);
});

test('lunch break → break subtracted from effective', () => {
  const c = computeSession(['09:00', '13:00', '14:00', '18:00']);
  assert.strictEqual(c.totalSpanHours, 9);
  assert.strictEqual(c.breakHours, 1);
  assert.strictEqual(c.effectiveHours, 8);
  assert.strictEqual(c.status, 'present');
});

test('tea break (15 min) counted', () => {
  const c = computeSession(['09:00', '11:00', '11:15', '18:00']);
  assert.strictEqual(c.breakHours, 0.25);
  assert.strictEqual(c.effectiveHours, 8.75);
});

test('multiple breaks summed', () => {
  const c = computeSession(['09:00', '11:00', '11:15', '13:00', '14:00', '18:00']);
  assert.strictEqual(c.breakHours, 1.25);       // 0.25 + 1.00
  assert.strictEqual(c.effectiveHours, 7.75);
});

test('open 3rd session (IN,OUT,IN) → in_progress; session 1 counted, open session not', () => {
  const c = computeSession(['09:00', '13:00', '14:00']);  // session1 = 4h; then re-checked in (open)
  assert.strictEqual(c.state, 'in');
  assert.strictEqual(c.status, 'in_progress');            // still working — NOT finalized
  assert.strictEqual(c.effectiveHours, 4);                // only the completed IN→OUT session
  assert.deepStrictEqual(c.sessions, [{ inTime: '09:00', outTime: '13:00', minutes: 240 }]);
  assert.deepStrictEqual(c.openSession, { inTime: '14:00' });
  assert.strictEqual(c.attendanceIssue, 'Missing Check Out');
});

test('half day: effective < 7h (fixed rule, shift-independent)', () => {
  const c = computeSession(['09:00', '13:00']);          // 4h effective
  assert.strictEqual(c.effectiveHours, 4);
  assert.strictEqual(c.fullDayThreshold, 7);
  assert.strictEqual(c.halfDayThreshold, 5);
  assert.strictEqual(c.status, 'half_day');
});

test('half_day below the shift/2 mark (4.5h is now Half Day, not Full)', () => {
  const c = computeSession(['09:00', '13:30']);          // 4.5h < 7
  assert.strictEqual(c.effectiveHours, 4.5);
  assert.strictEqual(c.status, 'half_day');
});

test('present exactly at the 7h Full-Day boundary', () => {
  const c = computeSession(['09:00', '16:00']);          // 7h effective → Full Day
  assert.strictEqual(c.effectiveHours, 7);
  assert.strictEqual(c.status, 'present');
  assert.strictEqual(c.expectedHours, 9);
  assert.strictEqual(c.dailyBalanceHours, -2);
});

test('absent: no punches', () => {
  const c = computeSession([]);
  assert.strictEqual(c.status, 'absent');
  assert.strictEqual(c.state, 'none');
});

test('overtime = effective - shift duration', () => {
  const c = computeSession(['09:00', '20:00']);          // 11h effective, 9h shift
  assert.strictEqual(c.effectiveHours, 11);
  assert.strictEqual(c.overtimeHours, 2);
});

test('night shift crossing midnight (22:00–06:00, 8h)', () => {
  const c = computeSession(['22:00', '06:00'], S('22:00', '06:00', 8, true));
  assert.strictEqual(c.totalSpanHours, 8);
  assert.strictEqual(c.effectiveHours, 8);
  assert.strictEqual(c.status, 'present');
  assert.strictEqual(c.overtimeHours, 0);
});

test('device direction honored ({t,d} objects)', () => {
  const c = computeSession([{ t: '09:00', d: 'in' }, { t: '12:00', d: 'out' }, { t: '13:00', d: 'in' }, { t: '18:00', d: 'out' }]);
  assert.strictEqual(c.breakHours, 1);
  assert.strictEqual(c.state, 'out');
});

test('late arrival & early departure vs shift', () => {
  const late = computeSession(['09:30', '18:00']);       // shift start 09:00; grace 5 → 30-5
  assert.strictEqual(late.lateArrivalMin, 25);
  const early = computeSession(['09:00', '17:00']);      // shift end 18:00
  assert.strictEqual(early.earlyDepartureMin, 60);
});

test('shift-based half-day threshold differs by shift', () => {
  const c = computeSession(['09:00', '13:00'], S('09:00', '19:00', 10)); // threshold 5h
  assert.strictEqual(c.halfDayThreshold, 5);
  assert.strictEqual(c.effectiveHours, 4);
  assert.strictEqual(c.status, 'half_day');
});

test('backward compat: legacy string array & intime/outtime record', () => {
  const c = computeFromPunches(['09:00', '18:00']);
  assert.strictEqual(c.effectiveHours, 9);
  assert.strictEqual(c.status, 'present');
  assert.deepStrictEqual(punchesFromRecord({ hr_intime: '09:00', hr_outtime: '18:00', hr_allpunches: null }), ['09:00', '18:00']);
});

test('after OUT a new punch re-opens the session', () => {
  let c = computeSession(['09:00', '12:00']);
  assert.strictEqual(c.state, 'out');
  c = computeSession([...c.punches, '13:00']);
  assert.strictEqual(c.state, 'in');
});

test('normalizePunches infers direction by pairing', () => {
  const p = normalizePunches(['09:00', '12:00', '13:00']);
  assert.deepStrictEqual(p.map(x => x.d), ['in', 'out', 'in']);
});

// ── Company policy (attendance emits FACTS only; compensation is Payroll's job) ──
test('policy: late but completes required hours → Present + compensated', () => {
  const c = computeSession(['07:30', '17:30'], S('07:00', '17:00', 10)); // 10h shift
  assert.strictEqual(c.effectiveHours, 10);
  assert.strictEqual(c.lateArrivalMin, 25);              // 30 late - 5 grace
  assert.strictEqual(c.status, 'present');               // status by effective hours only
  assert.strictEqual(c.metRequiredHours, true);
  assert.strictEqual(c.compensationStatus, 'compensated');
});

test('policy: late AND short of required → present-by-hours, shortfall', () => {
  const c = computeSession(['10:00', '17:00']);          // GENERAL 9h; effective 7
  assert.strictEqual(c.lateArrivalMin, 55);              // 60 late - 5 grace
  assert.strictEqual(c.effectiveHours, 7);
  assert.strictEqual(c.status, 'present');               // late does NOT reduce status
  assert.strictEqual(c.metRequiredHours, false);
  assert.strictEqual(c.compensationStatus, 'shortfall');
});

test('policy: on time → compensationStatus on_time', () => {
  assert.strictEqual(computeSession(['09:00', '18:00']).compensationStatus, 'on_time');
});

test('policy: approved leave offsets late calculation', () => {
  const c = computeSession(['11:10', '18:00'], undefined, { leaveUntil: '11:00' });
  assert.strictEqual(c.lateArrivalMin, 5);               // from 11:00 (not 09:00): 10 late - 5 grace
});

// ── Rule: any punch → never Absent; attendance issue ───────────────────────
test('single IN → in_progress, never Absent, Missing Check Out flag preserved', () => {
  const c = computeSession(['09:00']);
  assert.strictEqual(c.status, 'in_progress');
  assert.notStrictEqual(c.status, 'absent');
  assert.notStrictEqual(c.status, 'half_day');
  assert.strictEqual(c.attendanceIssue, 'Missing Check Out');
});

test('IN + OUT → Normal issue, never Absent', () => {
  const c = computeSession(['09:00', '18:00']);
  assert.strictEqual(c.attendanceIssue, 'Normal');
  assert.notStrictEqual(c.status, 'absent');
});

test('device OUT-first single punch → Missing Check In, half_day', () => {
  const c = computeSession([{ t: '18:00', d: 'out' }]);
  assert.strictEqual(c.status, 'half_day');
  assert.notStrictEqual(c.status, 'incomplete');
  assert.strictEqual(c.attendanceIssue, 'Missing Check In');
});

test('punch in+out same minute (0 effective) is NOT Absent', () => {
  const c = computeSession(['09:00', '09:00']);
  assert.notStrictEqual(c.status, 'absent');
  assert.strictEqual(c.attendanceIssue, 'Normal');
});

test('no punches → Absent, empty issue', () => {
  const c = computeSession([]);
  assert.strictEqual(c.status, 'absent');
  assert.strictEqual(c.attendanceIssue, '');
});

// ── Shift grace period (default 5 min) — Late Minutes only, never status ─────
// Verify On Time / grace boundary / first late minute across every shift.
const GRACE_CASES = [
  { shift: S('07:00', '17:00', 10), start: '07:00' },
  { shift: S('08:00', '18:00', 10), start: '08:00' },
  { shift: S('09:00', '18:00', 9),  start: '09:00' },
  { shift: S('11:30', '21:30', 10), start: '11:30' },
  { shift: S('13:30', '23:30', 10), start: '13:30' },
];
const addMin = (hhmm, n) => { const [h, m] = hhmm.split(':').map(Number); const t = h * 60 + m + n; return `${String(Math.floor(t / 60) % 24).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`; };

for (const { shift, start } of GRACE_CASES) {
  test(`grace: ${start} punch exactly on time → 0 late`, () => {
    assert.strictEqual(computeSession([start, addMin(start, 600)], shift).lateArrivalMin, 0);
  });
  test(`grace: ${start} within 5-min grace (+3) → On Time (0 late)`, () => {
    assert.strictEqual(computeSession([addMin(start, 3), addMin(start, 600)], shift).lateArrivalMin, 0);
  });
  test(`grace: ${start} at grace boundary (+5) → On Time (0 late)`, () => {
    assert.strictEqual(computeSession([addMin(start, 5), addMin(start, 600)], shift).lateArrivalMin, 0);
  });
  test(`grace: ${start} first late minute (+6) → Late 1`, () => {
    assert.strictEqual(computeSession([addMin(start, 6), addMin(start, 600)], shift).lateArrivalMin, 1);
  });
}

test('grace: late is counted AFTER grace (09:08 → 3 min, not 8)', () => {
  const c = computeSession(['09:08', '18:00'], S('09:00', '18:00', 9));
  assert.strictEqual(c.lateArrivalMin, 3);
  assert.strictEqual(c.graceMinutes, 5);
});

test('grace does NOT change attendance status (late but full hours = present)', () => {
  const c = computeSession(['09:08', '18:08'], S('09:00', '18:00', 9)); // 9h effective, late 3
  assert.strictEqual(c.status, 'present');
  assert.strictEqual(c.lateArrivalMin, 3);
});

test('grace is configurable per call (graceMinutes=0 → full lateness)', () => {
  const c = computeSession(['09:08', '18:00'], S('09:00', '18:00', 9), { graceMinutes: 0 });
  assert.strictEqual(c.lateArrivalMin, 8);
});

// ── Late Entry (lateEntryMinutes) — the EMAILED "Late By", measured from the ACTUAL
//    shift start, with a FIXED 5-min grace. 09:00 shift: 09:00–09:05 Normal, 09:06+ Late.
//    Distinct from lateArrivalMin (which is measured AFTER the grace window).
const GEN = S('09:00', '18:00', 9);
test('Late Entry: 09:00 exactly on time → 0 (no email)', () => {
  assert.strictEqual(computeSession(['09:00', '18:00'], GEN).lateEntryMinutes, 0);
});
test('Late Entry: 09:05 grace boundary → 0 (still Normal, no email)', () => {
  assert.strictEqual(computeSession(['09:05', '18:00'], GEN).lateEntryMinutes, 0);
});
test('Late Entry: 09:06 first minute past grace → Late By 6 (from shift start, not grace end)', () => {
  assert.strictEqual(computeSession(['09:06', '18:00'], GEN).lateEntryMinutes, 6);
});
test('Late Entry: 09:10 → Late By 10', () => {
  assert.strictEqual(computeSession(['09:10', '18:00'], GEN).lateEntryMinutes, 10);
});
test('Late Entry: 09:30 → Late By 30', () => {
  assert.strictEqual(computeSession(['09:30', '18:00'], GEN).lateEntryMinutes, 30);
});
test('Late Entry never affects status/salary facts (09:30 late but full hours → present)', () => {
  const c = computeSession(['09:30', '18:30'], GEN);     // 9h effective, late 30
  assert.strictEqual(c.lateEntryMinutes, 30);
  assert.strictEqual(c.status, 'present');               // never half/absent/LOP
  assert.strictEqual(c.metRequiredHours, true);
});
test('Late Entry uses a FIXED 5-min grace (opts.graceMinutes does not widen the email trigger for these examples)', () => {
  // The 5-min rule is fixed; lateEntryMinutes keys off the same graceMin used for lateArrival.
  assert.strictEqual(computeSession(['09:06', '18:00'], GEN).lateEntryMinutes, 6);
  assert.strictEqual(computeSession(['09:05', '18:00'], GEN).lateEntryMinutes, 0);
});
