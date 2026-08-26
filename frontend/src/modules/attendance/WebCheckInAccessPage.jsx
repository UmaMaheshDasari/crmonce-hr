import { useState, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { employeeApi } from '../../api/endpoints';
import { ClockIcon, MagnifyingGlassIcon } from '@heroicons/react/24/outline';
import toast from 'react-hot-toast';
import { useAuth } from '../../context/AuthContext';

const inp = 'h-10 px-3 bg-gray-50 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-400';

// Coerce the stored string flag ('true'/'false'/absent) to a boolean.
const isOn = (v) => v === true || /^(true|yes|1|on)$/i.test(String(v ?? ''));

function Toggle({ checked, onChange, disabled }) {
  return (
    <button type="button" onClick={() => !disabled && onChange(!checked)} disabled={disabled}
      className={`relative w-11 h-6 rounded-full transition-colors disabled:opacity-50 ${checked ? 'bg-indigo-600' : 'bg-gray-300'}`}
      aria-pressed={checked} title={checked ? 'Web Check-In enabled' : 'Web Check-In disabled'}>
      <span className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform ${checked ? 'translate-x-5' : ''}`} />
    </button>
  );
}

export default function WebCheckInAccessPage() {
  const { hasPermission } = useAuth();
  const canToggle = hasPermission('employees.edit');   // RBAC Phase D (page also route-gated to HR)
  const qc = useQueryClient();
  const [search, setSearch] = useState('');
  const [dept, setDept] = useState('');
  const [status, setStatus] = useState('active');
  const [access, setAccess] = useState('all');   // all | enabled | disabled
  const [savingId, setSavingId] = useState(null);

  const { data: listRes, isLoading } = useQuery({
    queryKey: ['employees-webcheckin'],
    queryFn: () => employeeApi.list({ limit: 1000 }).then(r => r.data),
  });
  const employees = listRes?.data || [];

  const departments = useMemo(
    () => [...new Set(employees.map(e => e.hr_department).filter(Boolean))].sort(),
    [employees],
  );

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return employees.filter(e => {
      const on = isOn(e.hr_webcheckinenabled);
      if (q && !(`${e.hr_hremployee1 || ''} ${e.hr_email || ''}`.toLowerCase().includes(q))) return false;
      if (dept && e.hr_department !== dept) return false;
      if (status && String(e.hr_status || '').toLowerCase() !== status) return false;
      if (access === 'enabled' && !on) return false;
      if (access === 'disabled' && on) return false;
      return true;
    });
  }, [employees, search, dept, status, access]);

  const toggle = useMutation({
    mutationFn: ({ id, enabled }) => employeeApi.setWebCheckin(id, enabled),
    onMutate: ({ id }) => setSavingId(id),
    onSuccess: (res, { enabled }) => {
      const name = res?.data?.employeeName || 'Employee';
      toast.success(`Web Check-In access ${enabled ? 'enabled' : 'disabled'} for ${name}.`);
      qc.invalidateQueries({ queryKey: ['employees-webcheckin'] });
    },
    onError: (e) => toast.error(e.response?.data?.error || 'Failed to update access'),
    onSettled: () => setSavingId(null),
  });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900 tracking-tight flex items-center gap-2">
          <ClockIcon className="w-6 h-6 text-indigo-500" /> Web Check-In Access
        </h1>
        <p className="text-sm text-gray-500 mt-1">
          Control which employees can punch in/out from the browser. Web Check-In is <span className="font-semibold text-gray-600">disabled by default</span> — enable it per employee. The eTime/device attendance flow is unaffected.
        </p>
      </div>

      {/* Filters */}
      <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-4">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
          <div className="relative">
            <MagnifyingGlassIcon className="w-4 h-4 text-gray-400 absolute left-3 top-1/2 -translate-y-1/2" />
            <input className={`${inp} w-full pl-9`} placeholder="Search name or email…" value={search} onChange={e => setSearch(e.target.value)} />
          </div>
          <select className={`${inp} w-full`} value={dept} onChange={e => setDept(e.target.value)}>
            <option value="">All Departments</option>
            {departments.map(d => <option key={d} value={d}>{d}</option>)}
          </select>
          <select className={`${inp} w-full`} value={status} onChange={e => setStatus(e.target.value)}>
            <option value="">All Status</option>
            <option value="active">Active</option>
            <option value="inactive">Inactive</option>
          </select>
          <select className={`${inp} w-full`} value={access} onChange={e => setAccess(e.target.value)}>
            <option value="all">All Access</option>
            <option value="enabled">Enabled only</option>
            <option value="disabled">Disabled only</option>
          </select>
        </div>
      </div>

      {/* Table */}
      <div className="bg-white rounded-xl border border-gray-100 shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-gray-500">
              <tr className="text-left">
                <th className="px-4 py-3 font-semibold">Employee</th>
                <th className="px-4 py-3 font-semibold">Department</th>
                <th className="px-4 py-3 font-semibold">Position</th>
                <th className="px-4 py-3 font-semibold">Status</th>
                <th className="px-4 py-3 font-semibold text-center">Web Check-In Access</th>
                <th className="px-4 py-3 font-semibold text-right">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {isLoading ? (
                <tr><td colSpan={6} className="px-4 py-10 text-center text-gray-400">Loading…</td></tr>
              ) : rows.length === 0 ? (
                <tr><td colSpan={6} className="px-4 py-10 text-center text-gray-400">No employees match these filters.</td></tr>
              ) : rows.map(e => {
                const on = isOn(e.hr_webcheckinenabled);
                const saving = savingId === e.hr_hremployeeid;
                return (
                  <tr key={e.hr_hremployeeid} className="hover:bg-gray-50/50">
                    <td className="px-4 py-3 font-medium text-gray-800">{e.hr_hremployee1 || '—'}</td>
                    <td className="px-4 py-3 text-gray-600">{e.hr_department || '—'}</td>
                    <td className="px-4 py-3 text-gray-600">{e.hr_designation || '—'}</td>
                    <td className="px-4 py-3">
                      <span className={`inline-flex text-[11px] font-semibold px-2 py-0.5 rounded-full capitalize ${String(e.hr_status).toLowerCase() === 'active' ? 'bg-emerald-50 text-emerald-700' : 'bg-gray-100 text-gray-500'}`}>{e.hr_status || '—'}</span>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center justify-center gap-2">
                        <Toggle checked={on} disabled={saving || !canToggle} onChange={(next) => toggle.mutate({ id: e.hr_hremployeeid, enabled: next })} />
                        <span className={`text-[11px] font-semibold px-2 py-0.5 rounded-full ${on ? 'bg-emerald-50 text-emerald-700' : 'bg-gray-100 text-gray-400'}`}>{on ? 'Enabled' : 'Disabled'}</span>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-right">
                      {canToggle && <button
                        onClick={() => toggle.mutate({ id: e.hr_hremployeeid, enabled: !on })}
                        disabled={saving}
                        className={`px-3 py-1.5 text-xs font-semibold rounded-lg disabled:opacity-50 ${on ? 'text-red-600 bg-red-50 hover:bg-red-100' : 'text-indigo-600 bg-indigo-50 hover:bg-indigo-100'}`}>
                        {saving ? 'Saving…' : on ? 'Disable' : 'Enable'}
                      </button>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
