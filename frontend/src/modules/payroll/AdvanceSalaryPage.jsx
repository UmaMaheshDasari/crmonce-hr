import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { advanceApi, employeeApi } from '../../api/endpoints';
import {
  BanknotesIcon, PlusIcon, XMarkIcon, CheckIcon, ClockIcon, TrashIcon, ChevronDownIcon,
} from '@heroicons/react/24/outline';
import { useAuth } from '../../context/AuthContext';
import { fmtDate } from '../../utils/format';
import toast from 'react-hot-toast';

const inr = (n) => '₹' + (Number(n) || 0).toLocaleString('en-IN');
const STATUS = {
  pending: 'bg-amber-50 text-amber-700 ring-amber-600/20',
  approved: 'bg-blue-50 text-blue-700 ring-blue-600/20',
  completed: 'bg-emerald-50 text-emerald-700 ring-emerald-600/20',
  rejected: 'bg-red-50 text-red-700 ring-red-600/20',
  cancelled: 'bg-gray-100 text-gray-500 ring-gray-500/10',
};
const inputCls = 'w-full h-10 px-3 bg-gray-50 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-400';

function Modal({ title, subtitle, onClose, children }) {
  return (
    <div className="fixed inset-0 z-50 flex items-start sm:items-center justify-center bg-black/40 backdrop-blur-sm p-0 sm:p-4 overflow-y-auto">
      <div className="bg-white w-full sm:max-w-md sm:rounded-2xl shadow-2xl my-0 sm:my-8">
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
          <div><h2 className="text-lg font-bold text-gray-900">{title}</h2>{subtitle && <p className="text-xs text-gray-400">{subtitle}</p>}</div>
          <button onClick={onClose} className="p-2 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded-lg"><XMarkIcon className="w-5 h-5" /></button>
        </div>
        {children}
      </div>
    </div>
  );
}

function ApplyModal({ isHR, employees, onClose }) {
  const qc = useQueryClient();
  const { register, handleSubmit } = useForm({ defaultValues: { requestedDate: new Date().toISOString().slice(0, 10) } });
  const mut = useMutation({
    mutationFn: (v) => advanceApi.apply({ ...v, amount: Number(v.amount), emi: v.emi ? Number(v.emi) : 0 }),
    onSuccess: () => { toast.success('Advance request submitted'); qc.invalidateQueries({ queryKey: ['advances'] }); qc.invalidateQueries({ queryKey: ['advance-balance'] }); onClose(); },
    onError: (e) => toast.error(e.response?.data?.error || 'Failed to submit request'),
  });
  return (
    <Modal title="Apply for Advance Salary" subtitle="Your request goes to HR for approval." onClose={onClose}>
      <form onSubmit={handleSubmit(v => mut.mutate(v))} className="p-6 space-y-4">
        {isHR && (
          <div className="space-y-1"><label className="block text-xs font-semibold text-gray-600">Employee (optional — defaults to you)</label>
            <select className={inputCls} {...register('employeeId')}>
              <option value="">Myself</option>
              {employees.map(e => <option key={e.hr_hremployeeid} value={e.hr_hremployeeid}>{e.hr_hremployee1}</option>)}
            </select></div>
        )}
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1"><label className="block text-xs font-semibold text-gray-600">Amount<span className="text-red-500">*</span></label>
            <input type="number" min="1" className={inputCls} placeholder="e.g. 25000" {...register('amount', { required: true })} /></div>
          <div className="space-y-1"><label className="block text-xs font-semibold text-gray-600">Requested Date</label>
            <input type="date" className={inputCls} {...register('requestedDate')} /></div>
        </div>
        <div className="space-y-1"><label className="block text-xs font-semibold text-gray-600">Preferred Monthly EMI (optional)</label>
          <input type="number" min="0" className={inputCls} placeholder="Blank = recover in one payroll; HR can change" {...register('emi')} /></div>
        <div className="space-y-1"><label className="block text-xs font-semibold text-gray-600">Reason<span className="text-red-500">*</span></label>
          <textarea rows={3} className="w-full px-3 py-2 bg-gray-50 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-400 resize-none" placeholder="Why do you need this advance?" {...register('reason', { required: true })} /></div>
        <div className="flex justify-end gap-3 pt-2">
          <button type="button" onClick={onClose} className="px-4 py-2 text-sm text-gray-600">Cancel</button>
          <button type="submit" disabled={mut.isPending} className="px-5 py-2.5 bg-indigo-600 text-white text-sm font-medium rounded-xl hover:bg-indigo-700 disabled:opacity-50">{mut.isPending ? 'Submitting…' : 'Submit Request'}</button>
        </div>
      </form>
    </Modal>
  );
}

