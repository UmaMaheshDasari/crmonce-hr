const jwt = require('jsonwebtoken');
// RBAC granular catalogue (Phase A). ADDITIVE: the legacy colon PERMISSIONS map + the
// existing requirePermission below are UNCHANGED and still drive current enforcement.
// These new helpers use the granular 'module.action' catalogue and are wired to routes
// only in Phase B.
const { hasPermission, permissionsForRole, ROLE_PERMISSIONS: GRANULAR_ROLE_PERMISSIONS, CATALOGUE, ALL_PERMISSIONS } = require('../config/permissions');

const ROLES = {
  SUPER_ADMIN: 'super_admin',
  HR_MANAGER: 'hr_manager',
  EMPLOYEE: 'employee',
  RECRUITER: 'recruiter',
};

const PERMISSIONS = {
  super_admin:  ['*'],
  hr_manager:   ['employee:*', 'attendance:*', 'payroll:*', 'leave:*', 'performance:*', 'document:*', 'recruitment:read'],
  recruiter:    ['recruitment:*', 'employee:read'],
  employee:     ['employee:read:self', 'attendance:read:self', 'attendance:write:self', 'payroll:read:self', 'leave:*:self', 'document:read:self', 'document:write:self', 'performance:read:self', 'goal:read:self'],
};

function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Access token required' });

  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ['HS256'] });
    next();
  } catch (err) {
    return res.status(403).json({ error: 'Invalid or expired token' });
  }
}

function requireRole(...roles) {
  return (req, res, next) => {
    // Stash what this guard checks so the audit middleware can log the action (additive; no behaviour change).
    req._audit = { required: `role:${roles.join(',')}`, ...(req._audit || {}) };
    if (!roles.includes(req.user?.role)) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }
    next();
  };
}

function requirePermission(permission) {
  return (req, res, next) => {
    const userRole = req.user?.role;
    const perms = PERMISSIONS[userRole] || [];
    const [reqMod, reqAction] = permission.split(':');

    const hasAll = perms.includes('*');
    const hasExact = perms.includes(permission);
    // Check wildcard: employee:* matches employee:read
    const hasWildcard = perms.some(p => {
      const parts = p.split(':');
      return parts[0] === reqMod && parts[1] === '*';
    });
    // Check :self variant: attendance:read:self matches attendance:read
    const hasSelf = perms.some(p => {
      const parts = p.split(':');
      return parts[0] === reqMod && (parts[1] === reqAction || parts[1] === '*') && parts[2] === 'self';
    });

    if (hasAll || hasExact || hasWildcard || hasSelf) return next();
    return res.status(403).json({ error: 'Permission denied' });
  };
}

// ── RBAC granular helpers (Phase A — NOT yet attached to any route) ──
// Pass if the user's role holds ANY of the given 'module.action' permissions.
function requireAnyPermission(...perms) {
  return (req, res, next) => {
    // Stash the granular permission for the audit middleware (additive; no behaviour change).
    req._audit = { ...(req._audit || {}), action: perms[0], required: perms.join('|') };
    if (perms.some((p) => hasPermission(req.user, p))) return next();
    return res.status(403).json({ error: 'Permission denied' });
  };
}
// Pass if the user's role holds the single granular permission.
function requireGranular(permission) {
  return requireAnyPermission(permission);
}

module.exports = {
  authenticateToken, requireRole, requirePermission, ROLES, PERMISSIONS,
  // Phase A additions (granular catalogue) — safe to import; unused by routes until Phase B.
  hasPermission, permissionsForRole, requireAnyPermission, requireGranular,
  GRANULAR_ROLE_PERMISSIONS, CATALOGUE, ALL_PERMISSIONS,
};
