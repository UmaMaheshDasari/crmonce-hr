/**
 * Pure leave-summary math (unit-testable, no I/O). Filters by a [from, to] period
 * (inclusive, on the leave's fromDate) — drives the dashboard Leave Summary.
 * rows: [{ days:Number, fromDate:'YYYY-MM-DD', status:'approved|pending|rejected|cancelled' }]
 */

/** Inclusive day span between two 'YYYY-MM-DD' dates (from & to both count). 0 if invalid. */
function daysInclusive(fromDate, toDate) {
  const f = String(fromDate || '').slice(0, 10);
  const t = String(toDate || '').slice(0, 10);
  if (!f || !t) return 0;
  const a = new Date(`${f}T00:00:00Z`);
  const b = new Date(`${t}T00:00:00Z`);
  if (isNaN(a.getTime()) || isNaN(b.getTime()) || b < a) return 0;
  return Math.round((b - a) / 86400000) + 1;
}

/**
 * The number of leave days for a record. Prefer the stored hr_days; when it is
 * blank/zero/non-numeric (legacy or imported leaves often have no hr_days), fall
 * back to the inclusive from→to span so an approved leave is never worth 0 days.
 */
function resolveDays(rawDays, fromDate, toDate) {
  const n = Number(rawDays);
  if (Number.isFinite(n) && n > 0) return n;
  return daysInclusive(fromDate, toDate);
}

function leaveSummary(rows = [], { from, to } = {}) {
  const inPeriod = rows.filter(r => {
    const d = String(r.fromDate || '').slice(0, 10);
    if (!d) return false;
    if (from && d < from) return false;
    if (to && d > to) return false;
    return true;
  });
  const days = (arr) => arr.reduce((s, r) => s + (Number(r.days) || 0), 0);
  const byStatus = (s) => inPeriod.filter(r => r.status === s);

  const approved = byStatus('approved');
  const pending = byStatus('pending');
  const rejected = byStatus('rejected');

  return {
    from: from || null, to: to || null,
    pendingCount: pending.length, pendingDays: days(pending),
    approvedCount: approved.length, approvedDays: days(approved),
    rejectedCount: rejected.length,
    taken: days(approved),   // Total Leave Taken = approved days in the period
  };
}

module.exports = { leaveSummary, daysInclusive, resolveDays };
