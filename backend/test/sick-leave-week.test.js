/**
 * Sick-Leave weekly-repeat document rule: a 2nd valid Sick Leave in the SAME
 * calendar week (Mon–Sun, company/IST civil date) requires a supporting document.
 * Reuses the existing hr_medcertdocid attachment; counts pending+approved records
 * (rejected/cancelled excluded), counts APPLICATIONS not days, and excludes self on
 * edit. Pure week logic + async validation (d365 stubbed). No network.
 */
process.env.NODE_ENV = 'test';
process.env.AZURE_CLIENT_ID = process.env.AZURE_CLIENT_ID || 'test-client';
process.env.AZURE_CLIENT_SECRET = process.env.AZURE_CLIENT_SECRET || 'test-secret';
process.env.AZURE_TENANT_ID = process.env.AZURE_TENANT_ID || 'test-tenant';

const { test } = require('node:test');
const assert = require('node:assert');
const w = require('../src/services/sick-leave-week.util');
const d365 = require('../src/services/d365.service');
const { toValue } = require('../src/services/picklist');

// Reference dates (all 2026): 08-17 Mon, 08-18 Tue, 08-19 Wed, 08-20 Thu, 08-21 Fri,
// 08-23 Sun, 08-24 next Mon, 08-30 next Sun.
const SL = (from, to = from, extra = {}) => ({ fromDate: from, toDate: to, ...extra });

// ── weekBounds (Mon–Sun, boundary) — test 16 ─────────────────────────────────
test('weekBounds: Mon/Tue/Sun of a week all resolve to the same Mon–Sun', () => {
  const exp = { monday: '2026-08-17', sunday: '2026-08-23' };
  assert.deepStrictEqual(w.weekBounds('2026-08-17'), exp);   // Monday
  assert.deepStrictEqual(w.weekBounds('2026-08-18'), exp);   // Tuesday
  assert.deepStrictEqual(w.weekBounds('2026-08-23'), exp);   // Sunday
});
test('weekBounds: Sunday and the next Monday are DIFFERENT weeks (boundary)', () => {
  assert.strictEqual(w.weekBounds('2026-08-23').monday, '2026-08-17');   // Sun → this week
  assert.strictEqual(w.weekBounds('2026-08-24').monday, '2026-08-24');   // Mon → next week
});

// ── pure secondSickLeaveInWeek — business cases ──────────────────────────────
test('1 — first Sick Leave of the week → NOT required', () => {
  assert.strictEqual(w.secondSickLeaveInWeek({ fromDate: '2026-08-19', toDate: '2026-08-19', existing: [] }), false);
});
test('2 — second Sick Leave in the same week → required', () => {
  assert.strictEqual(w.secondSickLeaveInWeek({ fromDate: '2026-08-19', toDate: '2026-08-19', existing: [SL('2026-08-17')] }), true);
});
test('3 — Sick Leave in the next week → NOT required (rule resets weekly)', () => {
  assert.strictEqual(w.secondSickLeaveInWeek({ fromDate: '2026-08-24', toDate: '2026-08-24', existing: [SL('2026-08-17')] }), false);
});
test('4 — same week with a Casual Leave between → 2nd Sick Leave still required (Casual not counted)', () => {
  // Only Sick Leaves are ever in `existing`; a Casual on Tue does not appear and does not break the week.
  assert.strictEqual(w.secondSickLeaveInWeek({ fromDate: '2026-08-20', toDate: '2026-08-20', existing: [SL('2026-08-17')] }), true);
});
test('8 — multi-day prior Sick Leave counts as ONE application (same week) → required', () => {
  assert.strictEqual(w.secondSickLeaveInWeek({ fromDate: '2026-08-21', toDate: '2026-08-21', existing: [SL('2026-08-18', '2026-08-20')] }), true);
});
test('9 — FUTURE Sick Leave is evaluated against ITS target week, not today', () => {
  assert.strictEqual(w.secondSickLeaveInWeek({ fromDate: '2026-09-01', toDate: '2026-09-01', existing: [SL('2026-08-31')] }), true);   // both in the same future week
  assert.strictEqual(w.secondSickLeaveInWeek({ fromDate: '2026-09-01', toDate: '2026-09-01', existing: [SL('2026-08-24')] }), false);  // prior SL is a different (earlier) week
});
test('MULTI-WEEK request (Fri→Mon) shares BOTH weeks; a prior SL in either → required', () => {
  const span = { fromDate: '2026-08-21', toDate: '2026-08-24' };   // Fri (wk1) → next Mon (wk2)
  assert.strictEqual(w.secondSickLeaveInWeek({ ...span, existing: [SL('2026-08-17')] }), true);   // prior in wk1
  assert.strictEqual(w.secondSickLeaveInWeek({ ...span, existing: [SL('2026-08-25')] }), true);   // prior in wk2
  assert.strictEqual(w.secondSickLeaveInWeek({ ...span, existing: [SL('2026-08-10')] }), false);  // prior in an unrelated week
});

