/**
 * Sick-Leave "second application in the same week → supporting document required" rule.
 *
 * WEEK: Monday 00:00 → Sunday 23:59 in the company/IST civil date. Leaves are stored
 * as civil dates (hr_fromdate/hr_todate), so week bounds are computed with pure
 * date-only arithmetic (no wall-clock/UTC conversion that could move a date across a
 * week boundary).
 *
 * WHAT COUNTS as a prior Sick Leave: the SAME set the existing Medical-Certificate
 * rule (sick-run.service) uses — pending OR approved Sick Leave records. Rejected and
 * cancelled are excluded; the record being edited excludes itself. The rule counts
 * APPLICATIONS (leave records), never individual days.
 *
 * MULTI-WEEK leave (e.g. Fri→Mon): the request belongs to EVERY week it spans (the
 * window is Monday-of-fromDate … Sunday-of-toDate). A prior valid Sick Leave in ANY
 * of those weeks triggers the document requirement.
 *
 * The document reuses the EXISTING attachment field (hr_medcertdocid) — no new storage.
 */
const d365 = require('./d365.service');
const { toValue } = require('./picklist');

const LEAVE = d365.constructor.entities.leave;
const isYmd = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
const esc = (v) => String(v ?? '').replace(/'/g, "''");
const ymd = (v) => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v || '').slice(0, 10));

// Monday…Sunday (civil dates) of the week containing `dateStr`. Date-only math on a
// UTC-midnight anchor → getUTCDay gives the civil weekday, no timezone drift.
function weekBounds(dateStr) {
  const d = new Date(`${ymd(dateStr)}T00:00:00Z`);
  const backToMon = (d.getUTCDay() + 6) % 7;          // Mon=0 … Sun=6
  const mon = new Date(d); mon.setUTCDate(d.getUTCDate() - backToMon);
  const sun = new Date(mon); sun.setUTCDate(mon.getUTCDate() + 6);
  return { monday: ymd(mon), sunday: ymd(sun) };
}

// The week window a request [fromDate,toDate] occupies (Mon of the start week → Sun
// of the end week), covering multi-week leaves.
function weekWindow(fromDate, toDate) {
  const from = ymd(fromDate); const to = ymd(toDate) || from;
  return { start: weekBounds(from).monday, end: weekBounds(isYmd(to) && to >= from ? to : from).sunday };
}

/**
 * PURE: does a prior valid Sick Leave share a week with the request?
 * @param existing array of { fromDate, toDate } (already valid: pending/approved, self excluded)
 * @returns boolean
 */
function secondSickLeaveInWeek({ fromDate, toDate, existing = [] }) {
  const from = ymd(fromDate);
  if (!isYmd(from)) return false;
  const win = weekWindow(from, toDate);
  return (existing || []).some((e) => {
    const lf = ymd(e.fromDate ?? e.from);
    const lt = ymd(e.toDate ?? e.to) || lf;
    return isYmd(lf) && lf <= win.end && (lt || lf) >= win.start;   // date-range overlap with the week window
  });
}

const MSG_UI = 'Supporting document is required because you have already applied for Sick Leave this week.';
const MSG_API = 'Sick Leave requires a supporting document when you have already applied for Sick Leave earlier this week.';

/**
 * Async: is a supporting document required for a Sick Leave over [fromDate,toDate]?
 * Queries the employee's pending+approved Sick Leave records (reusing the existing
 * status definition), excludes the record being edited, and applies the pure rule.
 * @returns {{ required:boolean, reason?:string, message?:string, apiError?:string }}
 */
async function validateSickLeaveDocumentRequirement(employeeId, fromDate, toDate, { excludeLeaveId } = {}) {
  const from = ymd(fromDate); const to = ymd(toDate) || from;
  if (!employeeId || !isYmd(from)) return { required: false };
  try {
    const sickCode = toValue('hr_leave_type', 'Sick Leave');
    const approved = toValue('hr_leave_status', 'approved');
    const pending = toValue('hr_leave_status', 'pending');
    const { data } = await d365.getList(LEAVE, {
      select: 'hr_hrleaveid,hr_fromdate,hr_todate,hr_status',
      filter: `_hr_hremployee_value eq '${esc(employeeId)}' and hr_leavetype eq ${sickCode} and (hr_status eq ${approved} or hr_status eq ${pending})`,
      top: 500,
    });
    const existing = (data || [])
      .filter((l) => !(excludeLeaveId && l.hr_hrleaveid === excludeLeaveId))
      .map((l) => ({ fromDate: l.hr_fromdate, toDate: l.hr_todate }));
    if (secondSickLeaveInWeek({ fromDate: from, toDate: to, existing })) {
      return { required: true, reason: 'weekly_repeat', message: MSG_UI, apiError: MSG_API };
    }
  } catch (e) { global.logger?.warn?.(`[sick-leave-week] check skipped: ${e.message}`); }
  return { required: false };
}

module.exports = { weekBounds, weekWindow, secondSickLeaveInWeek, validateSickLeaveDocumentRequirement, MSG_UI, MSG_API };
