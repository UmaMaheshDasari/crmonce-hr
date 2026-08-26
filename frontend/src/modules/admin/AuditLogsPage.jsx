import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { ClipboardDocumentListIcon, ArrowDownTrayIcon, XMarkIcon } from '@heroicons/react/24/outline';
import { auditApi } from '../../api/endpoints';
import { useAuth } from '../../context/AuthContext';

const MODULES = ['employees', 'attendance', 'leave', 'compoff', 'latelogin', 'earlylogout', 'payroll', 'salary', 'payslip', 'performance', 'recruitment', 'documents', 'reports', 'settings', 'users', 'roles', 'permissions', 'audit'];
const ROLES = ['employee', 'hr_manager', 'super_admin', 'recruiter'];
const roleLabel = (r) => ({ hr_manager: 'HR', super_admin: 'Super Admin', employee: 'Employee', recruiter: 'Recruiter' }[r] || r || '—');
const titleCase = (s) => String(s || '').replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
const OUTCOME_STYLE = { success: 'bg-emerald-50 text-emerald-700', denied: 'bg-red-50 text-red-700', error: 'bg-amber-50 text-amber-700' };
const fmtTs = (s) => { try { return new Date(s).toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }); } catch { return s || '—'; } };

// Parse the details JSON (role changes store {employee, oldRole, newRole, reason}); fall back to raw text.
function parseDetails(d) { if (!d) return null; try { return JSON.parse(d); } catch { return { raw: d }; } }

const DetailLine = ({ label, value }) => (
  <div className="flex justify-between gap-4 py-2 border-b border-gray-50 last:border-0">
    <span className="text-xs font-semibold text-gray-400 uppercase tracking-wider">{label}</span>
    <span className="text-sm text-gray-800 text-right break-all">{value || '—'}</span>
  </div>
);

function DetailsDrawer({ row, onClose }) {
  const det = parseDetails(row.details);
  const Line = DetailLine;   // module-level component (aliased for brevity)
  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/40" onClick={onClose}>
      <div className="w-full max-w-md bg-white h-full shadow-xl p-6 overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-bold text-gray-900">Audit Detail</h2>
          <button onClick={onClose} className="p-1.5 rounded-lg text-gray-400 hover:bg-gray-100"><XMarkIcon className="w-5 h-5" /></button>
        </div>
        <Line label="Performed By" value={row.actor} />
        <Line label="Role" value={roleLabel(row.actorRole)} />
        <Line label="Timestamp" value={fmtTs(row.occurredOn)} />
        <Line label="Module" value={titleCase(row.category)} />
        <Line label="Action" value={row.action} />
        <Line label="Employee / Target" value={det?.employee || row.targetId} />
        <Line label="Outcome" value={titleCase(row.outcome)} />
        {det?.oldRole && <Line label="Old Role" value={roleLabel(det.oldRole)} />}
        {det?.newRole && <Line label="New Role" value={roleLabel(det.newRole)} />}
        {det?.reason && <Line label="Reason" value={det.reason} />}
        <Line label="Method" value={row.method} />
        <Line label="Path" value={row.path} />
        <Line label="IP" value={row.ip} />
        {det?.raw && <Line label="Details" value={det.raw} />}
      </div>
    </div>
  );
}

