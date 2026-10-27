/**
 * Daily LATE LOGIN policy scanner (spec §2/§5/§6, effective 2026-11-01).
 *
 * After attendance for a day is finalized, this detects ACTUAL late punch-ins — even when the
 * employee never filed a Late Login permission — using the AUTHORITATIVE attendance engine, and
 * applies the monthly tier (1st/2nd auto · 3rd manager · 4th+ 0.5-day CL or HR review).
 *
 * Safety / correctness:
 *   • Not retroactive: skips dates before the effective date.
 *   • Reconciliation: a date already covered by a (non-cancelled) permission or a prior auto
 *     record is the SAME event → counted once (idempotent; re-runs never duplicate).
 *   • Corrections: if a day that previously had an AUTO late record is now on-time (within
 *     grace) in the authoritative record, the auto record is cancelled AND its CL debit reversed
 *     (no invalid penalty). Employee-submitted records are never auto-reversed.
 *   • Early Logout is NEVER punch-based here — Late Login only.
 *   • No attendance punch is created/modified; CL debit is event-keyed + idempotent + balance-
 *     checked; leave-engine failure/ambiguity routes to HR review (never a faked deduction).
 *   • Concurrency: run by the single scheduler instance (see jobs/index.js). Even so, the CL
 *     debit's event key makes a double-debit impossible.
 */
const d365 = require('./d365.service');
const { toValue } = require('./picklist');
const time = require('./time.util');
const PP = require('./permission-policy.service');
const detect = require('./permission-attendance.util');
const lateLogin = require('./late-login.service');
const shiftHistory = require('./shift-history.service');
const eligibility = require('./late-login-eligibility.service');   // single leave/holiday-aware decision

