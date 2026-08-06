import { useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { ptMasterApi } from '../../api/endpoints';
import {
  ScaleIcon, PlusIcon, XMarkIcon, PencilSquareIcon, CheckCircleIcon, NoSymbolIcon, BeakerIcon,
} from '@heroicons/react/24/outline';
import { fmtDate } from '../../utils/format';
import toast from 'react-hot-toast';

const inr = (n) => '₹' + (Number(n) || 0).toLocaleString('en-IN');
const band = (s) => `${inr(s.salaryFrom)} – ${s.salaryTo > 0 ? inr(s.salaryTo) : '∞'}`;
const inputCls = 'w-full h-10 px-3 bg-gray-50 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-400';

function SlabModal({ slab, onClose }) {
  const qc = useQueryClient();
  const isEdit = !!slab;
  const { register, handleSubmit } = useForm({
    defaultValues: {
      state: slab?.state || 'Andhra Pradesh', effectiveFrom: slab?.effectiveFrom || new Date().toISOString().slice(0, 10),
      effectiveTo: slab?.effectiveTo || '', salaryFrom: slab?.salaryFrom ?? 0, salaryTo: slab?.salaryTo ?? 0,
      amount: slab?.amount ?? 0, status: slab?.status || 'active', remarks: slab?.remarks || '',
    },
  });
  const mut = useMutation({
    mutationFn: (v) => isEdit ? ptMasterApi.update(slab.id, v) : ptMasterApi.create(v),
    onSuccess: () => { toast.success(isEdit ? 'Slab updated' : 'Slab added'); qc.invalidateQueries({ queryKey: ['pt-slabs'] }); onClose(); },
    onError: (e) => toast.error(e.response?.data?.error || 'Failed to save slab'),
  });
  return (
    <div className="fixed inset-0 z-50 flex items-start sm:items-center justify-center bg-black/40 backdrop-blur-sm p-0 sm:p-4 overflow-y-auto">
      <div className="bg-white w-full sm:max-w-md sm:rounded-2xl shadow-2xl my-0 sm:my-8">
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
          <h2 className="text-lg font-bold text-gray-900">{isEdit ? 'Edit PT Slab' : 'Add PT Slab'}</h2>
          <button onClick={onClose} className="p-2 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded-lg"><XMarkIcon className="w-5 h-5" /></button>
        </div>
        <form onSubmit={handleSubmit(v => mut.mutate(v))} className="p-6 space-y-4">
          <div className="space-y-1"><label className="block text-xs font-semibold text-gray-600">State<span className="text-red-500">*</span></label>
            <input className={inputCls} placeholder="e.g. Andhra Pradesh" {...register('state', { required: true })} /></div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1"><label className="block text-xs font-semibold text-gray-600">Effective From<span className="text-red-500">*</span></label>
              <input type="date" className={inputCls} {...register('effectiveFrom', { required: true })} /></div>
            <div className="space-y-1"><label className="block text-xs font-semibold text-gray-600">Effective To</label>
              <input type="date" className={inputCls} {...register('effectiveTo')} /></div>
          </div>
          <div className="grid grid-cols-3 gap-3">
            <div className="space-y-1"><label className="block text-xs font-semibold text-gray-600">Salary From</label>
              <input type="number" min="0" className={inputCls} {...register('salaryFrom')} /></div>
            <div className="space-y-1"><label className="block text-xs font-semibold text-gray-600">Salary To</label>
              <input type="number" min="0" className={inputCls} title="0 = no upper bound" {...register('salaryTo')} /></div>
            <div className="space-y-1"><label className="block text-xs font-semibold text-gray-600">PT (₹)</label>
              <input type="number" min="0" className={inputCls} {...register('amount')} /></div>
          </div>
          <p className="text-[11px] text-gray-400">Salary To = 0 means "no upper bound" (e.g. Above ₹20,000).</p>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1"><label className="block text-xs font-semibold text-gray-600">Status</label>
              <select className={inputCls} {...register('status')}><option value="active">Active</option><option value="inactive">Inactive</option></select></div>
            <div className="space-y-1"><label className="block text-xs font-semibold text-gray-600">Remarks</label>
              <input className={inputCls} {...register('remarks')} /></div>
          </div>
          <div className="flex justify-end gap-3 pt-2">
            <button type="button" onClick={onClose} className="px-4 py-2 text-sm text-gray-600">Cancel</button>
            <button type="submit" disabled={mut.isPending} className="px-5 py-2.5 bg-indigo-600 text-white text-sm font-medium rounded-xl hover:bg-indigo-700 disabled:opacity-50">{mut.isPending ? 'Saving…' : isEdit ? 'Save' : 'Add Slab'}</button>
          </div>
        </form>
      </div>
    </div>
  );
}

// Quick "what PT applies?" tester — hits the same resolver payroll uses.
function Tester() {
  const [state, setState] = useState('Andhra Pradesh');
  const [gross, setGross] = useState('25000');
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const { data, refetch, isFetching } = useQuery({
    queryKey: ['pt-preview'], enabled: false,
    queryFn: () => ptMasterApi.preview({ state, gross, date }),
  });
  return (
    <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5">
      <div className="flex items-center gap-2 mb-3"><BeakerIcon className="w-5 h-5 text-indigo-600" /><h3 className="text-sm font-bold text-gray-900">Slab Tester</h3></div>
      <div className="grid grid-cols-1 sm:grid-cols-4 gap-2 items-end">
        <div className="space-y-1"><label className="block text-xs font-semibold text-gray-600">State</label><input value={state} onChange={e => setState(e.target.value)} className={inputCls} /></div>
        <div className="space-y-1"><label className="block text-xs font-semibold text-gray-600">Gross</label><input type="number" value={gross} onChange={e => setGross(e.target.value)} className={inputCls} /></div>
        <div className="space-y-1"><label className="block text-xs font-semibold text-gray-600">Payroll Date</label><input type="date" value={date} onChange={e => setDate(e.target.value)} className={inputCls} /></div>
        <button onClick={() => refetch()} disabled={isFetching} className="h-10 px-4 bg-indigo-600 text-white text-sm font-medium rounded-lg hover:bg-indigo-700 disabled:opacity-50">{isFetching ? '…' : 'Resolve'}</button>
      </div>
      {data && <p className="mt-3 text-sm">Professional Tax = <span className="font-bold text-indigo-700">{inr(data.data.amount)}</span></p>}
    </div>
  );
}

export default function PTMasterPage() {
  const qc = useQueryClient();
  const [modal, setModal] = useState(null);   // { slab } | 'new'
  const { data, isLoading } = useQuery({ queryKey: ['pt-slabs'], queryFn: () => ptMasterApi.list() });
  const slabs = data?.data?.data || [];

  const statusMut = useMutation({
    mutationFn: ({ id, status }) => ptMasterApi.setStatus(id, status),
    onSuccess: () => { toast.success('Status updated'); qc.invalidateQueries({ queryKey: ['pt-slabs'] }); },
    onError: () => toast.error('Failed to update status'),
  });

  const byState = useMemo(() => {
    const m = new Map();
    for (const s of slabs) { if (!m.has(s.state)) m.set(s.state, []); m.get(s.state).push(s); }
    return [...m.entries()];
  }, [slabs]);

  return (
    <div className="space-y-5">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 bg-gradient-to-br from-indigo-500 to-indigo-700 rounded-xl flex items-center justify-center shadow-lg shadow-indigo-500/20"><ScaleIcon className="w-5 h-5 text-white" /></div>
          <div>
            <h1 className="text-2xl font-bold text-gray-900 tracking-tight">Professional Tax Master</h1>
            <p className="text-sm text-gray-400">Configurable, effective-dated PT slabs by state & salary band. Payroll picks the right slab automatically — never hardcoded.</p>
          </div>
        </div>
        <button onClick={() => setModal('new')} className="inline-flex items-center gap-2 px-4 py-2.5 bg-gradient-to-r from-indigo-600 to-indigo-700 text-white text-sm font-medium rounded-xl hover:from-indigo-700 hover:to-indigo-800 shadow-lg shadow-indigo-500/25 self-start"><PlusIcon className="w-4.5 h-4.5" /> Add Slab</button>
      </div>

      <Tester />

      {isLoading ? (
        <div className="bg-white rounded-2xl border border-gray-100 p-10 text-center text-gray-400">Loading…</div>
      ) : slabs.length === 0 ? (
        <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-16 text-center">
          <ScaleIcon className="w-12 h-12 text-gray-200 mx-auto mb-3" />
          <p className="text-sm text-gray-500">No PT slabs yet. Click "Add Slab" to define the first one.</p>
        </div>
      ) : (
        <div className="space-y-5">
          {byState.map(([state, rows]) => (
            <div key={state} className="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden">
              <div className="px-5 py-3 border-b border-gray-50 bg-gray-50/60"><h3 className="text-sm font-bold text-gray-900">{state}</h3></div>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="text-xs text-gray-500"><tr>
                    <th className="px-5 py-2.5 text-left font-semibold">Salary Band</th>
                    <th className="px-5 py-2.5 text-right font-semibold">PT</th>
                    <th className="px-5 py-2.5 text-left font-semibold">Effective</th>
                    <th className="px-5 py-2.5 text-left font-semibold">Status</th>
                    <th className="px-5 py-2.5 text-left font-semibold">Remarks</th>
                    <th className="px-5 py-2.5"></th>
                  </tr></thead>
                  <tbody className="divide-y divide-gray-50">
                    {rows.map(s => (
                      <tr key={s.id} className={s.status !== 'active' ? 'opacity-50' : ''}>
                        <td className="px-5 py-3 font-medium text-gray-900">{band(s)}</td>
                        <td className="px-5 py-3 text-right font-bold text-indigo-700">{inr(s.amount)}</td>
                        <td className="px-5 py-3 text-gray-500">{fmtDate(s.effectiveFrom)}{s.effectiveTo ? ` → ${fmtDate(s.effectiveTo)}` : ' →'}</td>
                        <td className="px-5 py-3"><span className={`px-2 py-0.5 rounded-full text-[10px] font-semibold uppercase ring-1 ${s.status === 'active' ? 'bg-emerald-50 text-emerald-700 ring-emerald-600/20' : 'bg-gray-100 text-gray-500 ring-gray-500/10'}`}>{s.status}</span></td>
                        <td className="px-5 py-3 text-gray-500">{s.remarks || '—'}</td>
                        <td className="px-5 py-3">
                          <div className="flex items-center justify-end gap-1">
                            <button onClick={() => setModal({ slab: s })} title="Edit" className="p-1.5 text-gray-400 hover:text-indigo-600 hover:bg-indigo-50 rounded-lg"><PencilSquareIcon className="w-4 h-4" /></button>
                            {s.status === 'active'
                              ? <button onClick={() => statusMut.mutate({ id: s.id, status: 'inactive' })} title="Deactivate" className="p-1.5 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded-lg"><NoSymbolIcon className="w-4 h-4" /></button>
                              : <button onClick={() => statusMut.mutate({ id: s.id, status: 'active' })} title="Activate" className="p-1.5 text-gray-400 hover:text-emerald-600 hover:bg-emerald-50 rounded-lg"><CheckCircleIcon className="w-4 h-4" /></button>}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ))}
        </div>
      )}

      {modal && <SlabModal slab={modal === 'new' ? null : modal.slab} onClose={() => setModal(null)} />}
    </div>
  );
}
