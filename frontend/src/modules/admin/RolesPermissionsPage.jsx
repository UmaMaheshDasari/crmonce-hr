import { useMemo, useRef, useState, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ShieldCheckIcon, LockClosedIcon, CheckBadgeIcon } from '@heroicons/react/24/outline';
import { rolesApi } from '../../api/endpoints';
import { useAuth } from '../../context/AuthContext';

// Pretty labels — never invent permission names; we only relabel the code catalogue.
const MODULE_LABEL = { compoff: 'Comp Off', latelogin: 'Late Login', earlylogout: 'Early Logout' };
const titleCase = (s) => String(s).replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
const moduleLabel = (m) => MODULE_LABEL[m] || titleCase(m);

// A single module card: Select-All (display-only, checked/indeterminate) + read-only action checkboxes.
function ModuleCard({ module, actions, granted, fullAccess }) {
  const on = fullAccess ? actions.map((a) => `${module}.${a}`) : actions.filter((a) => granted.has(`${module}.${a}`));
  const allOn = on.length === actions.length && actions.length > 0;
  const someOn = on.length > 0 && !allOn;
  const selectAllRef = useRef(null);
  useEffect(() => { if (selectAllRef.current) selectAllRef.current.indeterminate = someOn; }, [someOn]);

  return (
    <div className="bg-white rounded-xl border border-gray-100 p-4">
      <div className="flex items-center justify-between mb-3 pb-2 border-b border-gray-50">
        <h3 className="text-sm font-bold text-gray-900">{moduleLabel(module)}</h3>
        <label className="inline-flex items-center gap-1.5 text-[11px] font-semibold text-gray-400 select-none">
          <input ref={selectAllRef} type="checkbox" checked={allOn} readOnly disabled
            className="w-3.5 h-3.5 rounded border-gray-300 text-indigo-600 opacity-70" />
          Select All
        </label>
      </div>
      <div className="grid grid-cols-2 gap-x-4 gap-y-2">
        {actions.map((a) => {
          const has = fullAccess || granted.has(`${module}.${a}`);
          return (
            <label key={a} className={`inline-flex items-center gap-2 text-xs ${has ? 'text-gray-700' : 'text-gray-400'}`}>
              <input type="checkbox" checked={has} readOnly disabled
                className="w-3.5 h-3.5 rounded border-gray-300 text-indigo-600 opacity-70 cursor-default" />
              {titleCase(a)}
            </label>
          );
        })}
      </div>
    </div>
  );
}

export default function RolesPermissionsPage() {
  const { hasPermission } = useAuth();
  const canView = hasPermission('roles.view');
  const { data, isLoading, error } = useQuery({ queryKey: ['roles-catalogue'], queryFn: () => rolesApi.list().then((r) => r.data), enabled: canView });
  const catalogue = useMemo(() => data?.catalogue || {}, [data]);
  const roles = useMemo(() => data?.roles || [], [data]);
  const [activeKey, setActiveKey] = useState(null);
  const active = useMemo(() => roles.find((r) => r.key === activeKey) || roles[0] || null, [roles, activeKey]);
  const granted = useMemo(() => new Set(active?.permissions || []), [active]);

  if (!canView) return <div className="p-8 text-center text-sm text-gray-400">You do not have permission to view Roles &amp; Permissions.</div>;

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-3">
        <div className="w-10 h-10 bg-gradient-to-br from-indigo-500 to-indigo-700 rounded-xl grid place-items-center shadow-lg shadow-indigo-500/20"><ShieldCheckIcon className="w-5 h-5 text-white" /></div>
        <div>
          <h1 className="text-2xl font-bold text-gray-900 tracking-tight">Roles &amp; Permissions</h1>
          <p className="text-sm text-gray-400">Granular permissions per role.</p>
        </div>
      </div>

      {/* Read-only notice — permissions are code-managed (Phase A catalogue). */}
      <div className="flex items-center gap-2 text-xs font-medium text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
        <LockClosedIcon className="w-4 h-4 flex-shrink-0" />
        Permissions are code-managed (read-only). Changes are made in the permission catalogue and deployed — they cannot be edited here.
      </div>

      {isLoading ? (
        <div className="p-10 text-center text-sm text-gray-400">Loading roles…</div>
      ) : error ? (
        <div className="p-10 text-center text-sm text-red-500">Could not load roles.</div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-4 gap-5">
          {/* Role list */}
          <div className="lg:col-span-1 space-y-2">
            {roles.map((r) => (
              <button key={r.key} onClick={() => setActiveKey(r.key)}
                className={`w-full text-left px-4 py-3 rounded-xl border transition-all ${active?.key === r.key ? 'border-indigo-300 bg-indigo-50/60 shadow-sm' : 'border-gray-100 bg-white hover:bg-gray-50'}`}>
                <div className="flex items-center justify-between">
                  <span className="text-sm font-bold text-gray-900">{r.label}</span>
                  {r.dormant && <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-gray-100 text-gray-500">Dormant</span>}
                </div>
                <div className="text-xs text-gray-400 mt-0.5">{r.userCount} user{r.userCount === 1 ? '' : 's'} · {r.fullAccess ? 'Full Access' : `${r.permissions.length} permissions`}</div>
              </button>
            ))}
          </div>

          {/* Permission matrix for the active role */}
          <div className="lg:col-span-3">
            {active?.fullAccess ? (
              <div className="bg-white rounded-xl border border-gray-100 p-10 text-center">
                <CheckBadgeIcon className="w-12 h-12 text-emerald-500 mx-auto" />
                <p className="mt-3 text-lg font-bold text-gray-900">Full Access</p>
                <p className="text-sm text-gray-400 mt-1">{active.label} has unrestricted access to every permission (<code className="text-gray-500">*</code>).</p>
              </div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
                {Object.entries(catalogue).map(([module, actions]) => (
                  <ModuleCard key={module} module={module} actions={actions} granted={granted} fullAccess={false} />
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
