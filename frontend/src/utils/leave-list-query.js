/**
 * Leave Management list — pure helpers shared by LeavePage so the filter behaviour
 * is unit-testable without a React harness.
 *
 * Authorization is ALWAYS enforced server-side (leave.routes.js GET /): an 'employee'
 * is scoped to their own requests (plus reportee approvals), while HR roles see all
 * or a single employee. These helpers only shape the request/merge the client makes;
 * they never widen what the backend returns.
 */

// Status tabs for the page. "Pending My Approval" was intentionally removed — the
// Pending tab now shows ALL authorized pending requests, not just the viewer's
// approval queue.
export const LEAVE_TABS = [
  { key: '', label: 'All', count: null },
  { key: 'pending', label: 'Pending', count: null },
  { key: 'approved', label: 'Approved', count: null },
  { key: 'rejected', label: 'Rejected', count: null },
];

/**
 * Query params for the HR leave list.
 *  - status '' (the All tab) → omitted, so every status is returned.
 *  - employeeId '' (All Employees) → omitted, so every authorized employee is returned.
 *  - a specific employeeId → that employee only.
 */
export function hrLeaveListParams(status, employeeId) {
  return { status: status || undefined, employeeId: employeeId || undefined };
}

/**
 * Merge a non-HR viewer's own rows with rows awaiting their approval (a manager's
 * reportees), de-duplicating by leave id. Own rows come first; approval-only rows
 * follow. Used on the Pending tab so managers keep their approval queue after the
 * "Pending My Approval" tab was removed.
 */
export function mergeLeaveRows(ownRows = [], approvalRows = []) {
  const byId = new Map();
  for (const r of [...(ownRows || []), ...(approvalRows || [])]) {
    if (r && r.hr_hrleaveid != null) byId.set(r.hr_hrleaveid, r);
  }
  return [...byId.values()];
}
