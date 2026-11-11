import { useQuery } from '@tanstack/react-query';
import { Navigate } from 'react-router-dom';
import { companyApi } from '../api/endpoints';
import { isModuleEnabled } from '../utils/module-settings';

/**
 * Route gate for a Company-Settings module switch (Modules section). Mirrors the
 * backend module-flag middleware: while a module is switched off its screens are
 * unreachable even by typing the URL — the page never renders (its APIs 403 too,
 * so this is defence in depth, not the only gate). Existing data is untouched.
 *
 * While settings are still loading the page waits (same spinner as
 * ProtectedRoute) so a disabled module never flashes its screen first.
 */
export default function ModuleRoute({ module, children }) {
  const { data, isLoading } = useQuery({ queryKey: ['company'], queryFn: companyApi.get, staleTime: 600000 });
  if (isLoading) return (
    <div className="flex items-center justify-center h-screen bg-gray-50">
      <div className="w-8 h-8 border-4 border-indigo-600 border-t-transparent rounded-full animate-spin" />
    </div>
  );
  // Missing/unreadable setting defaults to ON (same rule as the backend middleware).
  if (!isModuleEnabled(data?.data?.[module.key])) return <Navigate to="/" replace />;
  return children;
}
