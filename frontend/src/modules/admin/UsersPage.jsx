import { useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { UsersIcon, MagnifyingGlassIcon, ShieldCheckIcon } from '@heroicons/react/24/outline';
import { employeeApi, rolesApi } from '../../api/endpoints';
import { useAuth } from '../../context/AuthContext';

// Assignable roles (Manager is NOT a role — it is the reporting-manager workflow).
const ROLE_OPTIONS = [
  { value: 'employee', label: 'Employee' },
  { value: 'hr_manager', label: 'HR' },
  { value: 'super_admin', label: 'Super Admin' },
  { value: 'recruiter', label: 'Recruiter' },
];
const roleLabel = (r) => ROLE_OPTIONS.find((o) => o.value === r)?.label || (r ? r.replace('_', ' ') : '—');
const ROLE_STYLE = {
  super_admin: 'bg-violet-50 text-violet-700', hr_manager: 'bg-indigo-50 text-indigo-700',
  recruiter: 'bg-amber-50 text-amber-700', employee: 'bg-gray-100 text-gray-600',
};

function ChangeRoleModal({ emp, onClose }) {
  const qc = useQueryClient();
  const [role, setRole] = useState(emp.hr_role || 'employee');
  const [reason, setReason] = useState('');
  const save = useMutation({
    mutationFn: () => rolesApi.assignRole(emp.hr_hremployeeid, role, reason),
    onSuccess: (res) => {
      toast.success(res.data?.changed === false ? 'No change — role unchanged' : `Role updated to ${roleLabel(role)}`);
      qc.invalidateQueries({ queryKey: ['admin-users'] });
      onClose();
    },
    onError: (e) => toast.error(e.response?.data?.error || 'Could not change role'),
  });
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => !save.isPending && onClose()}>
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-md p-6" onClick={(e) => e.stopPropagation()}>
        <h2 className="text-lg font-bold text-gray-900">Change Role</h2>
        <p className="text-xs text-gray-400 mb-4">{emp.hr_hremployee1} · {emp.hr_email}</p>
        <label className="block text-xs font-medium text-gray-500 mb-1">New Role</label>
        <select value={role} onChange={(e) => setRole(e.target.value)} className="w-full h-10 px-3 bg-gray-50 border border-gray-200 rounded-lg text-sm mb-3">
          {ROLE_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
        <label className="block text-xs font-medium text-gray-500 mb-1">Reason (recorded in the audit log)</label>
        <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Promoted to HR"
          className="w-full h-10 px-3 bg-gray-50 border border-gray-200 rounded-lg text-sm mb-5" />
        <div className="flex justify-end gap-2">
          <button onClick={onClose} disabled={save.isPending} className="px-4 py-2 text-sm font-medium text-gray-600 bg-gray-100 rounded-xl hover:bg-gray-200 disabled:opacity-50">Cancel</button>
          <button onClick={() => save.mutate()} disabled={save.isPending} className="px-5 py-2 text-sm font-semibold text-white bg-indigo-600 rounded-xl hover:bg-indigo-700 disabled:opacity-50">{save.isPending ? 'Saving…' : 'Save'}</button>
        </div>
      </div>
    </div>
  );
}

export default function UsersPage() {
  const { user, hasPermission } = useAuth();
  const canView = hasPermission('users.view');
  const canEditRole = hasPermission('roles.edit');
  const [search, setSearch] = useState('');
  const [editEmp, setEditEmp] = useState(null);

  const { data, isLoading } = useQuery({ queryKey: ['admin-users'], queryFn: () => employeeApi.list({ limit: 500 }), enabled: canView });
  const rows = useMemo(() => data?.data?.data || data?.data || [], [data]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((e) => `${e.hr_hremployee1 || ''} ${e.hr_email || ''} ${e.hr_role || ''}`.toLowerCase().includes(q));
  }, [rows, search]);

  if (!canView) return <div className="p-8 text-center text-sm text-gray-400">You do not have permission to view Users.</div>;

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-3">
        <div className="w-10 h-10 bg-gradient-to-br from-indigo-500 to-indigo-700 rounded-xl grid place-items-center shadow-lg shadow-indigo-500/20"><UsersIcon className="w-5 h-5 text-white" /></div>
        <div>
          <h1 className="text-2xl font-bold text-gray-900 tracking-tight">Users</h1>
          <p className="text-sm text-gray-400">{filtered.length} user{filtered.length === 1 ? '' : 's'} · role assignment is audited</p>
        </div>
      </div>

      <div className="bg-white rounded-xl border border-gray-100 p-3">
        <div className="relative max-w-sm">
          <MagnifyingGlassIcon className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-300" />
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search name, email or role"
            className="w-full h-10 pl-9 pr-3 bg-gray-50 border border-gray-200 rounded-lg text-sm outline-none focus:ring-2 focus:ring-indigo-500/20" />
        </div>
      </div>

      <div className="bg-white rounded-xl border border-gray-100 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50/80 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">
                <th className="px-5 py-3">Employee</th><th className="px-5 py-3">Email</th><th className="px-5 py-3">Role</th><th className="px-5 py-3">Status</th><th className="px-5 py-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100/70">
              {isLoading ? (
                <tr><td colSpan={5} className="px-5 py-10 text-center text-gray-400">Loading…</td></tr>
              ) : filtered.length === 0 ? (
                <tr><td colSpan={5} className="px-5 py-10 text-center text-gray-400">No users found.</td></tr>
              ) : filtered.map((e) => {
                const isSelf = e.hr_hremployeeid === user?.id;
                return (
                  <tr key={e.hr_hremployeeid} className="hover:bg-gray-50/50">
                    <td className="px-5 py-3 font-semibold text-gray-900">{e.hr_hremployee1 || '—'}</td>
                    <td className="px-5 py-3 text-gray-500">{e.hr_email || '—'}</td>
                    <td className="px-5 py-3"><span className={`text-[11px] font-semibold px-2 py-0.5 rounded-full ${ROLE_STYLE[e.hr_role] || 'bg-gray-100 text-gray-600'}`}>{roleLabel(e.hr_role)}</span></td>
                    <td className="px-5 py-3"><span className={`text-[11px] font-semibold ${e.hr_status === 'active' ? 'text-emerald-600' : 'text-gray-400'}`}>{e.hr_status || '—'}</span></td>
                    <td className="px-5 py-3 text-right">
                      {canEditRole && !isSelf && (
                        <button onClick={() => setEditEmp(e)} className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-semibold text-indigo-700 bg-indigo-50 rounded-lg hover:bg-indigo-100"><ShieldCheckIcon className="w-3.5 h-3.5" /> Change Role</button>
                      )}
                      {isSelf && <span className="text-[11px] text-gray-300">You</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {editEmp && <ChangeRoleModal emp={editEmp} onClose={() => setEditEmp(null)} />}
    </div>
  );
}
