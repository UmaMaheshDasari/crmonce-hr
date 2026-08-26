/**
 * RBAC Phase C — security audit logging.
 *
 * Verifies: the RBAC guards stash what they check (additive, no behaviour change);
 * shouldAudit() scopes logging to guarded mutations + denied attempts (never routine
 * GET reads); buildEntry() maps a finished request to a correct row; record() is
 * best-effort; and the res 'finish' middleware writes exactly one row for a guarded
 * mutation. No network — d365.create is stubbed.
 */
process.env.NODE_ENV = 'test';
process.env.AZURE_CLIENT_ID = process.env.AZURE_CLIENT_ID || 'test-client';
process.env.AZURE_CLIENT_SECRET = process.env.AZURE_CLIENT_SECRET || 'test-secret';
process.env.AZURE_TENANT_ID = process.env.AZURE_TENANT_ID || 'test-tenant';

const { test } = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');

const auditLog = require('../src/services/audit-log.service');
const { auditSensitiveActions } = require('../src/middleware/audit.middleware');
const { requireAnyPermission, requireRole } = require('../src/middleware/auth.middleware');
const d365 = require('../src/services/d365.service');

// Capture d365.create calls, restore afterwards.
function stubCreate(impl) {
  const orig = d365.create;
  const calls = [];
  d365.create = async (entity, body) => { calls.push({ entity, body }); if (impl) return impl(entity, body); return { id: 'x' }; };
  return { calls, restore() { d365.create = orig; } };
}

// Run a guard middleware to populate req._audit (mirrors production).
function applyGuard(guard, role) {
  const req = { user: role ? { role } : undefined };
  guard(req, { status() { return this; }, json() { return this; } }, () => {});
  return req;
}

// ── guards stash what they checked (additive) ──
test('requireAnyPermission stashes action + required; requireRole stashes role', () => {
  assert.deepEqual(applyGuard(requireAnyPermission('leave.approve', 'leave.reject'), 'hr_manager')._audit,
    { action: 'leave.approve', required: 'leave.approve|leave.reject' });
  assert.equal(applyGuard(requireRole('super_admin'), 'super_admin')._audit.required, 'role:super_admin');
});

test('stashing happens even when the guard DENIES (so denials are auditable)', () => {
  const req = applyGuard(requireAnyPermission('payroll.process'), 'employee'); // employee denied
  assert.equal(req._audit.action, 'payroll.process');
});

// ── pathTemplate ──
test('pathTemplate strips query and collapses ids to :id', () => {
  assert.equal(auditLog.pathTemplate('/api/leaves/123e4567-e89b-12d3-a456-426614174000?x=1'), '/api/leaves/:id');
  assert.equal(auditLog.pathTemplate('/api/payroll/42/lock'), '/api/payroll/:id/lock');
});

// ── shouldAudit: scope ──
test('shouldAudit: guarded mutation → true; guarded GET success → false; guarded GET 403 → true; unguarded → false', () => {
  const g = { _audit: { action: 'leave.approve' } };
  assert.equal(auditLog.shouldAudit({ ...g, method: 'PATCH' }, { statusCode: 200 }), true);   // mutation
  assert.equal(auditLog.shouldAudit({ ...g, method: 'GET' }, { statusCode: 200 }), false);     // routine read → skipped
  assert.equal(auditLog.shouldAudit({ ...g, method: 'GET' }, { statusCode: 403 }), true);      // denied read → logged
  assert.equal(auditLog.shouldAudit({ method: 'PATCH' }, { statusCode: 200 }), false);         // no guard ran → not in scope
});