function ApproveModal({ record, onClose }) {
  const qc = useQueryClient();
  const nextMonth = (() => { const d = new Date(); const y = d.getMonth() === 11 ? d.getFullYear() + 1 : d.getFullYear(); const m = d.getMonth() === 11 ? 1 : d.getMonth() + 2; return `${y}-${String(m).padStart(2, '0')}`; })();
  const { register, handleSubmit, watch } = useForm({ defaultValues: { emi: record.emi || '', recoverFrom: nextMonth, remarks: '' } });
  const emi = Number(watch('emi')) || 0;
  const months = emi > 0 ? Math.ceil(record.amount / emi) : 1;
  const mut = useMutation({
    mutationFn: (v) => advanceApi.approve(record.id, { ...v, emi: Number(v.emi) || 0 }),
    onSuccess: () => { toast.success('Advance approved'); qc.invalidateQueries({ queryKey: ['advances'] }); qc.invalidateQueries({ queryKey: ['advance-balance'] }); onClose(); },
    onError: (e) => toast.error(e.response?.data?.error || 'Failed to approve'),
  });
  return (
    <Modal title="Approve Advance" subtitle={`${record.employeeName} · ${inr(record.amount)}`} onClose={onClose}>
      <form onSubmit={handleSubmit(v => mut.mutate(v))} className="p-6 space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1"><label className="block text-xs font-semibold text-gray-600">Monthly EMI</label>
            <input type="number" min="0" className={inputCls} placeholder="0 = one payroll" {...register('emi')} /></div>
          <div className="space-y-1"><label className="block text-xs font-semibold text-gray-600">Recover From</label>
            <input type="month" className={inputCls} {...register('recoverFrom')} /></div>
        </div>
        <p className="text-xs text-gray-500 bg-gray-50 rounded-lg px-3 py-2">
          {emi > 0 ? <>Recovered over <strong>{months}</strong> month{months > 1 ? 's' : ''} at {inr(emi)}/month.</> : <>Recovered fully in the first payroll ({inr(record.amount)}).</>}
        </p>
        <div className="space-y-1"><label className="block text-xs font-semibold text-gray-600">Remarks (optional)</label>
          <input className={inputCls} {...register('remarks')} /></div>
        <div className="flex justify-end gap-3 pt-2">
          <button type="button" onClick={onClose} className="px-4 py-2 text-sm text-gray-600">Cancel</button>
          <button type="submit" disabled={mut.isPending} className="px-5 py-2.5 bg-emerald-600 text-white text-sm font-medium rounded-xl hover:bg-emerald-700 disabled:opacity-50">{mut.isPending ? 'Approving…' : 'Approve'}</button>
        </div>
      </form>
    </Modal>
  );
}

function RejectModal({ record, onClose }) {
  const qc = useQueryClient();
  const { register, handleSubmit } = useForm();
  const mut = useMutation({
    mutationFn: (v) => advanceApi.reject(record.id, v),
    onSuccess: () => { toast.success('Advance rejected'); qc.invalidateQueries({ queryKey: ['advances'] }); onClose(); },
    onError: (e) => toast.error(e.response?.data?.error || 'Failed to reject'),
  });
  return (
    <Modal title="Reject Advance" subtitle={`${record.employeeName} · ${inr(record.amount)}`} onClose={onClose}>
      <form onSubmit={handleSubmit(v => mut.mutate(v))} className="p-6 space-y-4">
        <div className="space-y-1"><label className="block text-xs font-semibold text-gray-600">Reason for rejection</label>
          <textarea rows={3} className="w-full px-3 py-2 bg-gray-50 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-400 resize-none" {...register('remarks')} /></div>
        <div className="flex justify-end gap-3 pt-2">
          <button type="button" onClick={onClose} className="px-4 py-2 text-sm text-gray-600">Cancel</button>
          <button type="submit" disabled={mut.isPending} className="px-5 py-2.5 bg-red-600 text-white text-sm font-medium rounded-xl hover:bg-red-700 disabled:opacity-50">{mut.isPending ? 'Rejecting…' : 'Reject'}</button>
        </div>
      </form>
    </Modal>
  );
}

