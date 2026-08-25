import { useState, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { payrollSettingsApi } from '../../api/endpoints';
import { ClockIcon, MagnifyingGlassIcon } from '@heroicons/react/24/outline';
import { format } from 'date-fns';

const fmtDT = (d) => { try { return d ? format(new Date(d), 'dd-MM-yyyy, HH:mm') : '—'; } catch { return d || '—'; } };

/**
 * Setting History — append-only log of Company / Payroll / Attendance rule changes.
 * Read-only (no edit/delete): every change to a payroll/attendance setting is recorded.
 */
export default function SettingHistoryPage() {
  const [search, setSearch] = useState('');
  const [user, setUser] = useState('');

  const { data, isLoading } = useQuery({
    queryKey: ['settings-history'],
    queryFn: () => payrollSettingsApi.history().then(r => r.data),
  });
  const all = data?.data || [];

  const users = useMemo(() => [...new Set(all.map(r => r.changedBy).filter(Boolean))].sort(), [all]);

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return all.filter(r => {
      if (q && !(`${r.fieldLabel} ${r.field} ${r.reason}`.toLowerCase().includes(q))) return false;
      if (user && r.changedBy !== user) return false;
      return true;
    });
  }, [all, search, user]);

  return (
    <div className="bg-white rounded-xl border border-gray-100 shadow-sm">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 px-5 py-4 border-b border-gray-100">
        <div>
          <h2 className="text-sm font-bold text-gray-900 flex items-center gap-2"><ClockIcon className="w-5 h-5 text-indigo-500" /> Setting History</h2>
          <p className="text-xs text-gray-400 mt-0.5">Append-only. Every attendance/payroll rule change is recorded — this log cannot be edited or deleted.</p>
        </div>
        <div className="flex items-center gap-2">
          <div className="relative">
            <MagnifyingGlassIcon className="w-4 h-4 text-gray-400 absolute left-3 top-1/2 -translate-y-1/2" />
            <input className="h-9 pl-9 pr-3 bg-gray-50 border border-gray-200 rounded-lg text-sm w-48" placeholder="Search setting / reason…" value={search} onChange={e => setSearch(e.target.value)} />
          </div>
          <select className="h-9 px-2 bg-gray-50 border border-gray-200 rounded-lg text-sm" value={user} onChange={e => setUser(e.target.value)}>
            <option value="">All users</option>
            {users.map(u => <option key={u} value={u}>{u}</option>)}
          </select>
        </div>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 text-gray-500">
            <tr className="text-left">
              <th className="px-4 py-3 font-semibold">Setting</th>
              <th className="px-4 py-3 font-semibold">Old</th>
              <th className="px-4 py-3 font-semibold">New</th>
              <th className="px-4 py-3 font-semibold">Changed By</th>
              <th className="px-4 py-3 font-semibold">Changed At</th>
              <th className="px-4 py-3 font-semibold">Effective</th>
              <th className="px-4 py-3 font-semibold">Version</th>
              <th className="px-4 py-3 font-semibold">Reason</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-50">
            {isLoading ? (
              <tr><td colSpan={8} className="px-4 py-10 text-center text-gray-400">Loading…</td></tr>
            ) : rows.length === 0 ? (
              <tr><td colSpan={8} className="px-4 py-10 text-center text-gray-400">No setting changes recorded yet.</td></tr>
            ) : rows.map(r => (
              <tr key={r.id} className="hover:bg-gray-50/50">
                <td className="px-4 py-3 font-medium text-gray-800">{r.fieldLabel}</td>
                <td className="px-4 py-3 text-gray-400 line-through">{r.oldValue || '—'}</td>
                <td className="px-4 py-3 text-gray-900 font-semibold">{r.newValue || '—'}</td>
                <td className="px-4 py-3 text-gray-600">{r.changedBy || '—'}</td>
                <td className="px-4 py-3 text-gray-500">{fmtDT(r.changedOn)}</td>
                <td className="px-4 py-3 text-gray-500">{r.effectiveDate || '—'}</td>
                <td className="px-4 py-3 text-gray-500">{r.ruleVersion || '—'}</td>
                <td className="px-4 py-3 text-gray-500 max-w-[14rem] truncate">{r.reason || '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
