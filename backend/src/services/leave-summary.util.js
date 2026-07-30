/**
 * Pure leave-summary math (unit-testable, no I/O).
 * rows: [{ days:Number, fromDate:'YYYY-MM-DD', status:'approved|pending|rejected|cancelled', type:'Casual Leave|LOP|…' }]
 */
function leaveSummary(rows = [], { year, month, entitlement = 24 } = {}) {
  const ym = `${year}-${String(month).padStart(2, '0')}`;
  const inYear = rows.filter(r => String(r.fromDate || '').startsWith(String(year)));
  const days = (arr) => arr.reduce((s, r) => s + (Number(r.days) || 0), 0);
  const byStatus = (s) => inYear.filter(r => r.status === s);

  const approved = byStatus('approved');
  const pending = byStatus('pending');
  const rejected = byStatus('rejected');
  const lop = approved.filter(r => r.type === 'LOP');
  const thisMonth = approved.filter(r => String(r.fromDate || '').slice(0, 7) === ym);
  const takenYear = days(approved);

  return {
    entitlement,
    available: Math.max(0, entitlement - takenYear),
    taken: takenYear,
    pending: days(pending), pendingCount: pending.length,
    approved: takenYear, approvedCount: approved.length,
    rejected: days(rejected), rejectedCount: rejected.length,
    lop: days(lop),
    currentMonth: days(thisMonth),
    currentYear: takenYear,
  };
}

module.exports = { leaveSummary };