export default function AuditLogsPage() {
  const { hasPermission } = useAuth();
  const canView = hasPermission('audit.view');
  const canExport = hasPermission('audit.export');
  const [f, setF] = useState({ from: '', to: '', actor: '', actorRole: '', category: '', action: '', targetId: '' });
  const [applied, setApplied] = useState({});
  const [detail, setDetail] = useState(null);
  const set = (k, v) => setF((s) => ({ ...s, [k]: v }));

  const { data, isLoading } = useQuery({
    queryKey: ['audit-logs', applied],
    queryFn: () => auditApi.list(applied).then((r) => r.data),
    enabled: canView,
  });
  const rows = data?.data || [];

  const cleaned = () => Object.fromEntries(Object.entries(f).filter(([, v]) => v !== '' && v != null));
  const doExport = async () => {
    try {
      const res = await auditApi.export(cleaned());
      const url = URL.createObjectURL(new Blob([res.data], { type: 'text/csv' }));
      const a = document.createElement('a'); a.href = url; a.download = `audit-log-${new Date().toISOString().slice(0, 10)}.csv`;
      document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
      toast.success('Audit log exported');
    } catch (e) { toast.error(e.response?.status === 403 ? 'Not permitted to export' : 'Export failed'); }
  };

  if (!canView) return <div className="p-8 text-center text-sm text-gray-400">You do not have permission to view Audit Logs.</div>;

  const inp = 'h-9 px-2.5 bg-gray-50 border border-gray-200 rounded-lg text-xs outline-none focus:ring-2 focus:ring-indigo-500/20';
  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 bg-gradient-to-br from-indigo-500 to-indigo-700 rounded-xl grid place-items-center shadow-lg shadow-indigo-500/20"><ClipboardDocumentListIcon className="w-5 h-5 text-white" /></div>
          <div>
            <h1 className="text-2xl font-bold text-gray-900 tracking-tight">Audit Logs</h1>
            <p className="text-sm text-gray-400">{rows.length} record{rows.length === 1 ? '' : 's'} · security-sensitive admin actions</p>
          </div>
        </div>
        {canExport && (
          <button onClick={doExport} className="inline-flex items-center gap-2 px-4 py-2 text-sm font-semibold text-gray-700 bg-white border border-gray-200 rounded-xl hover:bg-gray-50">
            <ArrowDownTrayIcon className="w-4 h-4" /> Export CSV
          </button>
        )}
      </div>

      {/* Filters */}
      <div className="bg-white rounded-xl border border-gray-100 p-3">
        <div className="flex flex-wrap items-end gap-2">
          <div><label className="block text-[10px] font-semibold text-gray-400 uppercase mb-1">From</label><input type="date" value={f.from} onChange={(e) => set('from', e.target.value)} className={inp} /></div>
          <div><label className="block text-[10px] font-semibold text-gray-400 uppercase mb-1">To</label><input type="date" value={f.to} onChange={(e) => set('to', e.target.value)} className={inp} /></div>
          <div><label className="block text-[10px] font-semibold text-gray-400 uppercase mb-1">User</label><input value={f.actor} onChange={(e) => set('actor', e.target.value)} placeholder="name/email" className={inp} /></div>
          <div><label className="block text-[10px] font-semibold text-gray-400 uppercase mb-1">Role</label><select value={f.actorRole} onChange={(e) => set('actorRole', e.target.value)} className={inp}><option value="">All</option>{ROLES.map((r) => <option key={r} value={r}>{roleLabel(r)}</option>)}</select></div>
          <div><label className="block text-[10px] font-semibold text-gray-400 uppercase mb-1">Module</label><select value={f.category} onChange={(e) => set('category', e.target.value)} className={inp}><option value="">All</option>{MODULES.map((m) => <option key={m} value={m}>{titleCase(m)}</option>)}</select></div>
          <div><label className="block text-[10px] font-semibold text-gray-400 uppercase mb-1">Action</label><input value={f.action} onChange={(e) => set('action', e.target.value)} placeholder="e.g. roles.edit" className={inp} /></div>
          <div><label className="block text-[10px] font-semibold text-gray-400 uppercase mb-1">Employee (ID)</label><input value={f.targetId} onChange={(e) => set('targetId', e.target.value)} placeholder="target id" className={inp} /></div>
          <div className="flex gap-2">
            <button onClick={() => setApplied(cleaned())} className="h-9 px-4 text-xs font-semibold text-white bg-indigo-600 rounded-lg hover:bg-indigo-700">Apply</button>
            <button onClick={() => { setF({ from: '', to: '', actor: '', actorRole: '', category: '', action: '', targetId: '' }); setApplied({}); }} className="h-9 px-3 text-xs font-semibold text-gray-500 bg-gray-100 rounded-lg hover:bg-gray-200">Clear</button>
          </div>
        </div>
      </div>

      {/* Table */}
      <div className="bg-white rounded-xl border border-gray-100 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50/80 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">
                <th className="px-4 py-3">Date</th><th className="px-4 py-3">User</th><th className="px-4 py-3">Role</th><th className="px-4 py-3">Module</th><th className="px-4 py-3">Action</th><th className="px-4 py-3">Employee/Target</th><th className="px-4 py-3">Outcome</th><th className="px-4 py-3 text-right"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100/70">
              {isLoading ? (
                <tr><td colSpan={8} className="px-4 py-10 text-center text-gray-400">Loading…</td></tr>
              ) : rows.length === 0 ? (
                <tr><td colSpan={8} className="px-4 py-10 text-center text-gray-400">No audit records match.</td></tr>
              ) : rows.map((r) => {
                const det = parseDetails(r.details);
                return (
                  <tr key={r.id} className="hover:bg-gray-50/50">
                    <td className="px-4 py-3 text-gray-500 whitespace-nowrap">{fmtTs(r.occurredOn)}</td>
                    <td className="px-4 py-3 font-medium text-gray-800">{r.actor || '—'}</td>
                    <td className="px-4 py-3 text-gray-500">{roleLabel(r.actorRole)}</td>
                    <td className="px-4 py-3 text-gray-500">{titleCase(r.category)}</td>
                    <td className="px-4 py-3 text-gray-700 font-medium">{r.action}</td>
                    <td className="px-4 py-3 text-gray-500 max-w-[12rem] truncate" title={det?.employee || r.targetId}>{det?.employee || r.targetId || '—'}</td>
                    <td className="px-4 py-3"><span className={`text-[11px] font-semibold px-2 py-0.5 rounded-full ${OUTCOME_STYLE[r.outcome] || 'bg-gray-100 text-gray-600'}`}>{titleCase(r.outcome)}</span></td>
                    <td className="px-4 py-3 text-right"><button onClick={() => setDetail(r)} className="text-xs font-semibold text-indigo-600 hover:text-indigo-800">View Details</button></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {detail && <DetailsDrawer row={detail} onClose={() => setDetail(null)} />}
    </div>
  );
}
