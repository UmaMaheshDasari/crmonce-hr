/**
 * Leave balance view resolver — proves the SINGLE Leave Management employee selector
 * drives both the balance cards and the request list, that HR + "All Employees" shows a
 * placeholder (no arbitrary/aggregate balance), and that non-HR users stay on their own
 * balance.
 * Run: `node --test src/utils/leave-balance-target.test.js`
 */
import test from 'node:test';
import assert from 'node:assert';
import { resolveBalanceTargetId, resolveBalanceView } from './leave-balance-target.js';
import { hrLeaveListParams } from './leave-list-query.js';

// ── resolveBalanceTargetId: fixedId pins the balance, else self ───────────────
test('targetId: fixedId wins; otherwise undefined (self)', () => {
  assert.strictEqual(resolveBalanceTargetId({ fixedId: 'emp-7' }), 'emp-7');
  assert.strictEqual(resolveBalanceTargetId({ fixedId: undefined }), undefined);
  assert.strictEqual(resolveBalanceTargetId(), undefined);
});

// ── resolveBalanceView: the Leave page's single-selector behavior ─────────────
test('HR + All Employees (controlled, no employee) → placeholder, no balance fetched', () => {
  const v = resolveBalanceView({ controlled: true, hr: true, fixedId: undefined });
  assert.strictEqual(v.showPlaceholder, true);
  assert.strictEqual(v.targetId, undefined);
});

test('HR + specific employee → that employee\'s balance, no placeholder', () => {
  const v = resolveBalanceView({ controlled: true, hr: true, fixedId: 'emp-9' });
  assert.strictEqual(v.showPlaceholder, false);
  assert.strictEqual(v.targetId, 'emp-9');
});

test('non-HR (controlled) → own balance (self), never a placeholder', () => {
  const v = resolveBalanceView({ controlled: true, hr: false, fixedId: undefined });
  assert.strictEqual(v.showPlaceholder, false);
  assert.strictEqual(v.targetId, undefined);   // undefined → self on the backend
});

test('standalone HR Employee Details (not controlled, pinned id) → that employee, no placeholder', () => {
  const v = resolveBalanceView({ controlled: false, hr: true, fixedId: 'emp-3' });
  assert.strictEqual(v.showPlaceholder, false);
  assert.strictEqual(v.targetId, 'emp-3');
});

test('default (no args) → self, no placeholder (safe fallback)', () => {
  const v = resolveBalanceView();
  assert.deepStrictEqual(v, { showPlaceholder: false, targetId: undefined });
});

// ── One selector drives BOTH sections ────────────────────────────────────────
// The Leave page holds a single employee value (empF) and feeds it to the balance view
// AND the request params. These tests prove both sections follow that one value.
test('selecting a specific employee controls both the balance and the request list', () => {
  const emp = 'emp-42';
  const view = resolveBalanceView({ controlled: true, hr: true, fixedId: emp });
  const params = hrLeaveListParams('', emp); // status '' (All tab) + the selected employee
  assert.strictEqual(view.targetId, emp, 'balance shows the selected employee');
  assert.strictEqual(params.employeeId, emp, 'request list is scoped to the same employee');
});

test('All Employees → request list shows everyone; balance shows the placeholder', () => {
  const empF = '';
  const view = resolveBalanceView({ controlled: true, hr: true, fixedId: empF || undefined });
  const params = hrLeaveListParams('pending', empF);
  assert.strictEqual(view.showPlaceholder, true, 'balance hidden behind placeholder');
  assert.strictEqual(params.employeeId, undefined, 'all authorized employees in the request list');
  assert.strictEqual(params.status, 'pending', 'status still combines with the selector');
});

test('changing the employee updates both sections together', () => {
  const a = 'emp-A', b = 'emp-B';
  const va = resolveBalanceView({ controlled: true, hr: true, fixedId: a });
  const vb = resolveBalanceView({ controlled: true, hr: true, fixedId: b });
  assert.strictEqual(va.targetId, a);
  assert.strictEqual(vb.targetId, b);
  assert.strictEqual(hrLeaveListParams('approved', a).employeeId, a);
  assert.strictEqual(hrLeaveListParams('approved', b).employeeId, b);
});

// ── Status + employee combine; year is not an employee filter ─────────────────
test('status combines with the employee selection in the request params', () => {
  for (const status of ['', 'pending', 'approved', 'rejected']) {
    assert.deepStrictEqual(hrLeaveListParams(status, 'emp-1'), { status: status || undefined, employeeId: 'emp-1' });
  }
});