function AdvanceCard({ record, isHR, onApprove, onReject, onDelete }) {
  const [open, setOpen] = useState(false);
  const e = record._employee || {};
  return (
    <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <p className="font-semibold text-gray-900 truncate">{e.name || record.employeeName || 'Employee'}</p>
            <span className={`px-2 py-0.5 rounded-full text-[10px] font-semibold uppercase ring-1 ${STATUS[record.status] || STATUS.pending}`}>{record.status}</span>
          </div>
          <p className="text-xs text-gray-400 mt-0.5">
            {e.employeeId && <span className="font-medium text-gray-500">{e.employeeId} · </span>}
            Requested {fmtDate(record.requestedDate)}
          </p>
        </div>
        <p className="text-xl font-bold text-gray-900 shrink-0">{inr(record.amount)}</p>
      </div>

      {record.reason && <p className="text-sm text-gray-500 mt-2 line-clamp-2">{record.reason}</p>}

      {(record.status === 'approved' || record.status === 'completed') && (
        <div className="mt-3">
          <div className="flex items-center justify-between text-xs mb-1">
            <span className="text-gray-500">Recovered {inr(record.recovered)} of {inr(record.amount)}</span>
            <span className="font-semibold text-gray-700">{record.percent}%</span>
          </div>
          <div className="h-2 bg-gray-100 rounded-full overflow-hidden"><div className="h-full bg-emerald-500 rounded-full" style={{ width: `${Math.min(100, record.percent)}%` }} /></div>
          <div className="flex items-center justify-between text-xs mt-1.5 text-gray-400">
            <span>EMI {record.emi > 0 ? inr(record.emi) + '/mo' : 'one payroll'}{record.recoverFrom ? ` · from ${record.recoverFrom}` : ''}</span>
            <span className="font-medium text-gray-600">Remaining {inr(record.remaining)}</span>
          </div>
          {record.schedule?.length > 0 && (
            <button onClick={() => setOpen(o => !o)} className="mt-2 inline-flex items-center gap-1 text-xs font-medium text-indigo-600">
              <ChevronDownIcon className={`w-4 h-4 transition-transform ${open ? 'rotate-180' : ''}`} /> Recovery history ({record.schedule.length})
            </button>
          )}
          {open && (
            <div className="mt-2 space-y-1">
              {record.schedule.map((s, i) => (
                <div key={i} className="flex items-center justify-between text-xs bg-gray-50 rounded px-3 py-1.5"><span className="text-gray-500">{s.period}</span><span className="font-medium text-gray-700">{inr(s.amount)}</span></div>
              ))}
            </div>
          )}
        </div>
      )}

      {record.status === 'rejected' && record.remarks && <p className="text-xs text-red-500 mt-2">Rejected: {record.remarks}</p>}

      {(isHR && record.status === 'pending') && (
        <div className="flex gap-2 mt-4 pt-3 border-t border-gray-50">
          <button onClick={() => onApprove(record)} className="flex-1 py-2 text-xs font-semibold text-emerald-700 bg-emerald-50 hover:bg-emerald-100 rounded-lg flex items-center justify-center gap-1.5"><CheckIcon className="w-4 h-4" /> Approve</button>
          <button onClick={() => onReject(record)} className="flex-1 py-2 text-xs font-semibold text-red-700 bg-red-50 hover:bg-red-100 rounded-lg flex items-center justify-center gap-1.5"><XMarkIcon className="w-4 h-4" /> Reject</button>
        </div>
      )}
      {record.status === 'pending' && !isHR && onDelete && (
        <button onClick={() => onDelete(record)} className="mt-3 text-xs text-gray-400 hover:text-red-500 inline-flex items-center gap-1"><TrashIcon className="w-3.5 h-3.5" /> Cancel request</button>
      )}
    </div>
  );
}

