/**
 * Late Login ELIGIBILITY — the SINGLE deterministic decision used by the scanner, the leave/
 * correction reconciliation hooks, and tests. It layers leave / holiday / week-off facts on top
 * of the existing punch-based detection (permission-attendance.util.lateEventForDate →
 * computeSession), without duplicating the punch/shift/grace math or inventing new thresholds.
 *
 * A date is an ELIGIBLE Late Login only when a real punch is genuinely late AND the late interval
 * is not excused by the working-day / leave rules:
 *   pre_effective → before 2026-11-01 (policy not active)
 *   holiday / week_off → non-working day (never a Late Login)
 *   no_punch → no check-in (missing-punch/absence policy owns it — NOT a Late Login)
 *   not_late → punch is on time / within grace (or an un-finalised/absent status)
 *   excused (approved_full_day_leave) → approved full-day leave covers the date
 *   review (approved_half_day_leave_portion_unknown) → approved HALF-day leave covers the date but
 *          the schema stores only a boolean `hr_halfday` (no AM/PM portion), so we cannot prove the
 *          late interval is covered — do NOT auto-count and do NOT silently excuse; hold for review.
 *   review (pending_leave) → a relevant leave request is still awaiting a decision — don't finalise.
 *   eligible → genuine, countable Late Login.
 *
 * Rejected / cancelled leave is ignored here (it never proves lateness) — such a date falls through
 * to the punch facts. This module is PURE for classify(); the network lookups are separate.
 */
const d365 = require('./d365.service');
const { toValue } = require('./picklist');
const detect = require('./permission-attendance.util');
const { isHalfDayLeave } = require('./leave-summary.util');
let attnCfg; try { attnCfg = require('./attendance.config'); } catch (_) { attnCfg = null; }
const PP = require('./permission-policy.service');

