/**
 * Approved-leave cancellation eligibility.
 *
 * Business rule (per leave DATE, evaluated against the company/IST civil date):
 *   • Future date (> today)      → always cancellable.
 *   • Today or past date (<= today) → only if the employee has a PRESENT
 *     attendance record for that exact date.
 *   • Multi-day leave → EVERY leave date that is <= today must be Present
 *     (a day where the leave was actually used — i.e. NOT present — blocks
 *     cancellation of the whole record; the existing engine cancels the whole
 *     leave, never a partial range).
 *
 * "Present" reuses the EXISTING attendance status (attendance.util.computeSession,
 * stored on the record as hr_status). It is NOT "a record exists": Half Day /
 * Incomplete / Absent / Leave / no-record are all NOT Present. Web Check-In and
 * eTime/device punches share the same unified hr_status, so this is source-agnostic.
 * No second attendance calculation is introduced.
 */
const d365 = require('./d365.service');
const time = require('./time.util');
const { toLabel } = require('./picklist');

const ATT = d365.constructor.entities.attendance;
const isYmd = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
const ymd = (s) => String(s || '').slice(0, 10);
const esc = (v) => String(v ?? '').replace(/'/g, "''");

// Add n days to a YYYY-MM-DD purely as a DATE (UTC math on the civil date — no
// timezone conversion, so a leave date never drifts to the previous/next day).
function addDaysYmd(ds, n) {
  const [y, m, d] = String(ds).split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + n);
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
}
const toDDMMYYYY = (ds) => { const [y, m, d] = String(ds).split('-'); return `${d}-${m}-${y}`; };

/**
 * PURE eligibility — deterministic, no I/O. `presentDates` is the set of
 * 'YYYY-MM-DD' the employee's attendance status is 'present'. `today` is the
 * company/IST civil date (YYYY-MM-DD).
 * @returns { ok:boolean, reason?:string }
 */
function computeEligibility({ fromDate, toDate, today, presentDates }) {
  const from = ymd(fromDate);
  const to = ymd(toDate) || from;
  if (!isYmd(from) || !isYmd(to) || to < from) return { ok: false, reason: 'The leave dates are invalid.' };
  if (!isYmd(today)) return { ok: false, reason: 'Unable to determine the current date.' };
  const present = presentDates instanceof Set ? presentDates : new Set(presentDates || []);
  for (let d = from; d <= to; d = addDaysYmd(d, 1)) {
    if (d <= today && !present.has(d)) {
      return {
        ok: false,
        reason: d === today
          ? "Today's approved leave can only be cancelled if you have a Present attendance record for today."
          : `Past leave can only be cancelled when the employee has a Present attendance record for that date (${toDDMMYYYY(d)}).`,
      };
    }
  }
  return { ok: true };
}

/** Dates in [from, to] where the employee's stored attendance status is 'present'. */
async function presentDatesFor(employeeId, from, to) {
  const set = new Set();
  if (!employeeId || !isYmd(from) || !isYmd(to) || to < from) return set;
  try {
    const { data } = await d365.getList(ATT, {
      select: '_hr_hremployee_value,hr_date,hr_status',
      // hr_date is a Date column → compared WITHOUT quotes (same as dashboard/etime reads).
      filter: `_hr_hremployee_value eq '${esc(employeeId)}' and hr_date ge ${from} and hr_date le ${to}`,
      top: 1000,
    });
    for (const r of data || []) {
      const raw = r.hr_status;
      const label = typeof raw === 'number' ? toLabel('hr_attendance_status', raw) : String(raw || '').toLowerCase();
      if (label === 'present') set.add(ymd(r.hr_date));
    }
  } catch (_) { /* best-effort: unreadable attendance → treated as NOT present (safe/deny) */ }
  return set;
}

/**
 * Resolve cancellation eligibility for an approved leave (I/O wrapper around the
 * pure rule). `today` defaults to the IST civil date. Only past/today dates are
 * looked up (future dates never need an attendance check).
 * @returns { ok:boolean, reason?:string }
 */
async function leaveCancellationStatus({ employeeId, fromDate, toDate, today = time.istDateStr() }) {
  const from = ymd(fromDate);
  const to = ymd(toDate) || from;
  if (!isYmd(from) || !isYmd(to) || to < from) return { ok: false, reason: 'The leave dates are invalid.' };
  const capTo = to < today ? to : today;                 // cap the attendance read at today
  const presentDates = from <= today ? await presentDatesFor(employeeId, from, capTo) : new Set();
  return computeEligibility({ fromDate: from, toDate: to, today, presentDates });
}

module.exports = { computeEligibility, leaveCancellationStatus, presentDatesFor, addDaysYmd };
