import { useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { leaveApi, employeeApi } from '../../api/endpoints';
import { XMarkIcon, AdjustmentsHorizontalIcon, GiftIcon } from '@heroicons/react/24/outline';
import { useAuth } from '../../context/AuthContext';
import toast from 'react-hot-toast';

const d = (n) => `${Number(n || 0)}`;
// Light date formatter (no extra dependency) → 'DD MMM YYYY'.
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const fmtDate = (s) => { const p = String(s || '').slice(0, 10).split('-'); return p.length === 3 ? `${p[2]} ${MON[+p[1] - 1] || p[1]} ${p[0]}` : ''; };

// One balance stat card with an optional usage bar + optional note line.
function BalanceCard({ label, value, sub, note, accent, pct }) {
  return (
    <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-4">
      <div className="flex items-center justify-between">
        <p className="text-[11px] font-semibold uppercase tracking-wider text-gray-400">{label}</p>
        <span className={`w-2.5 h-2.5 rounded-full ${accent}`} />
      </div>
      <p className="text-2xl font-bold text-gray-900 mt-1">{value}</p>
      {sub && <p className="text-xs text-gray-400 mt-0.5">{sub}</p>}
      {note && <p className="text-[11px] font-medium text-amber-600 mt-0.5">{note}</p>}
      {typeof pct === 'number' && (
        <div className="mt-2 h-1.5 bg-gray-100 rounded-full overflow-hidden">
          <div className={`h-full rounded-full ${accent}`} style={{ width: `${Math.min(100, Math.max(0, pct))}%` }} />
        </div>
      )}
    </div>
  );
}

// HR modal: manual adjustment + comp-off grant/use.
function ManageModal({ employeeId, employeeName, onClose }) {
  const qc = useQueryClient();
  const [tab, setTab] = useState('adjust');
  const adjustForm = useForm({ defaultValues: { category: 'casual', days: '', reason: '' } });
  const compForm = useForm({ defaultValues: { action: 'earn', days: '', date: new Date().toISOString().slice(0, 10), reason: '' } });

  const invalidate = () => { qc.invalidateQueries({ queryKey: ['leave-balance'] }); qc.invalidateQueries({ queryKey: ['leave-ledger'] }); };
  const adjustMut = useMutation({
    mutationFn: (v) => leaveApi.adjust({ employeeId, ...v, days: Number(v.days) }),
    onSuccess: () => { toast.success('Balance adjusted'); invalidate(); onClose(); },
    onError: (e) => toast.error(e.response?.data?.error || 'Failed to adjust'),
  });
  const compMut = useMutation({
    mutationFn: (v) => leaveApi.compOff({ employeeId, ...v, days: Number(v.days) }),
    onSuccess: () => { toast.success('Comp-off saved'); invalidate(); onClose(); },
    onError: (e) => toast.error(e.response?.data?.error || 'Failed to save comp-off'),
  });

  const inp = 'w-full h-10 px-3 bg-gray-50 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-400';
  return (
    <div className="fixed inset-0 z-50 flex items-start sm:items-center justify-center bg-black/40 backdrop-blur-sm p-0 sm:p-4 overflow-y-auto">
      <div className="bg-white w-full sm:max-w-md sm:rounded-2xl shadow-2xl my-0 sm:my-8">
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
          <div><h2 className="text-lg font-bold text-gray-900">Manage Leave Balance</h2><p className="text-xs text-gray-400">{employeeName}</p></div>
          <button onClick={onClose} className="p-2 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded-lg"><XMarkIcon className="w-5 h-5" /></button>
        </div>
        <div className="px-6 pt-4">
          <div className="inline-flex bg-gray-100 p-1 rounded-lg gap-0.5">
            {[['adjust', 'Adjust Balance'], ['compoff', 'Comp Off']].map(([k, l]) => (
              <button key={k} onClick={() => setTab(k)} className={`px-4 py-1.5 rounded-md text-xs font-semibold ${tab === k ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500'}`}>{l}</button>
            ))}
          </div>
        </div>

        {tab === 'adjust' ? (
          <form onSubmit={adjustForm.handleSubmit(v => adjustMut.mutate(v))} className="p-6 space-y-4">
            <div className="space-y-1"><label className="block text-xs font-semibold text-gray-600">Bucket</label>
              <select className={inp} {...adjustForm.register('category')}>
                <option value="casual">Casual Leave</option><option value="sick">Sick Leave</option><option value="compoff">Comp Off</option>
              </select></div>
            <div className="space-y-1"><label className="block text-xs font-semibold text-gray-600">Days (use a negative number to deduct)</label>
              <input type="number" step="0.5" className={inp} placeholder="e.g. 2 or -1" {...adjustForm.register('days', { required: true })} /></div>
            <div className="space-y-1"><label className="block text-xs font-semibold text-gray-600">Reason</label>
              <input className={inp} placeholder="e.g. Carry-forward, correction…" {...adjustForm.register('reason')} /></div>
            <div className="flex justify-end gap-3 pt-2">
              <button type="button" onClick={onClose} className="px-4 py-2 text-sm text-gray-600">Cancel</button>
              <button type="submit" disabled={adjustMut.isPending} className="px-5 py-2.5 bg-indigo-600 text-white text-sm font-medium rounded-xl hover:bg-indigo-700 disabled:opacity-50">{adjustMut.isPending ? 'Saving…' : 'Apply Adjustment'}</button>
            </div>
          </form>
        ) : (
          <form onSubmit={compForm.handleSubmit(v => compMut.mutate(v))} className="p-6 space-y-4">
            <div className="space-y-1"><label className="block text-xs font-semibold text-gray-600">Action</label>
              <select className={inp} {...compForm.register('action')}>
                <option value="earn">Grant (earned — e.g. holiday working)</option><option value="use">Consume (used instead of paid leave)</option>
              </select></div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1"><label className="block text-xs font-semibold text-gray-600">Days</label>
                <input type="number" step="0.5" min="0" className={inp} placeholder="e.g. 1" {...compForm.register('days', { required: true })} /></div>
              <div className="space-y-1"><label className="block text-xs font-semibold text-gray-600">Date</label>
                <input type="date" className={inp} {...compForm.register('date', { required: true })} /></div>
            </div>
            <div className="space-y-1"><label className="block text-xs font-semibold text-gray-600">Reason</label>
              <input className={inp} placeholder="e.g. Worked on Republic Day holiday" {...compForm.register('reason')} /></div>
            <div className="flex justify-end gap-3 pt-2">
              <button type="button" onClick={onClose} className="px-4 py-2 text-sm text-gray-600">Cancel</button>
              <button type="submit" disabled={compMut.isPending} className="px-5 py-2.5 bg-indigo-600 text-white text-sm font-medium rounded-xl hover:bg-indigo-700 disabled:opacity-50">{compMut.isPending ? 'Saving…' : 'Save Comp Off'}</button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}

// `employeeId` fixes the summary to one person (My Profile / HR Employee Details);
// omit it for the Leave page, where HR gets an employee picker and the default is
// the signed-in user.
export default function LeaveBalance({ employeeId: fixedId, employeeName: fixedName }) {
  const { user, isHR } = useAuth();
  const hr = typeof isHR === 'function' ? isHR() : ['super_admin', 'hr_manager'].includes(user?.role);
  const [selectedEmp, setSelectedEmp] = useState('');
  const [showManage, setShowManage] = useState(false);
  const nowYear = new Date().getFullYear();
  const [year, setYear] = useState(nowYear);
  const years = [nowYear + 1, nowYear, nowYear - 1, nowYear - 2];   // history (req 10)

  const showPicker = hr && !fixedId;
  const { data: empRes } = useQuery({ queryKey: ['employees-lite'], queryFn: () => employeeApi.list({ limit: 500 }), enabled: showPicker });
  const employees = empRes?.data?.data || empRes?.data || [];
  const targetId = fixedId || (hr ? (selectedEmp || undefined) : undefined);   // undefined → self on the backend
  const manageEmpId = fixedId || selectedEmp;   // a concrete employee HR can manage
  const targetName = fixedName || (fixedId ? '' : (hr && selectedEmp ? (employees.find(e => e.hr_hremployeeid === selectedEmp)?.hr_hremployee1 || 'Employee') : (user?.name || 'You')));

  const { data: bal, isLoading } = useQuery({
    queryKey: ['leave-balance', targetId || 'self', year],
    queryFn: () => leaveApi.balance({ ...(targetId ? { employeeId: targetId } : {}), year }),
  });
  const b = bal?.data;

  const cards = useMemo(() => {
    if (!b) return [];
    const list = [
      { label: 'Casual Leave', value: d(b.casual?.remaining), sub: `Allocated ${d(b.casual?.entitled)} · Used ${d(b.casual?.used)}`, accent: 'bg-sky-500', pct: ((Number(b.casual?.used) || 0) / (Number(b.casual?.entitled) || 1)) * 100 },
      { label: 'Sick Leave', value: d(b.sick?.remaining), sub: `Allocated ${d(b.sick?.entitled)} · Used ${d(b.sick?.used)}`, accent: 'bg-rose-500', pct: ((Number(b.sick?.used) || 0) / (Number(b.sick?.entitled) || 1)) * 100 },
    ];
    // Earned Leave is removed from the employee UI — Comp Off replaces it.
    list.push(
      { label: 'Comp Off', value: d(b.compOff?.balance), sub: `Earned ${d(b.compOff?.earned)} · Used ${d(b.compOff?.used)}`, note: b.compOff?.nextExpiry ? `Expires ${fmtDate(b.compOff.nextExpiry)}` : undefined, accent: 'bg-emerald-500' },
      { label: 'LOP (this year)', value: d(b.lop?.fromLeave), sub: 'Used · unpaid leave days', accent: 'bg-amber-500' },
    );
    return list;
  }, [b]);

  return (
    <div className="bg-gray-50/60 rounded-2xl border border-gray-100 p-4 sm:p-5 space-y-4">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <h2 className="text-sm font-bold text-gray-900">Leave Balance · {year}</h2>
          <p className="text-xs text-gray-400">Leave year Jan–Dec. Policy: 12 Casual + 6 Sick = 18 paid/year. Beyond that becomes LOP (unpaid).</p>
        </div>
        <div className="flex items-center gap-2">
          {/* Year history (req 10) */}
          <select value={year} onChange={e => setYear(Number(e.target.value))}
            className="h-9 px-3 bg-white border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20">
            {years.map(y => <option key={y} value={y}>{y}</option>)}
          </select>
          {showPicker && (
            <select value={selectedEmp} onChange={e => setSelectedEmp(e.target.value)}
              className="h-9 px-3 bg-white border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20">
              <option value="">Me</option>
              {employees.map(e => <option key={e.hr_hremployeeid} value={e.hr_hremployeeid}>{e.hr_hremployee1}</option>)}
            </select>
          )}
          {hr && manageEmpId && (
            <button onClick={() => setShowManage(true)}
              className="inline-flex items-center gap-1.5 h-9 px-3 bg-indigo-600 text-white text-xs font-semibold rounded-lg hover:bg-indigo-700"
              title="Adjust balance / comp-off">
              <AdjustmentsHorizontalIcon className="w-4 h-4" /> Manage
            </button>
          )}
        </div>
      </div>

      {isLoading ? (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">{[...Array(4)].map((_, i) => <div key={i} className="h-24 bg-white rounded-xl border border-gray-100 animate-pulse" />)}</div>
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
          {cards.map(c => <BalanceCard key={c.label} {...c} />)}
        </div>
      )}

      {showManage && manageEmpId && <ManageModal employeeId={manageEmpId} employeeName={targetName || fixedName || 'Employee'} onClose={() => setShowManage(false)} />}
    </div>
  );
}
