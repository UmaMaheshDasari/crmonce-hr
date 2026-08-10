import { useState, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { lateLoginApi, employeeApi, documentApi } from '../../api/endpoints';
import { useAuth } from '../../context/AuthContext';
import { useDocumentViewer } from '../../components/DocumentViewer';
import Button from '../../components/Button';
import { PlusIcon, XMarkIcon, CheckIcon, PaperClipIcon, ArrowDownTrayIcon } from '@heroicons/react/24/outline';
import RequestLifecycleActions from '../../components/RequestLifecycleActions';
import { format, subDays } from 'date-fns';
import toast from 'react-hot-toast';

const inp = 'w-full h-10 px-3 bg-gray-50 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-400';
const STATUS = {
  pending: 'bg-amber-50 text-amber-700 border-amber-200',
  approved: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  rejected: 'bg-red-50 text-red-700 border-red-200',
  cancelled: 'bg-gray-100 text-gray-500 border-gray-200',
};
const fmt = (d) => { try { return d ? format(new Date(d), 'dd MMM yyyy') : '—'; } catch { return d || '—'; } };
// Map a Late Login row to the shared lifecycle canonical status.
const canon = (r) => {
  if (r.status === 'cancelled') return 'cancelled';
  if (r.status === 'rejected') return 'rejected';
  if (r.status === 'approved') return 'approved';
  if (r.managerStatus === 'approved') return 'manager_approved';
  return 'pending';
};
const todayStr = new Date().toISOString().slice(0, 10);
const ATTACH_ACCEPT = '.pdf,.jpg,.jpeg,.png,.doc,.docx';

function SubmitModal({ isHR, employees, policy, onClose }) {
  const qc = useQueryClient();
  const { view, viewer } = useDocumentViewer();
  // Expected Login Time defaults to the EMPLOYEE'S SHIFT START (from policy), not a
  // fixed 09:00 (spec §4). Falls back to 09:00 only if the shift is unknown.
  const [f, setF] = useState({ employeeId: '', date: todayStr, expectedTime: (/^\d{1,2}:\d{2}$/.test(policy?.shiftStart || '') ? policy.shiftStart : '09:00'), actualTime: '', reason: '', remarks: '' });
  const [attachment, setAttachment] = useState(null);   // shaped uploaded doc
  const [uploading, setUploading] = useState(false);

  const backdatedDays = Number(policy?.backdatedDays) || 30;
  const minDate = format(subDays(new Date(), backdatedDays), 'yyyy-MM-dd');
  const maxDate = policy?.allowFuture ? undefined : todayStr;

  const uploadAttachment = async (e) => {
    const file = e.target.files?.[0]; e.target.value = '';
    if (!file) return;
    if (file.size > 10 * 1024 * 1024) { toast.error('Attachment must be 10MB or smaller.'); return; }
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append('file', file); fd.append('documentType', 'Late Login Attachment'); fd.append('name', `Late Login — ${f.date}`);
      const res = await documentApi.upload(fd);
      setAttachment(res.data);
    } catch { toast.error('Upload failed'); } finally { setUploading(false); }
  };

  const mut = useMutation({
    mutationFn: () => lateLoginApi.create({ ...f, attachmentId: attachment?.id || undefined }),
    onSuccess: (res) => {
      const warning = res?.data?.warning;
      if (warning) toast(warning, { icon: '⚠️', duration: 6000 });
      else toast.success('Late Login submitted');
      qc.invalidateQueries({ queryKey: ['late-login'] });
      onClose();
    },
    onError: (e) => toast.error(e.response?.data?.error || 'Failed to submit'),
  });
  const invalid = (isHR && !f.employeeId) || !f.date || !f.expectedTime || !f.actualTime || !f.reason.trim();

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4 overflow-y-auto">
      <div className="bg-white w-full max-w-md rounded-2xl shadow-2xl my-8">
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
          <h2 className="text-lg font-bold text-gray-900">Late Login Request</h2>
          <button onClick={onClose} className="p-2 text-gray-400 hover:bg-gray-100 rounded-lg"><XMarkIcon className="w-5 h-5" /></button>
        </div>
        <div className="p-6 space-y-4">
          {policy?.graceMinutes != null && (
            <p className="text-xs text-gray-500">Grace {policy.graceMinutes} min · Limit {policy.maxPerMonth}/month · {policy.allowFuture ? 'Future requests allowed' : 'Today & past only'} · Backdated up to {backdatedDays} days.</p>
          )}
          {isHR && (
            <div><label className="block text-xs font-semibold text-gray-600 mb-1">Employee</label>
              <select className={inp} value={f.employeeId} onChange={e => setF(p => ({ ...p, employeeId: e.target.value }))}>
                <option value="">Select employee…</option>
                {employees.map(e => <option key={e.hr_hremployeeid} value={e.hr_hremployeeid}>{e.hr_hremployee1}</option>)}
              </select></div>
          )}
          <div><label className="block text-xs font-semibold text-gray-600 mb-1">Date</label>
            <input type="date" min={minDate} max={maxDate} className={inp} value={f.date} onChange={e => setF(p => ({ ...p, date: e.target.value }))} /></div>
          <div className="grid grid-cols-2 gap-3">
            <div><label className="block text-xs font-semibold text-gray-600 mb-1">Expected Login Time</label>
              <input type="time" className={inp} value={f.expectedTime} onChange={e => setF(p => ({ ...p, expectedTime: e.target.value }))} /></div>
            <div><label className="block text-xs font-semibold text-gray-600 mb-1">Actual Login Time</label>
              <input type="time" className={inp} value={f.actualTime} onChange={e => setF(p => ({ ...p, actualTime: e.target.value }))} /></div>
          </div>
          <div><label className="block text-xs font-semibold text-gray-600 mb-1">Reason</label>
            <input className={inp} value={f.reason} onChange={e => setF(p => ({ ...p, reason: e.target.value }))} placeholder="Why were you / will you be late?" /></div>
          <div><label className="block text-xs font-semibold text-gray-600 mb-1">Remarks (optional)</label>
            <input className={inp} value={f.remarks} onChange={e => setF(p => ({ ...p, remarks: e.target.value }))} /></div>
          {/* Attachment (optional) */}
          <div>
            <label className="block text-xs font-semibold text-gray-600 mb-1">Attachment (optional)</label>
            {attachment ? (
              <div className="flex items-center gap-2 rounded-lg bg-gray-50 border border-gray-200 px-3 py-2">
                <PaperClipIcon className="w-4 h-4 text-gray-400" />
                <span className="text-sm text-gray-700 truncate flex-1">{attachment.originalName || attachment.name}</span>
                <button type="button" onClick={() => view(attachment)} className="text-xs font-semibold text-indigo-600">View</button>
                <button type="button" onClick={() => setAttachment(null)} className="text-xs font-semibold text-red-600">Remove</button>
              </div>
            ) : (
              <label className="inline-flex items-center gap-2 px-3 py-2 rounded-lg border border-dashed border-gray-300 text-sm text-gray-500 cursor-pointer hover:bg-gray-50">
                <PaperClipIcon className="w-4 h-4" /> {uploading ? 'Uploading…' : 'Attach a file'}
                <input type="file" accept={ATTACH_ACCEPT} className="hidden" onChange={uploadAttachment} disabled={uploading} />
              </label>
            )}
          </div>
        </div>
        <div className="flex justify-end gap-3 px-6 py-4 border-t border-gray-100">
          <button onClick={onClose} className="px-4 py-2 text-sm text-gray-600">Cancel</button>
          <Button onClick={() => mut.mutate()} loading={mut.isPending} disabled={invalid}>Submit</Button>
        </div>
      </div>
      {viewer}
    </div>
  );
}

