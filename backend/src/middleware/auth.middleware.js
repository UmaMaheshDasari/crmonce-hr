const jwt = require('jsonwebtoken');

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
  employee:     ['employee:read:self', 'attendance:read:self', 'attendance:write:self', 'payroll:read:self', 'leave:*:self', 'document:read:self', 'performance:read:self', 'goal:read:self'],
};

function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Access token required' });

  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch (err) {
    return res.status(403).json({ error: 'Invalid or expired token' });
  }
}

function requireRole(...roles) {
  return (req, res, next) => {
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

module.exports = { authenticateToken, requireRole, requirePermission, ROLES, PERMISSIONS };
