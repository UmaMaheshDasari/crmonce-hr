import { useMemo, useRef, useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { ShieldCheckIcon, LockClosedIcon, CheckBadgeIcon, PencilSquareIcon } from '@heroicons/react/24/outline';
import { rolesApi } from '../../api/endpoints';
import { useAuth } from '../../context/AuthContext';

// Pretty labels — never invent permission names; we only relabel the code catalogue.
const MODULE_LABEL = { compoff: 'Comp Off', latelogin: 'Late Login', earlylogout: 'Early Logout' };
const titleCase = (s) => String(s).replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
const moduleLabel = (m) => MODULE_LABEL[m] || titleCase(m);

// A single module card. When `editable`, checkboxes + Select-All are interactive and
// reflect the working draft; otherwise they are read-only (checked from the granted set).
function ModuleCard({ module, actions, selected, editable, onToggle, onToggleAll }) {
  const on = actions.filter((a) => selected.has(`${module}.${a}`));
  const allOn = on.length === actions.length && actions.length > 0;
  const someOn = on.length > 0 && !allOn;
  const selectAllRef = useRef(null);
  useEffect(() => { if (selectAllRef.current) selectAllRef.current.indeterminate = someOn; }, [someOn]);

  return (
    <div className="bg-white rounded-xl border border-gray-100 p-4">
      <div className="flex items-center justify-between mb-3 pb-2 border-b border-gray-50">
        <h3 className="text-sm font-bold text-gray-900">{moduleLabel(module)}</h3>
        <label className={`inline-flex items-center gap-1.5 text-[11px] font-semibold text-gray-400 select-none ${editable ? 'cursor-pointer' : ''}`}>
          <input ref={selectAllRef} type="checkbox" checked={allOn} disabled={!editable}
            onChange={editable ? () => onToggleAll(module, actions, !allOn) : undefined}
            className={`w-3.5 h-3.5 rounded border-gray-300 text-indigo-600 ${editable ? '' : 'opacity-70'}`} />
          Select All
        </label>
      </div>
      <div className="grid grid-cols-2 gap-x-4 gap-y-2">
        {actions.map((a) => {
          const key = `${module}.${a}`;
          const has = selected.has(key);
          return (
            <label key={a} className={`inline-flex items-center gap-2 text-xs ${has ? 'text-gray-700' : 'text-gray-400'} ${editable ? 'cursor-pointer' : ''}`}>
              <input type="checkbox" checked={has} disabled={!editable}
                onChange={editable ? () => onToggle(key) : undefined}
                className={`w-3.5 h-3.5 rounded border-gray-300 text-indigo-600 ${editable ? '' : 'opacity-70 cursor-default'}`} />
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
  const canEditPerm = hasPermission('roles.edit');
  const qc = useQueryClient();
  const { data, isLoading, error } = useQuery({ queryKey: ['roles-catalogue'], queryFn: () => rolesApi.list().then((r) => r.data), enabled: canView });
  const catalogue = useMemo(() => data?.catalogue || {}, [data]);
  const roles = useMemo(() => data?.roles || [], [data]);
  const editable = !!data?.editable && canEditPerm;
  const [activeKey, setActiveKey] = useState(null);
  const active = useMemo(() => roles.find((r) => r.key === activeKey) || roles[0] || null, [roles, activeKey]);

  // Working draft (the set of permissions for the active role). Reset whenever the active
  // role or the loaded data changes. Super Admin (fullAccess) is not edited via checkboxes.
  const original = useMemo(() => new Set(active?.permissions || []), [active]);
  const [draft, setDraft] = useState(() => new Set());
  // Reset the working draft when the selected role changes — render-time adjustment
  // (React's "adjust state when a prop changes" pattern), not an effect.
  const [draftKey, setDraftKey] = useState(null);
  const activeId = active?.key ?? null;
  if (activeId !== draftKey) { setDraftKey(activeId); setDraft(new Set(active?.permissions || [])); }

  // Super Admin is editable too (protected server-side against last-admin lockout).
  const canEditActive = editable && !!active;
  const dirty = useMemo(() => {
    if (draft.size !== original.size) return true;
    for (const p of draft) if (!original.has(p)) return true;
    return false;
  }, [draft, original]);

  const toggle = (key) => setDraft((prev) => { const n = new Set(prev); n.has(key) ? n.delete(key) : n.add(key); return n; });
  const toggleAll = (module, actions, turnOn) => setDraft((prev) => {
    const n = new Set(prev);
    for (const a of actions) { const k = `${module}.${a}`; turnOn ? n.add(k) : n.delete(k); }
    return n;
  });

  const save = useMutation({
    mutationFn: () => rolesApi.updatePermissions(active.key, [...draft]),
    onSuccess: () => { toast.success(`${active.label} permissions updated`); qc.invalidateQueries({ queryKey: ['roles-catalogue'] }); },
    onError: (e) => toast.error(e.response?.data?.error || 'Could not update permissions'),
  });

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

      {/* Notice — editable for Super Admin (roles.edit); read-only otherwise. */}
      {editable ? (
        <div className="flex items-center gap-2 text-xs font-medium text-indigo-800 bg-indigo-50 border border-indigo-200 rounded-lg px-3 py-2">
          <PencilSquareIcon className="w-4 h-4 flex-shrink-0" />
          Permissions can be managed by Super Admin — check or uncheck a permission and click Save Changes. Super Admin keeps full access.
        </div>
      ) : (
        <div className="flex items-center gap-2 text-xs font-medium text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
          <LockClosedIcon className="w-4 h-4 flex-shrink-0" />
          Permissions are read-only for your role. Only a Super Admin (roles.edit) can manage them.
        </div>
      )}

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

          {/* Permission matrix for the active role — Super Admin is editable too, shown with
              a Full Access badge and protected server-side against last-admin lockout. */}
          <div className="lg:col-span-3">
            <div className="space-y-4">
              {active?.fullAccess && (
                <div className="flex items-center gap-2 text-xs font-semibold text-emerald-800 bg-emerald-50 border border-emerald-200 rounded-lg px-3 py-2">
                  <CheckBadgeIcon className="w-4 h-4 flex-shrink-0" />
                  {active.label} has FULL ACCESS (<code className="text-emerald-700">*</code>).{canEditActive ? ' Uncheck to restrict — the last Super Admin cannot lose critical admin permissions.' : ''}
                </div>
              )}
              {/* Save / Reset bar (only when editable + unsaved changes) */}
              {canEditActive && dirty && (
                <div className="sticky top-0 z-10 flex items-center justify-between gap-3 bg-indigo-600 text-white rounded-xl px-4 py-2.5 shadow">
                  <span className="text-sm font-semibold">Unsaved changes to {active.label}</span>
                  <div className="flex gap-2">
                    <button onClick={() => setDraft(new Set(original))} disabled={save.isPending} className="px-3 py-1.5 text-xs font-semibold text-white/90 bg-white/15 rounded-lg hover:bg-white/25 disabled:opacity-50">Reset</button>
                    <button onClick={() => save.mutate()} disabled={save.isPending} className="px-4 py-1.5 text-xs font-semibold text-indigo-700 bg-white rounded-lg hover:bg-indigo-50 disabled:opacity-50">{save.isPending ? 'Saving…' : 'Save Changes'}</button>
                  </div>
                </div>
              )}
              <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
                {Object.entries(catalogue).map(([module, actions]) => (
                  <ModuleCard key={module} module={module} actions={actions} selected={draft}
                    editable={canEditActive} onToggle={toggle} onToggleAll={toggleAll} />
                ))}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
