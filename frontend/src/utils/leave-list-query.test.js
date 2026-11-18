/**
 * Leave Management list helpers — covers the employee/status filter behaviour and
 * the removal of the "Pending My Approval" tab.
 * Run: `node --test src/utils/leave-list-query.test.js`
 */
import test from 'node:test';
import assert from 'node:assert';
import { LEAVE_TABS, hrLeaveListParams, mergeLeaveRows } from './leave-list-query.js';

// ── Tab list: "Pending My Approval" removed ──────────────────────────────────
test('tabs are exactly All / Pending / Approved / Rejected (no "Pending My Approval")', () => {
  assert.deepStrictEqual(LEAVE_TABS.map(t => t.label), ['All', 'Pending', 'Approved', 'Rejected']);
  assert.deepStrictEqual(LEAVE_TABS.map(t => t.key), ['', 'pending', 'approved', 'rejected']);
  assert.ok(!LEAVE_TABS.some(t => t.key === 'my_approvals'), 'my_approvals tab removed');
  assert.ok(!LEAVE_TABS.some(t => /approval/i.test(t.label)), 'no "Pending My Approval" label');
});

// ── 1. All Employees + All → every status, every employee ────────────────────
test('HR: All Employees + All → no status, no employeeId (all authorized employees)', () => {
  assert.deepStrictEqual(hrLeaveListParams('', ''), { status: undefined, employeeId: undefined });
});

// ── 2. Specific employee + All → only that employee, every status ────────────
test('HR: specific employee + All → employeeId set, no status', () => {
  assert.deepStrictEqual(hrLeaveListParams('', 'emp-123'), { status: undefined, employeeId: 'emp-123' });
});

// ── 3. All Employees + Pending → all authorized pending ──────────────────────
test('HR: All Employees + Pending → status=pending, no employeeId', () => {
  assert.deepStrictEqual(hrLeaveListParams('pending', ''), { status: 'pending', employeeId: undefined });
});

// ── 4. Specific employee + Pending → only that employee's pending ────────────
test('HR: specific employee + Pending → status=pending, employeeId set', () => {
  assert.deepStrictEqual(hrLeaveListParams('pending', 'emp-9'), { status: 'pending', employeeId: 'emp-9' });
});

// ── 5. Approved / Rejected honour the employee selection ─────────────────────
test('HR: Approved / Rejected pass through with the selected employee', () => {
  assert.deepStrictEqual(hrLeaveListParams('approved', 'emp-9'), { status: 'approved', employeeId: 'emp-9' });
  assert.deepStrictEqual(hrLeaveListParams('rejected', ''), { status: 'rejected', employeeId: undefined });
});

// ── 5b. Approved tab with All Employees → every authorized approved request ──
test('HR: All Employees + Approved → status=approved, no employeeId', () => {
  assert.deepStrictEqual(hrLeaveListParams('approved', ''), { status: 'approved', employeeId: undefined });
});

// ── No month/date restriction: the request is scoped ONLY by status + employee ──
// (The month filter was removed — a selected employee + status returns every matching
// request regardless of the month it was submitted, past or future.)
test('request params carry only status + employeeId — no month/date key', () => {
  for (const [status, emp] of [['', ''], ['pending', 'emp-1'], ['approved', ''], ['rejected', 'emp-2']]) {
    const params = hrLeaveListParams(status, emp);
    assert.deepStrictEqual(Object.keys(params).sort(), ['employeeId', 'status']);
    assert.ok(!('month' in params) && !('year' in params) && !('createdon' in params),
      'no month/year/createdon restriction in the request params');
  }
});

// ── Non-HR Pending merge: own + reportee approvals, de-duplicated ────────────
test('mergeLeaveRows: own + approval rows, de-duplicated by leave id, own first', () => {
  const own = [{ hr_hrleaveid: 'a' }, { hr_hrleaveid: 'b' }];
  const approvals = [{ hr_hrleaveid: 'b' }, { hr_hrleaveid: 'c' }]; // 'b' overlaps
  const merged = mergeLeaveRows(own, approvals);
  assert.deepStrictEqual(merged.map(r => r.hr_hrleaveid), ['a', 'b', 'c']);
});

test('mergeLeaveRows: handles empty / missing inputs safely', () => {
  assert.deepStrictEqual(mergeLeaveRows(), []);
  assert.deepStrictEqual(mergeLeaveRows([{ hr_hrleaveid: 'x' }], undefined).map(r => r.hr_hrleaveid), ['x']);
  // rows without an id are dropped (never crash)
  assert.deepStrictEqual(mergeLeaveRows([{}, { hr_hrleaveid: 'y' }]).map(r => r.hr_hrleaveid), ['y']);
});
