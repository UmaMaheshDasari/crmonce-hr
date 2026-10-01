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

/** A leave row (or its stored flag value) is a half-day iff hr_halfday === 'true'. */
function isHalfDayLeave(halfday) {
  return String(halfday) === 'true';
}

/**
 * THE authoritative leave-day weight for a record. A HALF-DAY leave (hr_halfday==='true')
 * is always 0.5 — hr_days is stored as the integer 1 (Dataverse hr_days is Edm.Int32 and
 * can never hold 0.5), so the flag is the source of truth and is checked FIRST. Otherwise
 * prefer the stored hr_days; when blank/zero/non-numeric (legacy/imported leaves), fall
 * back to the inclusive from→to span so an approved leave is never worth 0 days.
 * `halfday` is the record's hr_halfday value (optional; absent → full-day, backward compatible).
 */
function resolveDays(rawDays, fromDate, toDate, halfday) {
  if (isHalfDayLeave(halfday)) return 0.5;
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

module.exports = { leaveSummary, daysInclusive, resolveDays, isHalfDayLeave };
