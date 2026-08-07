import { useState, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { historicalAttendanceApi, employeeApi, documentApi } from '../../api/endpoints';
import { useAuth } from '../../context/AuthContext';
import { useDocumentViewer } from '../../components/DocumentViewer';
import Button from '../../components/Button';
import { PlusIcon, XMarkIcon, CheckIcon, PaperClipIcon, ClockIcon, InformationCircleIcon } from '@heroicons/react/24/outline';
import { format, subMonths } from 'date-fns';
import toast from 'react-hot-toast';

const inp = 'w-full h-10 px-3 bg-gray-50 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-400';
const STATUS = {
  pending: 'bg-amber-50 text-amber-700 border-amber-200',
  approved: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  rejected: 'bg-red-50 text-red-700 border-red-200',
  more_info: 'bg-blue-50 text-blue-700 border-blue-200',
};
const STATUS_LABEL = { pending: 'Pending', approved: 'Approved', rejected: 'Rejected', more_info: 'More Info' };
const fmt = (d) => { try { return d ? format(new Date(d), 'dd MMM yyyy') : '—'; } catch { return d || '—'; } };
const fmtT = (d) => { try { return d ? format(new Date(d), 'dd MMM yyyy, HH:mm') : '—'; } catch { return '—'; } };
const todayStr = new Date().toISOString().slice(0, 10);

function RaiseModal({ isHR, employees, monthsBack, onClose }) {
  const qc = useQueryClient();
  const { view, viewer } = useDocumentViewer();
  const [f, setF] = useState({ employeeId: '', date: todayStr, inTime: '09:00', outTime: '18:00', reason: '', comments: '' });
  const [attachment, setAttachment] = useState(null);
  const [uploading, setUploading] = useState(false);
  const minDate = format(subMonths(new Date(), monthsBack || 6), 'yyyy-MM-dd');

  const upload = async (e) => {
    const file = e.target.files?.[0]; e.target.value = '';
    if (!file) return;
    if (file.size > 10 * 1024 * 1024) { toast.error('Attachment must be 10MB or smaller.'); return; }
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append('file', file); fd.append('documentType', 'Historical Attendance'); fd.append('name', `Historical Attendance — ${f.date}`);
      const res = await documentApi.upload(fd);
      setAttachment(res.data);
    } catch { toast.error('Upload failed'); } finally { setUploading(false); }
  };

  const mut = useMutation({
    mutationFn: () => historicalAttendanceApi.create({ ...f, attachmentId: attachment?.id || undefined }),
    onSuccess: () => { toast.success('Historical Attendance request submitted'); qc.invalidateQueries({ queryKey: ['hist-attendance'] }); onClose(); },
    onError: (e) => toast.error(e.response?.data?.error || 'Failed to submit'),
  });
  const invalid = (isHR && !f.employeeId) || !f.date || !f.reason.trim();

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4 overflow-y-auto">
      <div className="bg-white w-full max-w-md rounded-2xl shadow-2xl my-8">
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
          <h2 className="text-lg font-bold text-gray-900">Raise Historical Attendance</h2>
          <button onClick={onClose} className="p-2 text-gray-400 hover:bg-gray-100 rounded-lg"><XMarkIcon className="w-5 h-5" /></button>
        </div>
        <div className="p-6 space-y-4">
          <p className="text-xs text-gray-500">Record attendance for a past date you were marked Absent — within the last {monthsBack || 6} months. HR approval replaces the day's record (no duplicate row).</p>
          {isHR && (
            <div><label className="block text-xs font-semibold text-gray-600 mb-1">Employee</label>
              <select className={inp} value={f.employeeId} onChange={e => setF(p => ({ ...p, employeeId: e.target.value }))}>
                <option value="">Select employee…</option>
                {employees.map(e => <option key={e.hr_hremployeeid} value={e.hr_hremployeeid}>{e.hr_hremployee1}</option>)}
              </select></div>
          )}
          <div><label className="block text-xs font-semibold text-gray-600 mb-1">Date</label>
            <input type="date" min={minDate} max={todayStr} className={inp} value={f.date} onChange={e => setF(p => ({ ...p, date: e.target.value }))} /></div>
          <div className="grid grid-cols-2 gap-3">
            <div><label className="block text-xs font-semibold text-gray-600 mb-1">In Time</label>
              <input type="time" className={inp} value={f.inTime} onChange={e => setF(p => ({ ...p, inTime: e.target.value }))} /></div>
            <div><label className="block text-xs font-semibold text-gray-600 mb-1">Out Time</label>
              <input type="time" className={inp} value={f.outTime} onChange={e => setF(p => ({ ...p, outTime: e.target.value }))} /></div>
          </div>
          <div><label className="block text-xs font-semibold text-gray-600 mb-1">Reason</label>
            <input className={inp} value={f.reason} onChange={e => setF(p => ({ ...p, reason: e.target.value }))} placeholder="Why was attendance missed / not recorded?" /></div>
          <div><label className="block text-xs font-semibold text-gray-600 mb-1">Comments (optional)</label>
            <input className={inp} value={f.comments} onChange={e => setF(p => ({ ...p, comments: e.target.value }))} /></div>
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
                <input type="file" accept=".pdf,.jpg,.jpeg,.png,.doc,.docx" className="hidden" onChange={upload} disabled={uploading} />
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

export default function HistoricalAttendanceRequestsPage() {
  const { user, isHR } = useAuth();
  const hr = typeof isHR === 'function' ? isHR() : ['super_admin', 'hr_manager'].includes(user?.role);
  const qc = useQueryClient();
  const [show, setShow] = useState(false);
  const [statusF, setStatusF] = useState('');

  const { data: policyRes } = useQuery({ queryKey: ['hist-attendance-policy'], queryFn: () => historicalAttendanceApi.policy().then(r => r.data) });
  const monthsBack = policyRes?.monthsBack || 6;
  const { data: empRes } = useQuery({ queryKey: ['employees-all'], queryFn: () => employeeApi.list({ limit: 500, status: 'active' }), enabled: hr });
  const employees = empRes?.data?.data || empRes?.data || [];

  const { data: listRes, isLoading } = useQuery({ queryKey: ['hist-attendance', statusF], queryFn: () => historicalAttendanceApi.list({ status: statusF || undefined }).then(r => r.data) });
  const rows = useMemo(() => listRes?.data || [], [listRes]);
  const counts = useMemo(() => ({
    total: rows.length,
    pending: rows.filter(r => r.status === 'pending').length,
    approved: rows.filter(r => r.status === 'approved').length,
  }), [rows]);

  const decide = useMutation({
    mutationFn: ({ id, action, comment }) => (action === 'approved' ? historicalAttendanceApi.approve(id, comment) : action === 'rejected' ? historicalAttendanceApi.reject(id, comment) : historicalAttendanceApi.moreInfo(id, comment)),
    onSuccess: (res, v) => {
      const warning = res?.data?.warning;
      toast.success(v.action === 'approved' ? 'Approved — attendance updated' : v.action === 'rejected' ? 'Rejected' : 'Requested more information');
      if (warning) toast(warning, { icon: '⚠️', duration: 7000 });
      qc.invalidateQueries({ queryKey: ['hist-attendance'] });
    },
    onError: (e) => toast.error(e.response?.data?.error || 'Failed'),
  });
  const act = (id, action) => {
    const comment = action !== 'approved' ? (window.prompt(action === 'rejected' ? 'Reason for rejection (optional):' : 'What information is needed?') ?? '') : '';
    if (action === 'more_info' && comment === null) return;
    decide.mutate({ id, action, comment });
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 tracking-tight">Historical Attendance</h1>
          <p className="text-sm text-gray-500 mt-1">Raise a request to record attendance for a past Absent date. On HR approval the day's single record is replaced — no duplicate rows.</p>
        </div>
        <Button icon={PlusIcon} onClick={() => setShow(true)}>Raise Historical Attendance</Button>
      </div>

      <div className="grid grid-cols-3 gap-3 max-w-lg">
        {[{ label: 'Total', v: counts.total, a: 'text-gray-900' }, { label: 'Pending', v: counts.pending, a: 'text-amber-600' }, { label: 'Approved', v: counts.approved, a: 'text-emerald-600' }].map(c => (
          <div key={c.label} className="bg-white rounded-xl border border-gray-100 shadow-sm p-4">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-gray-400">{c.label}</p>
            <p className={`text-2xl font-bold mt-1 ${c.a}`}>{c.v}</p>
          </div>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <select value={statusF} onChange={e => setStatusF(e.target.value)} className="h-10 px-3 bg-white border border-gray-200 rounded-lg text-sm">
          <option value="">All Status</option>
          <option value="pending">Pending</option><option value="approved">Approved</option><option value="rejected">Rejected</option><option value="more_info">More Info</option>
        </select>
      </div>

      <div className="bg-white rounded-xl border border-gray-100 shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-gray-500">
              <tr className="text-left">
                {hr && <th className="px-4 py-3 font-semibold">Employee</th>}
                <th className="px-4 py-3 font-semibold">Date</th>
                <th className="px-4 py-3 font-semibold">In / Out</th>
                <th className="px-4 py-3 font-semibold">Reason</th>
                <th className="px-4 py-3 font-semibold">Requested</th>
                <th className="px-4 py-3 font-semibold">Approved By / On</th>
                <th className="px-4 py-3 font-semibold">Status</th>
                <th className="px-4 py-3 font-semibold text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {isLoading ? (
                <tr><td colSpan={hr ? 8 : 7} className="px-4 py-10 text-center text-gray-400">Loading…</td></tr>
              ) : rows.length === 0 ? (
                <tr><td colSpan={hr ? 8 : 7} className="px-4 py-10 text-center text-gray-400">No historical attendance requests.</td></tr>
              ) : rows.map(r => (
                <tr key={r.id} className="hover:bg-gray-50/50">
                  {hr && <td className="px-4 py-3 font-medium text-gray-800">{r.employeeName || '—'}</td>}
                  <td className="px-4 py-3 text-gray-600">{fmt(r.date)}</td>
                  <td className="px-4 py-3 font-mono text-gray-600">{r.inTime || '—'} / {r.outTime || '—'}</td>
                  <td className="px-4 py-3 text-gray-500 max-w-[14rem] truncate" title={r.reason}>{r.reason || '—'}
                    {r.status === 'approved' && r.oldStatus && <span className="block text-[11px] text-emerald-600">{r.oldStatus} → {r.newStatus}</span>}
                  </td>
                  <td className="px-4 py-3 text-gray-400">{fmt(r.createdOn)}</td>
                  <td className="px-4 py-3 text-gray-400">{r.approvedBy ? <>{r.approvedBy}<span className="block text-[11px]">{fmtT(r.approvedDate)}</span></> : '—'}</td>
                  <td className="px-4 py-3"><span className={`inline-flex text-[11px] font-semibold border px-2 py-0.5 rounded-full ${STATUS[r.status] || STATUS.pending}`}>{STATUS_LABEL[r.status] || r.status}</span></td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-1.5 justify-end flex-wrap">
                      {hr && r.status === 'pending' && (
                        <>
                          <button onClick={() => act(r.id, 'approved')} className="inline-flex items-center gap-1 px-2 py-1 text-xs font-semibold text-emerald-700 bg-emerald-50 rounded-lg hover:bg-emerald-100"><CheckIcon className="w-3.5 h-3.5" /> Approve</button>
                          <button onClick={() => act(r.id, 'rejected')} className="inline-flex items-center gap-1 px-2 py-1 text-xs font-semibold text-red-700 bg-red-50 rounded-lg hover:bg-red-100"><XMarkIcon className="w-3.5 h-3.5" /> Reject</button>
                          <button onClick={() => act(r.id, 'more_info')} className="inline-flex items-center gap-1 px-2 py-1 text-xs font-semibold text-blue-700 bg-blue-50 rounded-lg hover:bg-blue-100"><InformationCircleIcon className="w-3.5 h-3.5" /> More Info</button>
                        </>
                      )}
                      {r.approverComment && <span title={r.approverComment} className="inline-flex items-center text-gray-400"><ClockIcon className="w-3.5 h-3.5" /></span>}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {show && <RaiseModal isHR={hr} employees={employees} monthsBack={monthsBack} onClose={() => setShow(false)} />}
    </div>
  );
}
