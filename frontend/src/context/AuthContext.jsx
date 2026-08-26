import { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { authApi } from '../api/endpoints';
import { hasPermission as resolvePermission } from '../utils/permissions';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  // RBAC Phase D: the caller's resolved granular permission list from GET /auth/me.
  // The backend is the source of truth; the frontend consumes this list for UX only.
  const [permissions, setPermissions] = useState([]);
  const [loading, setLoading] = useState(true);

  // Load the canonical session (user + resolved permissions) from /auth/me — the
  // single source for both. Used on boot and after every login path.
  const loadSession = useCallback(async () => {
    const { data } = await authApi.me();
    setUser(data.user);
    setPermissions(Array.isArray(data.permissions) ? data.permissions : []);
    return data.user;
  }, []);

  useEffect(() => {
    const token = localStorage.getItem('accessToken');
    if (token) {
      loadSession()
        .catch(() => localStorage.clear())
        .finally(() => setLoading(false));
    } else {
      setLoading(false);
    }
  }, [loadSession]);

  // Email/password login. Fetch permissions from /auth/me (single source); fall back to
  // the login payload's user with no permissions if that follow-up call fails.
  const login = useCallback(async (email, password) => {
    const { data } = await authApi.login(email, password);
    localStorage.setItem('accessToken', data.tokens.accessToken);
    localStorage.setItem('refreshToken', data.tokens.refreshToken);
    try { return await loadSession(); }
    catch { setUser(data.user); setPermissions([]); return data.user; }
  }, [loadSession]);

  // Azure AD SSO login — redirect to Microsoft
  const loginWithAzure = useCallback(async () => {
    const { data } = await authApi.azureLogin();
    window.location.href = data.authUrl;
  }, []);

  // Azure AD callback — exchange code for tokens
  const handleAzureCallback = useCallback(async (code) => {
    const { data } = await authApi.azureCallback(code);
    localStorage.setItem('accessToken', data.tokens.accessToken);
    localStorage.setItem('refreshToken', data.tokens.refreshToken);
    try { return await loadSession(); }
    catch { setUser(data.user); setPermissions([]); return data.user; }
  }, [loadSession]);

  const logout = useCallback(async () => {
    try { await authApi.logout(); } catch { /* best-effort; clear locally regardless */ }
    localStorage.clear();
    setUser(null);
    setPermissions([]);
  }, []);

  const hasRole = useCallback((...roles) => roles.includes(user?.role), [user]);
  const isHR = useCallback(() => hasRole('super_admin', 'hr_manager'), [hasRole]);
  const isSuperAdmin = useCallback(() => user?.role === 'super_admin', [user]);
  // Granular permission check (mirrors backend). super_admin ('*') passes everything.
  const hasPermission = useCallback((perm) => resolvePermission(permissions, perm), [permissions]);

  return (
    <AuthContext.Provider value={{ user, permissions, loading, login, loginWithAzure, handleAzureCallback, logout, hasRole, isHR, isSuperAdmin, hasPermission }}>
      {children}
    </AuthContext.Provider>
  );
}

export const useAuth = () => {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
};
