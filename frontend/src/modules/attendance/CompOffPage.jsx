import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { compOffApi, employeeApi, leaveApi } from '../../api/endpoints';
import { useAuth } from '../../context/AuthContext';
import Button from '../../components/Button';
import {
  PlusIcon, XMarkIcon, CheckIcon, ArrowPathIcon, MagnifyingGlassIcon,
  GiftIcon, ClockIcon, NoSymbolIcon, TrashIcon, PencilSquareIcon,
} from '@heroicons/react/24/outline';
import { format } from 'date-fns';
import toast from 'react-hot-toast';

const STATUS = {
  pending: 'bg-amber-50 text-amber-700 border-amber-200',
  approved: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  rejected: 'bg-red-50 text-red-700 border-red-200',
  expired: 'bg-gray-100 text-gray-500 border-gray-200',
  cancelled: 'bg-gray-100 text-gray-500 border-gray-200',
  used: 'bg-indigo-50 text-indigo-700 border-indigo-200',
};
const fmt = (d) => { try { return d ? format(new Date(d), 'dd MMM yyyy') : '—'; } catch { return d || '—'; } };
const inp = 'w-full h-10 px-3 bg-gray-50 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-400';

// Grant (HR) / Raise (employee) comp-off.
function RaiseModal({ isHR, employees, onClose }) {
  const qc = useQueryClient();
  const [f, setF] = useState({ employeeId: '', workedDate: new Date().toISOString().slice(0, 10), days: 1, workedHours: '', reason: '', holidayName: '', grant: isHR });
  const mut = useMutation({
    mutationFn: () => compOffApi.create(f),
    onSuccess: () => { toast.success(isHR ? 'Comp off saved' : 'Comp off requested'); qc.invalidateQueries({ queryKey: ['comp-off'] }); qc.invalidateQueries({ queryKey: ['leave-balance'] }); onClose(); },
    onError: (e) => toast.error(e.response?.data?.error || 'Failed'),
  });
  const invalid = (isHR && !f.employeeId) || !f.workedDate || Number(f.days) <= 0;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4 overflow-y-auto">
      <div className="bg-white w-full max-w-md rounded-2xl shadow-2xl my-8">
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
          <h2 className="text-lg font-bold text-gray-900">{isHR ? 'Grant Comp Off' : 'Raise Comp Off'}</h2>
          <button onClick={onClose} className="p-2 text-gray-400 hover:bg-gray-100 rounded-lg"><XMarkIcon className="w-5 h-5" /></button>
        </div>
        <div className="p-6 space-y-4">
          {isHR && (
            <div><label className="block text-xs font-semibold text-gray-600 mb-1">Employee</label>
              <select className={inp} value={f.employeeId} onChange={e => setF(p => ({ ...p, employeeId: e.target.value }))}>
                <option value="">Select employee…</option>
                {employees.map(e => <option key={e.hr_hremployeeid} value={e.hr_hremployeeid}>{e.hr_hremployee1}</option>)}
              </select></div>
          )}
          <div className="grid grid-cols-2 gap-3">
            <div><label className="block text-xs font-semibold text-gray-600 mb-1">Worked Date</label>
              <input type="date" className={inp} value={f.workedDate} onChange={e => setF(p => ({ ...p, workedDate: e.target.value }))} /></div>
            <div><label className="block text-xs font-semibold text-gray-600 mb-1">Comp Off Days</label>
              <input type="number" step="0.5" min="0.5" className={inp} value={f.days} onChange={e => setF(p => ({ ...p, days: e.target.value }))} /></div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div><label className="block text-xs font-semibold text-gray-600 mb-1">Worked Hours</label>
              <input type="number" step="0.5" min="0" className={inp} value={f.workedHours} onChange={e => setF(p => ({ ...p, workedHours: e.target.value }))} placeholder="optional" /></div>
            <div><label className="block text-xs font-semibold text-gray-600 mb-1">Holiday Name</label>
              <input className={inp} value={f.holidayName} onChange={e => setF(p => ({ ...p, holidayName: e.target.value }))} placeholder="optional" /></div>
          </div>
          <div><label className="block text-xs font-semibold text-gray-600 mb-1">Reason</label>
            <input className={inp} value={f.reason} onChange={e => setF(p => ({ ...p, reason: e.target.value }))} placeholder="e.g. Worked on deployment / holiday" /></div>
          {isHR && (
            <label className="flex items-center gap-2 text-sm text-gray-700">
              <input type="checkbox" checked={f.grant} onChange={e => setF(p => ({ ...p, grant: e.target.checked }))} />
              Approve immediately (credit the balance now)
            </label>
          )}
        </div>
        <div className="flex justify-end gap-3 px-6 py-4 border-t border-gray-100">
          <button onClick={onClose} className="px-4 py-2 text-sm text-gray-600">Cancel</button>
          <Button onClick={() => mut.mutate()} loading={mut.isPending} disabled={invalid}>{isHR ? 'Save' : 'Submit Request'}</Button>
        </div>
      </div>
    </div>
  );
}