export default function LateLoginPage() {
  const { user, isHR } = useAuth();
  const hr = typeof isHR === 'function' ? isHR() : ['super_admin', 'hr_manager'].includes(user?.role);
  const qc = useQueryClient();
  const [show, setShow] = useState(false);
  const [period, setPeriod] = useState('this_month');
  const [statusF, setStatusF] = useState('');
  const [deptF, setDeptF] = useState('');

  const { data: policyRes } = useQuery({ queryKey: ['late-login-policy'], queryFn: () => lateLoginApi.policy().then(r => r.data) });
  const policy = policyRes || {};
  const { data: empRes } = useQuery({ queryKey: ['employees-all'], queryFn: () => employeeApi.list({ limit: 500, status: 'active' }), enabled: hr });
  const employees = empRes?.data?.data || empRes?.data || [];
  const { data: deptRes } = useQuery({ queryKey: ['departments-list'], queryFn: () => employeeApi.departments(), enabled: hr });
  const departments = (deptRes?.data?.data || deptRes?.data || []).map(d => (typeof d === 'string' ? d : (d?.name || d?.hr_name || d?.department))).filter(Boolean);

  const monthParam = (() => {
    const now = new Date();
    if (period === 'this_month') return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    if (period === 'last_month') { const d = new Date(now.getFullYear(), now.getMonth() - 1, 1); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; }
    return undefined;
  })();
  const params = { month: monthParam, status: statusF || undefined, department: deptF || undefined };
  const { data: listRes, isLoading } = useQuery({ queryKey: ['late-login', period, statusF, deptF], queryFn: () => lateLoginApi.list(params).then(r => r.data) });
  const rows = useMemo(() => listRes?.data || [], [listRes]);

  const counts = useMemo(() => ({
    total: rows.length,
    pending: rows.filter(r => r.status === 'pending').length,
    approved: rows.filter(r => r.status === 'approved').length,
  }), [rows]);

  const decide = useMutation({
    mutationFn: ({ id, level, action }) => (level === 'hr' ? lateLoginApi.hrDecide(id, action) : lateLoginApi.managerDecide(id, action)),
    onSuccess: (_, v) => { toast.success(v.action === 'approved' ? 'Approved' : 'Rejected'); qc.invalidateQueries({ queryKey: ['late-login'] }); },
    onError: (e) => toast.error(e.response?.data?.error || 'Failed'),
  });
  const doExport = async (fmtType) => {
    try {
      const res = await lateLoginApi.export({ ...params, format: fmtType });
      const url = URL.createObjectURL(new Blob([res.data]));
      const a = document.createElement('a'); a.href = url; a.download = `late-logins.${fmtType === 'csv' ? 'csv' : 'xlsx'}`; a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch { toast.error('Export failed'); }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 tracking-tight">Late Login</h1>
          <p className="text-sm text-gray-500 mt-1">Request approval for a late login (manager → HR) — attendance stays Present, no leave/salary deducted.</p>
        </div>
        <Button icon={PlusIcon} onClick={() => setShow(true)}>{hr ? 'Raise Late Login' : 'Request Late Login'}</Button>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-3 gap-3 max-w-lg">
        {[{ label: 'Total', v: counts.total, a: 'text-gray-900' }, { label: 'Pending', v: counts.pending, a: 'text-amber-600' }, { label: 'Approved', v: counts.approved, a: 'text-emerald-600' }].map(c => (
          <div key={c.label} className="bg-white rounded-xl border border-gray-100 shadow-sm p-4">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-gray-400">{c.label}</p>
            <p className={`text-2xl font-bold mt-1 ${c.a}`}>{c.v}</p>
          </div>
        ))}
      </div>

      {/* Filters + export */}
      <div className="flex flex-wrap items-center gap-2">
        <select value={period} onChange={e => setPeriod(e.target.value)} className="h-10 px-3 bg-white border border-gray-200 rounded-lg text-sm">
          <option value="this_month">Current Month</option>
          <option value="last_month">Previous Month</option>
          <option value="all">All Time</option>
        </select>
        <select value={statusF} onChange={e => setStatusF(e.target.value)} className="h-10 px-3 bg-white border border-gray-200 rounded-lg text-sm">
          <option value="">All Status</option>
          <option value="pending">Pending</option><option value="approved">Approved</option><option value="rejected">Rejected</option><option value="cancelled">Cancelled</option>
        </select>
        {hr && (
          <select value={deptF} onChange={e => setDeptF(e.target.value)} className="h-10 px-3 bg-white border border-gray-200 rounded-lg text-sm">
            <option value="">All Departments</option>
            {departments.map(d => <option key={d} value={d}>{d}</option>)}
          </select>
        )}
        <div className="ml-auto flex gap-2">
          <button onClick={() => doExport('xlsx')} className="inline-flex items-center gap-1.5 h-10 px-3 bg-white border border-gray-200 rounded-lg text-sm font-semibold text-emerald-700 hover:bg-emerald-50"><ArrowDownTrayIcon className="w-4 h-4" /> Excel</button>
          <button onClick={() => doExport('csv')} className="inline-flex items-center gap-1.5 h-10 px-3 bg-white border border-gray-200 rounded-lg text-sm font-semibold text-gray-700 hover:bg-gray-50"><ArrowDownTrayIcon className="w-4 h-4" /> CSV</button>
        </div>
      </div>

      <div className="bg-white rounded-xl border border-gray-100 shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-gray-500">
              <tr className="text-left">
                {hr && <th className="px-4 py-3 font-semibold">Employee</th>}
                <th className="px-4 py-3 font-semibold">Date</th>
                <th className="px-4 py-3 font-semibold">Expected</th>
                <th className="px-4 py-3 font-semibold">Actual</th>
                <th className="px-4 py-3 font-semibold">Reason</th>
                <th className="px-4 py-3 font-semibold">Manager</th>
                <th className="px-4 py-3 font-semibold">Status</th>
                <th className="px-4 py-3 font-semibold text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {isLoading ? (
                <tr><td colSpan={hr ? 8 : 7} className="px-4 py-10 text-center text-gray-400">Loading…</td></tr>
              ) : rows.length === 0 ? (
                <tr><td colSpan={hr ? 8 : 7} className="px-4 py-10 text-center text-gray-400">No late login requests.</td></tr>
              ) : rows.map(r => (
                <tr key={r.id} className="hover:bg-gray-50/50">
                  {hr && <td className="px-4 py-3 font-medium text-gray-800">{r.employeeName || '—'}</td>}
                  <td className="px-4 py-3 text-gray-600">{fmt(r.date)}</td>
                  <td className="px-4 py-3 font-mono text-gray-600">{r.expectedTime || '—'}</td>
                  <td className="px-4 py-3 font-mono text-gray-600">{r.actualTime || '—'}</td>
                  <td className="px-4 py-3 text-gray-500 max-w-[14rem] truncate" title={r.reason}>{r.reason || '—'}</td>
                  <td className="px-4 py-3"><span className={`inline-flex text-[11px] font-semibold border px-2 py-0.5 rounded-full capitalize ${STATUS[r.managerStatus] || STATUS.pending}`}>{r.managerStatus}</span></td>
                  <td className="px-4 py-3"><span className={`inline-flex text-[11px] font-semibold border px-2 py-0.5 rounded-full capitalize ${STATUS[r.status] || STATUS.pending}`}>{r.status}</span></td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-1.5 justify-end">
                      {r.managerStatus === 'pending' && r.status === 'pending' && r.employeeId !== user?.id && (
                        <>
                          <button onClick={() => decide.mutate({ id: r.id, level: 'manager', action: 'approved' })} className="inline-flex items-center gap-1 px-2 py-1 text-xs font-semibold text-blue-700 bg-blue-50 rounded-lg hover:bg-blue-100"><CheckIcon className="w-3.5 h-3.5" /> Mgr Approve</button>
                          <button onClick={() => decide.mutate({ id: r.id, level: 'manager', action: 'rejected' })} className="inline-flex items-center gap-1 px-2 py-1 text-xs font-semibold text-red-700 bg-red-50 rounded-lg hover:bg-red-100"><XMarkIcon className="w-3.5 h-3.5" /> Reject</button>
                        </>
                      )}
                      {hr && r.status === 'pending' && r.managerStatus === 'approved' && (
                        <>
                          <button onClick={() => decide.mutate({ id: r.id, level: 'hr', action: 'approved' })} className="inline-flex items-center gap-1 px-2 py-1 text-xs font-semibold text-emerald-700 bg-emerald-50 rounded-lg hover:bg-emerald-100"><CheckIcon className="w-3.5 h-3.5" /> HR Approve</button>
                          <button onClick={() => decide.mutate({ id: r.id, level: 'hr', action: 'rejected' })} className="inline-flex items-center gap-1 px-2 py-1 text-xs font-semibold text-red-700 bg-red-50 rounded-lg hover:bg-red-100"><XMarkIcon className="w-3.5 h-3.5" /> Reject</button>
                        </>
                      )}
                      {r.employeeId === user?.id && (
                        <RequestLifecycleActions
                          type="late_login" id={r.id} status={canon(r)}
                          invalidateKeys={[['late-login'], ['late-login-summary']]}
                        />
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {show && <SubmitModal isHR={hr} employees={employees} policy={policy} onClose={() => setShow(false)} />}
    </div>
  );
}