export default function AdvanceSalaryPage() {
  const { user, isHR } = useAuth();
  const qc = useQueryClient();
  const hr = typeof isHR === 'function' ? isHR() : ['super_admin', 'hr_manager'].includes(user?.role);

  const [showApply, setShowApply] = useState(false);
  const [approveRec, setApproveRec] = useState(null);
  const [rejectRec, setRejectRec] = useState(null);
  const [tab, setTab] = useState(hr ? 'pending' : 'mine');

  const { data: empRes } = useQuery({ queryKey: ['employees-lite'], queryFn: () => employeeApi.list({ limit: 500 }), enabled: hr });
  const employees = empRes?.data?.data || empRes?.data || [];

  const { data: balRes } = useQuery({ queryKey: ['advance-balance'], queryFn: () => advanceApi.balance() });
  const bal = balRes?.data || { totalAdvance: 0, recovered: 0, remaining: 0 };

  const { data: listRes, isLoading } = useQuery({ queryKey: ['advances', tab], queryFn: () => tab === 'pending' ? advanceApi.pending() : advanceApi.list() });
  const rows = listRes?.data?.data || [];

  const delMut = useMutation({
    mutationFn: (id) => advanceApi.delete(id),
    onSuccess: () => { toast.success('Request cancelled'); qc.invalidateQueries({ queryKey: ['advances'] }); },
    onError: (e) => toast.error(e.response?.data?.error || 'Failed to cancel'),
  });
  const handleDelete = (r) => { if (window.confirm('Cancel this advance request?')) delMut.mutate(r.id); };

  const tabs = hr ? [['pending', 'Pending Approval'], ['all', 'All Advances']] : [['mine', 'My Advances']];

  return (
    <div className="space-y-5">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 bg-gradient-to-br from-indigo-500 to-indigo-700 rounded-xl flex items-center justify-center shadow-lg shadow-indigo-500/20"><BanknotesIcon className="w-5 h-5 text-white" /></div>
          <div>
            <h1 className="text-2xl font-bold text-gray-900 tracking-tight">Advance Salary</h1>
            <p className="text-sm text-gray-400">Request an advance; approved advances are auto-recovered from payroll as EMIs.</p>
          </div>
        </div>
        <button onClick={() => setShowApply(true)} className="inline-flex items-center gap-2 px-4 py-2.5 bg-gradient-to-r from-indigo-600 to-indigo-700 text-white text-sm font-medium rounded-xl hover:from-indigo-700 hover:to-indigo-800 shadow-lg shadow-indigo-500/25 self-start"><PlusIcon className="w-4.5 h-4.5" /> Apply Advance</button>
      </div>

      {/* Balance summary (self) */}
      <div className="grid grid-cols-3 gap-3">
        {[['Total Advance', bal.totalAdvance, 'text-gray-900'], ['Recovered', bal.recovered, 'text-emerald-600'], ['Remaining Balance', bal.remaining, 'text-amber-600']].map(([label, val, color]) => (
          <div key={label} className="bg-white rounded-xl border border-gray-100 shadow-sm p-4">
            <p className="text-[11px] uppercase tracking-wide text-gray-400">{label}</p>
            <p className={`text-xl font-bold ${color}`}>{inr(val)}</p>
          </div>
        ))}
      </div>

      {/* Tabs */}
      <div className="inline-flex bg-gray-100/80 p-1 rounded-xl gap-0.5">
        {tabs.map(([k, l]) => (
          <button key={k} onClick={() => setTab(k)} className={`px-5 py-2 rounded-lg text-sm font-semibold transition-all ${tab === k ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'}`}>{l}</button>
        ))}
      </div>

      {isLoading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">{[...Array(3)].map((_, i) => <div key={i} className="h-40 bg-white rounded-2xl border border-gray-100 animate-pulse" />)}</div>
      ) : rows.length === 0 ? (
        <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-16 text-center">
          <div className="w-16 h-16 bg-gray-100 rounded-2xl flex items-center justify-center mx-auto mb-4"><ClockIcon className="w-8 h-8 text-gray-300" /></div>
          <h3 className="text-lg font-semibold text-gray-700 mb-1">{tab === 'pending' ? 'No pending requests' : 'No advance requests'}</h3>
          <p className="text-sm text-gray-400">{hr ? 'Advance requests will appear here for approval.' : 'Click "Apply Advance" to request one.'}</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 items-start">
          {rows.map(r => <AdvanceCard key={r.id} record={r} isHR={hr} onApprove={setApproveRec} onReject={setRejectRec} onDelete={handleDelete} />)}
        </div>
      )}

      {showApply && <ApplyModal isHR={hr} employees={employees} onClose={() => setShowApply(false)} />}
      {approveRec && <ApproveModal record={approveRec} onClose={() => setApproveRec(null)} />}
      {rejectRec && <RejectModal record={rejectRec} onClose={() => setRejectRec(null)} />}
    </div>
  );
}
