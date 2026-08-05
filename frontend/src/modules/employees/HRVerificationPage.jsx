import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { employeeApi } from '../../api/endpoints';
import {
  ShieldCheckIcon, CheckCircleIcon, XCircleIcon, ArrowRightIcon, XMarkIcon, EyeIcon, ExclamationTriangleIcon,
} from '@heroicons/react/24/outline';
import { fmtVal, fmtDate } from '../../utils/format';
import toast from 'react-hot-toast';

function ChangesModal({ row, onClose, onDecision, busy }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl max-h-[calc(100dvh-2rem)] overflow-hidden flex flex-col">
        <div className="flex items-center justify-between px-6 py-5 border-b border-gray-100">
          <div>
            <h2 className="text-lg font-semibold text-gray-900">Review Changes — {row.name}</h2>
            <p className="text-sm text-gray-400 mt-0.5">{fmtVal(row.code)} · {fmtVal(row.department)} · {row.sections.join(', ')}</p>
          </div>
          <button onClick={onClose} className="p-2 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded-xl"><XMarkIcon className="w-5 h-5" /></button>
        </div>

        <div className="px-6 py-5 overflow-y-auto">
          {row.changes.length === 0 ? (
            <p className="text-sm text-gray-400 text-center py-8">No field-level changes recorded (audit table may not be provisioned yet).</p>
          ) : (
            <div className="space-y-3">
              {row.changes.map((c, i) => (
                <div key={i} className="border border-gray-100 rounded-xl p-4">
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-sm font-semibold text-gray-800">{c.label}</span>
                    <span className="text-xs font-medium text-gray-400 bg-gray-50 px-2 py-0.5 rounded-full">{c.section}</span>
                  </div>
                  <div className="flex items-center gap-3 flex-wrap">
                    <span className="text-sm text-gray-500 line-through decoration-red-300">{fmtVal(c.oldValue, 'not set')}</span>
                    <ArrowRightIcon className="w-4 h-4 text-gray-300" />
                    <span className="text-sm font-semibold text-emerald-700">{fmtVal(c.newValue, 'not set')}</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="px-6 py-4 border-t border-gray-100 flex flex-wrap justify-end gap-2">
          <button onClick={onClose} className="px-4 py-2 text-sm font-medium text-gray-600 hover:text-gray-800">Close</button>
          <button disabled={busy} onClick={() => onDecision('request_changes')} className="px-4 py-2 text-sm font-semibold text-orange-700 bg-orange-100 rounded-lg hover:bg-orange-200 disabled:opacity-50">Request Changes</button>
          <button disabled={busy} onClick={() => onDecision('reject')} className="inline-flex items-center gap-1 px-4 py-2 text-sm font-semibold text-red-700 bg-red-100 rounded-lg hover:bg-red-200 disabled:opacity-50"><XCircleIcon className="w-4 h-4" /> Reject</button>
          <button disabled={busy} onClick={() => onDecision('approve')} className="inline-flex items-center gap-1 px-5 py-2 text-sm font-semibold text-white bg-emerald-600 rounded-lg hover:bg-emerald-700 disabled:opacity-50"><CheckCircleIcon className="w-4 h-4" /> Approve</button>
        </div>
      </div>
    </div>
  );
}

export default function HRVerificationPage() {
  const qc = useQueryClient();
  const [selected, setSelected] = useState(null);

  const { data, isLoading } = useQuery({ queryKey: ['pending-verifications'], queryFn: () => employeeApi.pendingVerifications(), refetchInterval: 30000 });
  const rows = data?.data?.data || [];

  const decide = useMutation({
    mutationFn: ({ id, action, note }) => employeeApi.verify(id, { action, note }),
    onSuccess: (_r, vars) => {
      toast.success(vars.action === 'approve' ? 'Approved — Employee Master updated' : vars.action === 'reject' ? 'Rejected — employee notified' : 'Changes requested — employee notified');
      qc.invalidateQueries({ queryKey: ['pending-verifications'] });
      qc.invalidateQueries({ queryKey: ['employee', vars.id] });
      setSelected(null);
    },
    onError: (err) => toast.error(err.response?.data?.error || 'Action failed'),
  });

  const onDecision = (action) => {
    let note = '';
    if (action === 'reject') note = window.prompt('Reason for rejection (emailed to the employee):') || '';
    if (action === 'request_changes') note = window.prompt('What changes are needed? (emailed to the employee):') || '';
    decide.mutate({ id: selected.id, action, note });
  };

  const backfill = useMutation({
    mutationFn: () => employeeApi.backfillCodes(),
    onSuccess: (res) => toast.success(res.data?.message || 'Employee IDs assigned'),
    onError: (err) => toast.error(err.response?.data?.error || 'Failed to assign IDs'),
  });

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3 flex-wrap">
        <div className="w-10 h-10 bg-gradient-to-br from-indigo-500 to-indigo-700 rounded-xl flex items-center justify-center shadow-lg shadow-indigo-500/20">
          <ShieldCheckIcon className="w-5 h-5 text-white" />
        </div>
        <div className="flex-1">
          <h1 className="text-2xl font-bold text-gray-900 tracking-tight">HR Verification</h1>
          <p className="text-sm text-gray-400">{rows.length} profile{rows.length === 1 ? '' : 's'} awaiting verification</p>
        </div>
        <button onClick={() => backfill.mutate()} disabled={backfill.isPending}
          className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-semibold text-gray-700 bg-white border border-gray-200 rounded-xl hover:bg-gray-50 disabled:opacity-50">
          {backfill.isPending ? 'Assigning…' : 'Assign Employee IDs'}
        </button>
      </div>

      <div className="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="bg-gray-50/80">
                {['Employee ID', 'Employee Name', 'Department', 'Changed Section', 'Submitted On', 'Status', 'Actions'].map(h => (
                  <th key={h} className="px-5 py-3.5 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider whitespace-nowrap">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100/70">
              {isLoading ? (
                <tr><td colSpan={7} className="px-5 py-16 text-center text-sm text-gray-400">Loading…</td></tr>
              ) : rows.length === 0 ? (
                <tr><td colSpan={7} className="px-5 py-16 text-center">
                  <div className="flex flex-col items-center gap-2">
                    <ShieldCheckIcon className="w-10 h-10 text-emerald-300" />
                    <p className="text-sm font-medium text-gray-500">All caught up</p>
                    <p className="text-xs text-gray-400">No profiles are pending verification.</p>
                  </div>
                </td></tr>
              ) : rows.map(r => (
                <tr key={r.id} className="hover:bg-gray-50/50 transition-colors">
                  <td className="px-5 py-4 text-sm font-semibold text-gray-900 tabular-nums">{fmtVal(r.code)}</td>
                  <td className="px-5 py-4 text-sm font-medium text-gray-800">{r.name}</td>
                  <td className="px-5 py-4 text-sm text-gray-600">{fmtVal(r.department)}</td>
                  <td className="px-5 py-4">
                    <div className="flex flex-wrap gap-1">
                      {r.sections.length ? r.sections.map(s => <span key={s} className="text-xs font-medium text-indigo-600 bg-indigo-50 px-2 py-0.5 rounded-full">{s}</span>) : <span className="text-xs text-gray-400">—</span>}
                    </div>
                  </td>
                  <td className="px-5 py-4 text-sm text-gray-500">{fmtDate(r.submittedOn)}</td>
                  <td className="px-5 py-4">
                    <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-amber-700"><ExclamationTriangleIcon className="w-3.5 h-3.5" /> Pending</span>
                  </td>
                  <td className="px-5 py-4">
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <button onClick={() => setSelected(r)} className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-semibold text-indigo-600 bg-indigo-50 rounded-lg hover:bg-indigo-100"><EyeIcon className="w-3.5 h-3.5" /> View Changes</button>
                      <button onClick={() => decide.mutate({ id: r.id, action: 'approve' })} disabled={decide.isPending} className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-semibold text-emerald-700 bg-emerald-50 rounded-lg hover:bg-emerald-100 disabled:opacity-50"><CheckCircleIcon className="w-3.5 h-3.5" /> Approve</button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {selected && <ChangesModal row={selected} onClose={() => setSelected(null)} onDecision={onDecision} busy={decide.isPending} />}
    </div>
  );
}