// HR: scan attendance for holiday / weekly-off work → auto-raise comp-off.
function ScanModal({ onClose }) {
  const qc = useQueryClient();
  const [f, setF] = useState({ from: '', to: '' });
  const mut = useMutation({
    mutationFn: () => compOffApi.scan(f),
    onSuccess: (r) => { toast.success(`${r.data?.created || 0} comp-off request(s) raised`); qc.invalidateQueries({ queryKey: ['comp-off'] }); onClose(); },
    onError: (e) => toast.error(e.response?.data?.error || 'Scan failed'),
  });
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4">
      <div className="bg-white w-full max-w-sm rounded-2xl shadow-2xl">
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
          <h2 className="text-lg font-bold text-gray-900">Scan Attendance</h2>
          <button onClick={onClose} className="p-2 text-gray-400 hover:bg-gray-100 rounded-lg"><XMarkIcon className="w-5 h-5" /></button>
        </div>
        <div className="p-6 space-y-4">
          <p className="text-xs text-gray-500">Finds employees who worked on a holiday or weekly-off in this range and raises a pending comp-off for each.</p>
          <div className="grid grid-cols-2 gap-3">
            <div><label className="block text-xs font-semibold text-gray-600 mb-1">From</label>
              <input type="date" className={inp} value={f.from} onChange={e => setF(p => ({ ...p, from: e.target.value }))} /></div>
            <div><label className="block text-xs font-semibold text-gray-600 mb-1">To</label>
              <input type="date" className={inp} value={f.to} onChange={e => setF(p => ({ ...p, to: e.target.value }))} /></div>
          </div>
        </div>
        <div className="flex justify-end gap-3 px-6 py-4 border-t border-gray-100">
          <button onClick={onClose} className="px-4 py-2 text-sm text-gray-600">Cancel</button>
          <Button onClick={() => mut.mutate()} loading={mut.isPending} disabled={!f.from || !f.to}>Scan</Button>
        </div>
      </div>
    </div>
  );
}

