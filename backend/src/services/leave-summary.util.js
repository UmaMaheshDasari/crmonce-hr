/**
 * Pure leave-summary math (unit-testable, no I/O). Filters by a [from, to] period
 * (inclusive, on the leave's fromDate) — drives the dashboard Leave Summary.
 * rows: [{ days:Number, fromDate:'YYYY-MM-DD', status:'approved|pending|rejected|cancelled' }]
 */
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

module.exports = { leaveSummary };