// ── buildEntry: mapping ──
test('buildEntry: success mutation → full row', () => {
  const req = { _audit: { action: 'leave.approve', required: 'leave.approve|leave.reject' }, method: 'PATCH',
    originalUrl: '/api/leaves/123e4567-e89b-12d3-a456-426614174000', params: { id: '123e4567-e89b-12d3-a456-426614174000' },
    user: { id: 'u1', name: 'HR One', role: 'hr_manager' }, ip: '10.0.0.9' };
  const e = auditLog.buildEntry(req, { statusCode: 200 });
  assert.equal(e.action, 'leave.approve');
  assert.equal(e.category, 'leave');
  assert.equal(e.actor, 'HR One');
  assert.equal(e.actorRole, 'hr_manager');
  assert.equal(e.outcome, 'success');
  assert.equal(e.method, 'PATCH');
  assert.equal(e.path, '/api/leaves/:id');
  assert.equal(e.targetId, '123e4567-e89b-12d3-a456-426614174000');
  assert.equal(e.ip, '10.0.0.9');
});

test('buildEntry: 403 → outcome denied; role-guard fallback action from method+path', () => {
  const denied = auditLog.buildEntry({ _audit: { action: 'employees.delete' }, method: 'DELETE', originalUrl: '/api/employees/7', params: { id: '7' }, user: { role: 'employee' } }, { statusCode: 403 });
  assert.equal(denied.outcome, 'denied');
  const roleGuard = auditLog.buildEntry({ _audit: { required: 'role:super_admin' }, method: 'PATCH', originalUrl: '/api/payroll/9/unlock', params: { id: '9' }, user: { role: 'hr_manager' } }, { statusCode: 403 });
  assert.equal(roleGuard.action, 'PATCH /api/payroll/:id/unlock');   // no dotted permission → derived label
  assert.equal(roleGuard.category, 'general');
  assert.equal(roleGuard.outcome, 'denied');
});

// ── record: best-effort persistence ──
test('record writes a row with hr_ fields', async () => {
  const s = stubCreate();
  try {
    await auditLog.record({ action: 'payroll.process', category: 'payroll', actor: 'Admin', actorRole: 'super_admin', method: 'POST', outcome: 'success', occurredOn: '2026-08-26T00:00:00.000Z' });
    assert.equal(s.calls.length, 1);
    assert.equal(s.calls[0].body.hr_action, 'payroll.process');
    assert.equal(s.calls[0].body.hr_outcome, 'success');
    assert.ok(s.calls[0].body.hr_name.startsWith('payroll.process'));
  } finally { s.restore(); }
});

test('record swallows write errors (never throws)', async () => {
  const s = stubCreate(() => { throw new Error('Dataverse 500'); });
  try { await auditLog.record({ action: 'x.y' }); } finally { s.restore(); }
  // reaching here without throwing is the assertion
  assert.ok(true);
});

// ── middleware: res 'finish' records exactly one row for a guarded mutation ──
test('middleware records one row on finish for a guarded mutation; none for unguarded GET', async () => {
  const s = stubCreate();
  try {
    // guarded mutation
    const req1 = { _audit: { action: 'compoff.approve' }, method: 'PATCH', originalUrl: '/api/attendance/comp-off/5/approve', params: { id: '5' }, user: { role: 'hr_manager', name: 'HR' }, ip: '1.2.3.4' };
    const res1 = new EventEmitter(); res1.statusCode = 200;
    let nexted = false; auditSensitiveActions(req1, res1, () => { nexted = true; });
    assert.equal(nexted, true);            // never blocks
    res1.emit('finish');
    await new Promise((r) => setImmediate(r));   // let the fire-and-forget record() run
    assert.equal(s.calls.length, 1);
    assert.equal(s.calls[0].body.hr_action, 'compoff.approve');

    // unguarded GET → nothing
    const req2 = { method: 'GET', originalUrl: '/api/attendance', user: { role: 'employee' } };
    const res2 = new EventEmitter(); res2.statusCode = 200;
    auditSensitiveActions(req2, res2, () => {});
    res2.emit('finish');
    await new Promise((r) => setImmediate(r));
    assert.equal(s.calls.length, 1);       // unchanged
  } finally { s.restore(); }
});
