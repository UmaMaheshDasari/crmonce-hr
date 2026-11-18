/**
 * Leave balance target resolver — proves the balance employee selector is INDEPENDENT
 * of the request-list employee filter and never shows an arbitrary employee's balance
 * without an explicit selection.
 * Run: `node --test src/utils/leave-balance-target.test.js`
 */
import test from 'node:test';
import assert from 'node:assert';
import { resolveBalanceTargetId } from './leave-balance-target.js';
import { hrLeaveListParams } from './leave-list-query.js';

// ── Default: no explicit selection → self (undefined), never an arbitrary employee ──
test('HR, no picker selection → undefined (self), not an arbitrary employee', () => {
  assert.strictEqual(resolveBalanceTargetId({ fixedId: undefined, hr: true, selectedEmp: '' }), undefined);
});

test('non-HR → always undefined (self), even if a stray selectedEmp is present', () => {
  assert.strictEqual(resolveBalanceTargetId({ hr: false, selectedEmp: 'emp-x' }), undefined);
  assert.strictEqual(resolveBalanceTargetId({ hr: false, selectedEmp: '' }), undefined);
});

// ── Explicit selection drives the balance ──
test('HR with an explicit picker selection → that employee', () => {
  assert.strictEqual(resolveBalanceTargetId({ hr: true, selectedEmp: 'emp-7' }), 'emp-7');
});

test('fixedId (My Profile / HR Employee Details) always wins', () => {
  assert.strictEqual(resolveBalanceTargetId({ fixedId: 'pinned-1', hr: true, selectedEmp: 'emp-7' }), 'pinned-1');
  assert.strictEqual(resolveBalanceTargetId({ fixedId: 'pinned-1', hr: false, selectedEmp: '' }), 'pinned-1');
});

test('no args → undefined (never throws)', () => {
  assert.strictEqual(resolveBalanceTargetId(), undefined);
});

// ── Independence: the balance picker does not influence the request filter ──────────
test('balance selection does NOT affect request-list params (separate controls)', () => {
  // The request list is driven only by (status, empF). Whatever the balance picker is
  // set to, the request params for "All Employees + Approved" stay employee-unscoped.
  const requestParams = hrLeaveListParams('approved', ''); // empF = All Employees
  assert.deepStrictEqual(requestParams, { status: 'approved', employeeId: undefined });
  // And a chosen balance employee changes only the balance target, not the request params.
  assert.strictEqual(resolveBalanceTargetId({ hr: true, selectedEmp: 'emp-balance' }), 'emp-balance');
  assert.deepStrictEqual(hrLeaveListParams('approved', ''), { status: 'approved', employeeId: undefined });
});

test('request filter does NOT affect balance target (separate controls)', () => {
  // Selecting a request employee ('emp-req') must not change the balance target, which
  // depends only on fixedId/hr/selectedEmp.
  const requestParams = hrLeaveListParams('pending', 'emp-req');
  assert.deepStrictEqual(requestParams, { status: 'pending', employeeId: 'emp-req' });
  assert.strictEqual(resolveBalanceTargetId({ hr: true, selectedEmp: '' }), undefined); // still self
});