const LEAVE = d365.constructor.entities.leave;
const ATT = d365.constructor.entities.attendance;
const EMP = d365.constructor.entities.employee;
let shiftHistory; try { shiftHistory = require('./shift-history.service'); } catch (_) { shiftHistory = null; }
const ATT_SELECT = 'hr_hrattendanceid,hr_date,hr_allpunches,hr_intime,hr_outtime,hr_punchcount,_hr_hremployee_value';
const esc = (v) => String(v ?? '').replace(/'/g, "''");
const FINALISED_WORKED = new Set(['present', 'half_day']);
const ds10 = (d) => String(d || '').slice(0, 10);
const covers = (lv, ds) => lv.from && lv.to && ds10(lv.from) <= ds && ds <= ds10(lv.to);
// Day-of-week (0=Sun..6=Sat) of an IST calendar date string — stable (midnight UTC of that date).
const dow = (ds) => { const d = new Date(`${ds}T00:00:00Z`); return Number.isNaN(d.getTime()) ? -1 : d.getUTCDay(); };

/**
 * PURE eligibility verdict. `leaves` is a pre-fetched list of this employee's APPROVED + PENDING
 * leaves, each { status:'approved'|'pending', halfday:boolean, from, to }. `holidays` is an array
 * of 'YYYY-MM-DD'; `weekOffDays` an array of 0..6. `effectiveFrom` defaults to the policy date.
 * Returns { verdict, reason?, status?, lateMinutes? }.
 */
function classify({ record, shift, date, leaves = [], holidays = [], weekOffDays = [], effectiveFrom = PP.POLICY.effectiveFrom } = {}) {
  const ds = ds10(date || record?.hr_date);
  if (!ds) return { verdict: 'not_late', reason: 'no_date' };
  if (ds < String(effectiveFrom)) return { verdict: 'pre_effective' };
  if ((holidays || []).map(ds10).includes(ds)) return { verdict: 'excused', reason: 'holiday' };
  if ((weekOffDays || []).includes(dow(ds))) return { verdict: 'excused', reason: 'week_off' };

  const ev = record ? detect.lateEventForDate(record, shift, ds, { effectiveFrom }) : { hasCheckIn: false, status: 'absent', lateEntryMinutes: 0 };
  if (!ev.hasCheckIn) return { verdict: 'no_punch', status: ev.status };
  if (!FINALISED_WORKED.has(ev.status) || !(Number(ev.lateEntryMinutes) > 0)) {
    return { verdict: 'not_late', status: ev.status, lateMinutes: Number(ev.lateEntryMinutes) || 0 };
  }

  // A real, late punch exists. Only leave that COVERS this date matters; rejected/cancelled ignored.
  const here = (leaves || []).filter(l => covers(l, ds));
  if (here.some(l => l.status === 'approved' && !l.halfday)) return { verdict: 'excused', reason: 'approved_full_day_leave', status: ev.status, lateMinutes: ev.lateEntryMinutes };
  if (here.some(l => l.status === 'approved' && l.halfday)) return { verdict: 'review', reason: 'approved_half_day_leave_portion_unknown', status: ev.status, lateMinutes: ev.lateEntryMinutes };
  if (here.some(l => l.status === 'pending')) return { verdict: 'review', reason: 'pending_leave', status: ev.status, lateMinutes: ev.lateEntryMinutes };
  return { verdict: 'eligible', status: ev.status, lateMinutes: ev.lateEntryMinutes };
}

const isExcusedOrReview = (v) => v === 'excused' || v === 'review';
const nonWorkingConfig = () => ({ holidays: (attnCfg?.holidays) || [], weekOffDays: (attnCfg?.weekOffDays) || [] });

/** This employee's APPROVED + PENDING leaves (best-effort; [] on any failure). Rejected/cancelled
 *  are intentionally omitted — they never excuse a late arrival. */
async function leavesFor(employeeId) {
  try {
    const approved = toValue('hr_leave_status', 'approved');
    const pending = toValue('hr_leave_status', 'pending');
    const { data } = await d365.getListResilient(LEAVE, {
      select: '_hr_hremployee_value,hr_fromdate,hr_todate,hr_status',
      optionalSelect: 'hr_halfday',
      filter: `_hr_hremployee_value eq '${String(employeeId).replace(/'/g, "''")}' and (hr_status eq ${approved} or hr_status eq ${pending})`,
      top: 500,
    });
    return (data || []).map(l => ({
      status: l.hr_status === approved ? 'approved' : (l.hr_status === pending ? 'pending' : String(l.hr_status)),
      halfday: isHalfDayLeave(l.hr_halfday),
      from: l.hr_fromdate, to: l.hr_todate,
    }));
  } catch (e) { global.logger?.warn?.(`[late-login-eligibility] leave lookup failed for ${employeeId}: ${e.message}`); return []; }
}

async function attendanceRecordFor(employeeId, ds) {
  try {
    const { data } = await d365.getList(ATT, { select: ATT_SELECT, filter: `_hr_hremployee_value eq '${esc(employeeId)}' and hr_date eq ${ds}`, top: 1 });
    return (data && data[0]) || null;
  } catch { return null; }
}

/**
 * Re-evaluate ONE (employee, date) from the underlying attendance + leave facts and bring the
 * stored Late Login state into line — the single idempotent reconciliation used by the leave
 * approve/reject/cancel and attendance-correction hooks (any historical date, no fixed lookback):
 *   • eligible + no active record → create the auto event (notifications handled idempotently).
 *   • not eligible + an active AUTO record → mark it ineligible (cancel; event + email audit kept).
 *   • otherwise → no-op. Safe to rerun. Best-effort; never throws into the caller.
 * Creation/cancellation go through late-login.service; classify() is the shared decision.
 */
async function reconcileDate({ employeeId, employeeName, date } = {}) {
  const ds = ds10(date);
  try {
    if (!employeeId || !ds) return { skipped: 'bad_args' };
    const lateLogin = require('./late-login.service');   // lazy require avoids any load-order cycle
    if (!PP.effectiveFor(ds)) return { skipped: 'pre_effective' };

    const emp = await d365.getByIdOptional(EMP, employeeId, { select: 'hr_hremployeeid,hr_hremployee1', optionalSelect: 'hr_shiftname,hr_shiftstarttime,hr_shiftendtime' }).catch(() => null);
    const shift = shiftHistory ? await shiftHistory.resolveShiftForDate(employeeId, ds, emp).catch(() => null) : null;
    const [record, leaves] = await Promise.all([attendanceRecordFor(employeeId, ds), leavesFor(employeeId)]);
    const cfg = nonWorkingConfig();
    const v = classify({ record, shift, date: ds, leaves, holidays: cfg.holidays, weekOffDays: cfg.weekOffDays });

    const existing = await lateLogin.existingLateFor(employeeId, ds, 'late_login', { strict: false });
    if (v.verdict === 'eligible') {
      if (existing) return { verdict: v.verdict, noop: 'already_counted' };
      const first = (detect.punchTimes(record)[0]) || '';
      const r = await lateLogin.recordPunchLateEvent({ employeeId, employeeName: employeeName || emp?.hr_hremployee1 || '', date: ds, firstPunch: first, shiftStart: shift?.start || '' });
      return { verdict: v.verdict, created: !r?.skipped, result: r };
    }
    // not eligible (excused / review / not_late / no_punch): cancel an active AUTO record if present.
    if (existing && existing.hr_createdby === lateLogin.AUTO_CREATED_BY) {
      const r = await lateLogin.markAutoRecordIneligible(existing, v.reason || v.verdict);
      return { verdict: v.verdict, reason: v.reason, cancelled: !!r.cancelled };
    }
    return { verdict: v.verdict, reason: v.reason, noop: true };
  } catch (e) { global.logger?.warn?.(`[late-login-eligibility] reconcileDate ${employeeId}/${ds} failed: ${e.message}`); return { error: e.message }; }
}

/** Reconcile every working date spanned by a leave row (inclusive) — used by leave hooks. */
async function reconcileLeaveRange({ employeeId, employeeName, from, to } = {}) {
  const out = [];
  let d = ds10(from); const end = ds10(to || from);
  if (!employeeId || !d || !end) return out;
  for (let i = 0; i < 95 && d <= end; i++) {   // bounded span guard
    out.push({ date: d, ...(await reconcileDate({ employeeId, employeeName, date: d })) });
    const nx = new Date(`${d}T00:00:00Z`); nx.setUTCDate(nx.getUTCDate() + 1); d = nx.toISOString().slice(0, 10);
  }
  return out;
}

module.exports = { classify, leavesFor, isExcusedOrReview, nonWorkingConfig, FINALISED_WORKED, reconcileDate, reconcileLeaveRange };
