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
  employee:     ['employee:read:self', 'attendance:read:self', 'payroll:read:self', 'leave:*:self', 'document:read:self'],
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
    const hasAll = perms.includes('*');
    const hasExact = perms.includes(permission);
    const hasWildcard = perms.some(p => {
      const [mod, action] = p.split(':');
      const [reqMod] = permission.split(':');
      return mod === reqMod && action === '*';
    });
    if (hasAll || hasExact || hasWildcard) return next();
    return res.status(403).json({ error: 'Permission denied' });
  };
}

module.exports = { authenticateToken, requireRole, requirePermission, ROLES, PERMISSIONS };
