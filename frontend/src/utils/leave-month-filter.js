/**
 * Request-list MONTH filter for Leave Management.
 *
 * Filters by the month in which the request was SUBMITTED — the Dataverse `createdon`
 * timestamp — NOT the leave start date (hr_fromdate). The month is evaluated in the
 * company timezone (Asia/Kolkata / IST), so a request created just after midnight IST
 * counts in the IST month the user sees, not the UTC month.
 *
 * Filtering is client-side on the already-loaded rows: the leave list is fetched as a
 * single page and the existing status/employee filters already rely on that page being
 * complete, so the month filter adds no new incompleteness risk. It runs on the final
 * row set (HR all/employee list, or a non-HR user's own + merged reportee-pending),
 * so it applies uniformly without touching backend authorization.
 */

// Company timezone for "month submitted". Matches the backend's IST leave calendar.
const TZ = 'Asia/Kolkata';

// Month dropdown options. value '' = All Months (no filter); otherwise 1..12.
export const MONTH_OPTIONS = [
  { value: '', label: 'All Months' },
  { value: 1, label: 'January' },
  { value: 2, label: 'February' },
  { value: 3, label: 'March' },
  { value: 4, label: 'April' },
  { value: 5, label: 'May' },
  { value: 6, label: 'June' },
  { value: 7, label: 'July' },
  { value: 8, label: 'August' },
  { value: 9, label: 'September' },
  { value: 10, label: 'October' },
  { value: 11, label: 'November' },
  { value: 12, label: 'December' },
];

/**
 * The IST calendar { year, month(1-12) } of a `createdon` timestamp, or null when the
 * value is missing/unparseable.
 */
export function submissionMonthIST(createdon) {
  if (!createdon) return null;
  const d = new Date(createdon);
  if (Number.isNaN(d.getTime())) return null;
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: TZ, year: 'numeric', month: 'numeric' })
    .formatToParts(d);
  const year = Number(parts.find(p => p.type === 'year')?.value);
  const month = Number(parts.find(p => p.type === 'month')?.value);
  return (year && month) ? { year, month } : null;
}

/**
 * True when a leave row's submission month matches the selected (year, month) in IST.
 *  - month falsy/'' → All Months → always true.
 *  - a row with no/invalid createdon never matches a specific month.
 */
export function leaveMatchesMonth(leave, { year, month } = {}) {
  const m = Number(month);
  if (!m) return true;                     // All Months
  const sub = submissionMonthIST(leave?.createdon);
  return !!sub && sub.year === Number(year) && sub.month === m;
}

/** Apply the month filter to a list of leave rows (stable; returns a new array). */
export function filterLeavesByMonth(rows = [], opts = {}) {
  if (!Number(opts?.month)) return (rows || []).slice();   // All Months → unchanged
  return (rows || []).filter(r => leaveMatchesMonth(r, opts));
}