const EMP = d365.constructor.entities.employee;
const ATT = d365.constructor.entities.attendance;
const ATT_SELECT = 'hr_hrattendanceid,hr_date,hr_allpunches,hr_intime,hr_outtime,hr_punchcount,_hr_hremployee_value';
const esc = (v) => String(v ?? '').replace(/'/g, "''");
const addDays = (dateStr, days) => { const d = new Date(`${dateStr}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + Number(days)); return d.toISOString().slice(0, 10); };

async function activeEmployees() {
  try {
    const { data } = await d365.getListOptional(EMP, {
      select: 'hr_hremployeeid,hr_hremployee1,hr_email',
      optionalSelect: 'hr_shiftname,hr_shiftstarttime,hr_shiftendtime,hr_status',
      top: 5000, orderby: 'hr_hremployee1 asc',
    });
    const rows = data || [];
    // If the status column is present, keep only active; otherwise process all (resilient).
    const activeVal = (() => { try { return toValue('hr_employee_status', 'active'); } catch { return null; } })();
    return rows.filter(e => e.hr_status == null || activeVal == null || e.hr_status === activeVal);
  } catch (e) { global.logger?.error?.(`[late-login-scan] employee fetch failed: ${e.message}`); return []; }
}

async function attendanceRecordFor(employeeId, date) {
  try {
    const { data } = await d365.getList(ATT, { select: ATT_SELECT, filter: `_hr_hremployee_value eq '${esc(employeeId)}' and hr_date eq ${String(date).slice(0, 10)}`, top: 1 });
    return (data && data[0]) || null;
  } catch { return null; }
}

/**
 * Scan ONE finalized date for all active employees and apply the Late Login policy.
 * Returns a monitoring summary. Pure of side effects for pre-effective dates.
 */
async function scanDate(dateStr, { employees } = {}) {
  const ds = String(dateStr || '').slice(0, 10);
  const summary = { date: ds, scanned: 0, detected: 0, created: 0, reconciledExisting: 0, reversedCorrections: 0, excused: 0, review: 0, hrReview: 0, clDeducted: 0, errors: 0 };
  if (!PP.effectiveFor(ds)) { summary.skipped = 'pre_effective'; return summary; }

  const cfg = eligibility.nonWorkingConfig();   // holidays + weekly-offs (env + HR calendar)
  const emps = employees || await activeEmployees();
  for (const emp of emps) {
    const employeeId = emp.hr_hremployeeid;
    summary.scanned++;
    try {
      const shift = await shiftHistory.resolveShiftForDate(employeeId, ds, emp).catch(() => null);
      const record = await attendanceRecordFor(employeeId, ds);
      // STRICT: a FAILED permission lookup must not lead to recording an event on incomplete
      // info (§2); the throw is caught below (errors++) and retried on the next idempotent scan.
      const existing = await lateLogin.existingLateFor(employeeId, ds, 'late_login', { strict: true });
      // SINGLE eligibility decision (punch + shift + grace layered with leave/holiday/week-off).
      const leaves = await eligibility.leavesFor(employeeId);
      const v = eligibility.classify({ record, shift, date: ds, leaves, holidays: cfg.holidays, weekOffDays: cfg.weekOffDays, effectiveFrom: PP.POLICY.effectiveFrom });

      if (v.verdict === 'eligible') {
        summary.detected++;
        if (existing) { summary.reconciledExisting++; continue; }   // same real-world event → counted once
        const first = (detect.punchTimes(record)[0]) || '';
        const r = await lateLogin.recordPunchLateEvent({ employeeId, employeeName: emp.hr_hremployee1, date: ds, firstPunch: first, shiftStart: shift?.start || '' });
        summary.created++;
        if (r.status === PP.STATUS.CL_DEDUCTED) summary.clDeducted++;
        if (r.status === PP.STATUS.HR_REVIEW) summary.hrReview++;
      } else if (existing && existing.hr_createdby === lateLogin.AUTO_CREATED_BY) {
        // Previously auto-counted, but now NOT eligible (corrected to on-time, or now covered by
        // leave/holiday/week-off, or held for review) → cancel the auto event (keeps audit).
        if (v.verdict === 'not_late') { await lateLogin.reversePunchAutoRecord(existing); summary.reversedCorrections++; }
        else { await lateLogin.markAutoRecordIneligible(existing, v.reason || v.verdict); if (v.verdict === 'excused') summary.excused++; else summary.review++; }
      } else if (v.verdict === 'review') {
        summary.review++;   // held (half-day/pending leave over a late punch) — not counted, no new event
      }
      // (not eligible + an employee-submitted record) → leave it; the employee owns that request.
    } catch (e) {
      summary.errors++;
      global.logger?.warn?.(`[late-login-scan] ${ds} ${employeeId}: ${e.message}`);
    }
  }
  return summary;
}

/**
 * Daily entry point (scheduler). Scans a short WINDOW of recently-finalized days (default the
 * last 3, so a correction made a day or two later still reconciles), each idempotently. Only
 * dates on/after the effective date are processed. `endDate` defaults to today (company TZ).
 */
const MAX_SCAN_WINDOW = 31;   // a daily job never needs to re-scan more than ~a month back
function resolveWindow(days) {
  const raw = Number(days != null ? days : process.env.LATE_LOGIN_POLICY_SCAN_DAYS);
  if (!Number.isFinite(raw)) return 3;                      // unset / invalid → safe default
  return Math.min(MAX_SCAN_WINDOW, Math.max(1, Math.trunc(raw)));   // clamp to [1, 31]
}

async function runDaily({ endDate, days } = {}) {
  const end = String(endDate || time.istDateStr()).slice(0, 10);
  const window = resolveWindow(days);
  const emps = await activeEmployees();           // fetch once for the whole window
  const results = [];
  for (let i = window - 1; i >= 0; i--) {
    const ds = addDays(end, -i);
    if (!PP.effectiveFor(ds)) continue;
    results.push(await scanDate(ds, { employees: emps }));
  }
  return { window, endDate: end, results };
}

module.exports = { scanDate, runDaily, activeEmployees, resolveWindow, MAX_SCAN_WINDOW };