export default function CompOffPage() {
  const { user, isHR } = useAuth();
  const hr = typeof isHR === 'function' ? isHR() : ['super_admin', 'hr_manager'].includes(user?.role);
  const qc = useQueryClient();
  const [selectedEmp, setSelectedEmp] = useState('');
  const [showRaise, setShowRaise] = useState(false);
  const [showScan, setShowScan] = useState(false);

  const { data: policyRes } = useQuery({ queryKey: ['comp-off-policy'], queryFn: () => compOffApi.policy().then(r => r.data) });
  const policy = policyRes || {};
  const { data: empRes } = useQuery({ queryKey: ['employees-lite'], queryFn: () => employeeApi.list({ limit: 500 }), enabled: hr });
  const employees = empRes?.data?.data || empRes?.data || [];

  const targetId = hr ? (selectedEmp || undefined) : undefined;
  const { data: listRes, isLoading } = useQuery({
    queryKey: ['comp-off', targetId || 'self'],
    queryFn: () => compOffApi.list({ ...(targetId ? { employeeId: targetId } : {}) }).then(r => r.data),
  });
  const records = listRes?.data || [];

  const { data: balRes } = useQuery({ queryKey: ['leave-balance', targetId || 'self', new Date().getFullYear()], queryFn: () => leaveApi.balance({ ...(targetId ? { employeeId: targetId } : {}) }) });
  const compOff = balRes?.data?.compOff || {};

  const approveMut = useMutation({ mutationFn: (id) => compOffApi.approve(id), onSuccess: () => { toast.success('Approved'); qc.invalidateQueries({ queryKey: ['comp-off'] }); qc.invalidateQueries({ queryKey: ['leave-balance'] }); }, onError: (e) => toast.error(e.response?.data?.error || 'Failed') });
  const rejectMut = useMutation({ mutationFn: (id) => compOffApi.reject(id), onSuccess: () => { toast.success('Rejected'); qc.invalidateQueries({ queryKey: ['comp-off'] }); }, onError: (e) => toast.error(e.response?.data?.error || 'Failed') });
  const cancelMut = useMutation({ mutationFn: (id) => compOffApi.cancel(id), onSuccess: () => { toast.success('Cancelled'); qc.invalidateQueries({ queryKey: ['comp-off'] }); qc.invalidateQueries({ queryKey: ['leave-balance'] }); }, onError: (e) => toast.error(e.response?.data?.error || 'Failed') });
  const expireMut = useMutation({ mutationFn: (id) => compOffApi.expire(id), onSuccess: () => { toast.success('Expired'); qc.invalidateQueries({ queryKey: ['comp-off'] }); qc.invalidateQueries({ queryKey: ['leave-balance'] }); }, onError: (e) => toast.error(e.response?.data?.error || 'Failed') });

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 tracking-tight">Comp Off</h1>
          <p className="text-sm text-gray-500 mt-1">Earn comp-off for holiday / weekly-off work. Comp Off is paid leave — never LOP.</p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {hr && (
            <select value={selectedEmp} onChange={e => setSelectedEmp(e.target.value)} className="h-10 px-3 bg-white border border-gray-200 rounded-lg text-sm">
              <option value="">All employees</option>
              {employees.map(e => <option key={e.hr_hremployeeid} value={e.hr_hremployeeid}>{e.hr_hremployee1}</option>)}
            </select>
          )}
          {hr && <Button variant="secondary" icon={MagnifyingGlassIcon} onClick={() => setShowScan(true)}>Scan Attendance</Button>}
          {(hr || policy.employeeRaise) && <Button icon={PlusIcon} onClick={() => setShowRaise(true)}>{hr ? 'Grant Comp Off' : 'Raise Comp Off'}</Button>}
        </div>
      </div>

      {/* Balance summary */}
      <div className="grid grid-cols-3 gap-3 max-w-lg">
        {[
          { label: 'Available', val: compOff.balance, accent: 'text-emerald-700', icon: GiftIcon },
          { label: 'Earned', val: compOff.earned, accent: 'text-gray-900', icon: CheckIcon },
          { label: 'Used', val: compOff.used, accent: 'text-indigo-700', icon: ClockIcon },
        ].map(c => (
          <div key={c.label} className="bg-white rounded-xl border border-gray-100 shadow-sm p-4">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-gray-400">{c.label}</p>
            <p className={`text-2xl font-bold mt-1 ${c.accent}`}>{Number(c.val || 0)}</p>
          </div>
        ))}
      </div>

      {/* Records */}
      <div className="bg-white rounded-xl border border-gray-100 shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-gray-500">
              <tr className="text-left">
                {hr && <th className="px-4 py-3 font-semibold">Employee</th>}
                <th className="px-4 py-3 font-semibold">Type</th>
                <th className="px-4 py-3 font-semibold">Worked Date</th>
                <th className="px-4 py-3 font-semibold">Days</th>
                <th className="px-4 py-3 font-semibold">Reason / Holiday</th>
                <th className="px-4 py-3 font-semibold">Expiry</th>
                <th className="px-4 py-3 font-semibold">Status</th>
                <th className="px-4 py-3 font-semibold text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {isLoading ? (
                <tr><td colSpan={hr ? 8 : 7} className="px-4 py-10 text-center text-gray-400">Loading…</td></tr>
              ) : records.length === 0 ? (
                <tr><td colSpan={hr ? 8 : 7} className="px-4 py-10 text-center text-gray-400">No comp-off records yet.</td></tr>
              ) : records.map(r => (
                <tr key={r.id} className="hover:bg-gray-50/50">
                  {hr && <td className="px-4 py-3 font-medium text-gray-800">{r.employeeName || '—'}</td>}
                  <td className="px-4 py-3 capitalize text-gray-600">{r.type}</td>
                  <td className="px-4 py-3 text-gray-600">{fmt(r.workedDate)}</td>
                  <td className="px-4 py-3 font-semibold text-gray-800">{r.days}</td>
                  <td className="px-4 py-3 text-gray-500 max-w-[16rem] truncate">{r.holidayName || r.reason || '—'}</td>
                  <td className="px-4 py-3 text-gray-500">{fmt(r.expiryDate)}</td>
                  <td className="px-4 py-3"><span className={`inline-flex items-center text-[11px] font-semibold border px-2 py-0.5 rounded-full capitalize ${STATUS[r.status] || STATUS.pending}`}>{r.status}</span></td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-1.5 justify-end">
                      {hr && r.status === 'pending' && (
                        <>
                          <button onClick={() => approveMut.mutate(r.id)} className="inline-flex items-center gap-1 px-2 py-1 text-xs font-semibold text-emerald-700 bg-emerald-50 rounded-lg hover:bg-emerald-100"><CheckIcon className="w-3.5 h-3.5" /> Approve</button>
                          <button onClick={() => rejectMut.mutate(r.id)} className="inline-flex items-center gap-1 px-2 py-1 text-xs font-semibold text-red-700 bg-red-50 rounded-lg hover:bg-red-100"><XMarkIcon className="w-3.5 h-3.5" /> Reject</button>
                        </>
                      )}
                      {hr && r.status === 'approved' && (
                        <>
                          <button onClick={() => cancelMut.mutate(r.id)} className="inline-flex items-center gap-1 px-2 py-1 text-xs font-semibold text-gray-700 bg-gray-100 rounded-lg hover:bg-gray-200"><NoSymbolIcon className="w-3.5 h-3.5" /> Cancel</button>
                          <button onClick={() => expireMut.mutate(r.id)} className="inline-flex items-center gap-1 px-2 py-1 text-xs font-semibold text-amber-700 bg-amber-50 rounded-lg hover:bg-amber-100"><ClockIcon className="w-3.5 h-3.5" /> Expire</button>
                        </>
                      )}
                      {!hr && r.status === 'pending' && <span className="text-xs text-gray-400">Awaiting HR</span>}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {showRaise && <RaiseModal isHR={hr} employees={employees} onClose={() => setShowRaise(false)} />}
      {showScan && <ScanModal onClose={() => setShowScan(false)} />}
    </div>
  );
}