// ── async validateSickLeaveDocumentRequirement (d365 stubbed) ────────────────
const SICK = toValue('hr_leave_type', 'Sick Leave');
const APPROVED = toValue('hr_leave_status', 'approved');
const PENDING = toValue('hr_leave_status', 'pending');
const REJECTED = toValue('hr_leave_status', 'rejected');
const CANCELLED = toValue('hr_leave_status', 'cancelled');

function stub(rows) {
  const orig = d365.getList; let filter = '';
  d365.getList = async (_e, opts) => { filter = String(opts?.filter || ''); return { data: rows }; };
  return { getFilter: () => filter, restore() { d365.getList = orig; } };
}

test('query counts ONLY pending+approved Sick Leave (rejected/cancelled excluded by the filter) — tests 5 & 6', async () => {
  const s = stub([]);
  try {
    await w.validateSickLeaveDocumentRequirement('E1', '2026-08-19', '2026-08-19');
    const f = s.getFilter();
    assert.ok(f.includes(`hr_leavetype eq ${SICK}`));
    assert.ok(f.includes(`hr_status eq ${APPROVED}`) && f.includes(`hr_status eq ${PENDING}`));
    assert.ok(!f.includes(`hr_status eq ${REJECTED}`) && !f.includes(`hr_status eq ${CANCELLED}`));
  } finally { s.restore(); }
});
test('7 — a PENDING prior Sick Leave in the same week → required (existing rule counts pending)', async () => {
  const s = stub([{ hr_hrleaveid: 'A', hr_fromdate: '2026-08-17', hr_todate: '2026-08-17', hr_status: PENDING }]);
  try {
    const r = await w.validateSickLeaveDocumentRequirement('E1', '2026-08-19', '2026-08-19');
    assert.strictEqual(r.required, true);
    assert.match(r.apiError, /already applied for Sick Leave earlier this week/);
    assert.match(r.message, /Supporting document is required/);
  } finally { s.restore(); }
});
test('approved prior Sick Leave same week → required', async () => {
  const s = stub([{ hr_hrleaveid: 'A', hr_fromdate: '2026-08-18', hr_todate: '2026-08-20', hr_status: APPROVED }]);
  try { assert.strictEqual((await w.validateSickLeaveDocumentRequirement('E1', '2026-08-21', '2026-08-21')).required, true); }
  finally { s.restore(); }
});
test('1 (async) — no prior Sick Leave in the week → NOT required', async () => {
  const s = stub([{ hr_hrleaveid: 'A', hr_fromdate: '2026-08-10', hr_todate: '2026-08-10', hr_status: APPROVED }]);  // last week
  try { assert.strictEqual((await w.validateSickLeaveDocumentRequirement('E1', '2026-08-19', '2026-08-19')).required, false); }
  finally { s.restore(); }
});
test('10 — editing excludes SELF: the record being edited never counts itself', async () => {
  const s = stub([{ hr_hrleaveid: 'SELF', hr_fromdate: '2026-08-17', hr_todate: '2026-08-17', hr_status: PENDING }]);
  try {
    assert.strictEqual((await w.validateSickLeaveDocumentRequirement('E1', '2026-08-17', '2026-08-17', { excludeLeaveId: 'SELF' })).required, false);
    assert.strictEqual((await w.validateSickLeaveDocumentRequirement('E1', '2026-08-19', '2026-08-19')).required, true);   // without exclude → the other record counts
  } finally { s.restore(); }
});
test('11/12 — the decision the apply route enforces: required=true with a doc-required message', async () => {
  const s = stub([{ hr_hrleaveid: 'A', hr_fromdate: '2026-08-17', hr_todate: '2026-08-17', hr_status: APPROVED }]);
  try {
    const r = await w.validateSickLeaveDocumentRequirement('E1', '2026-08-19', '2026-08-19');
    assert.strictEqual(r.required, true);   // route: `if (docRequired && !medCertDocId) return 400 apiError`
  } finally { s.restore(); }
});
test('invalid/blank dates → NOT required (never throws)', async () => {
  assert.strictEqual((await w.validateSickLeaveDocumentRequirement('E1', '', '')).required, false);
  assert.strictEqual((await w.validateSickLeaveDocumentRequirement('', '2026-08-19', '2026-08-19')).required, false);
});
