import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { requestLifecycleApi } from '../../api/endpoints';
import { CheckIcon, XMarkIcon, XCircleIcon } from '@heroicons/react/24/outline';
import { format } from 'date-fns';
import toast from 'react-hot-toast';

const fmt = (d) => { try { return d ? format(new Date(d), 'dd MMM yyyy') : '—'; } catch { return '—'; } };
const PILL = { pending: 'bg-amber-50 text-amber-700', approved: 'bg-emerald-50 text-emerald-700', rejected: 'bg-red-50 text-red-700' };

// Cross-module HR queue for "Request Cancellation" of approved requests
// (employee → manager → HR). One surface for Leave / Late Login / Comp Off / …
export default function CancellationRequestsPage() {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({ queryKey: ['cancellations', 'pending'], queryFn: () => requestLifecycleApi.cancellations({ status: 'pending' }).then(r => r.data) });
  const rows = data?.data || [];

  const decide = useMutation({
    mutationFn: ({ level, type, requestId, action }) => (level === 'hr'
      ? requestLifecycleApi.cancellationHr(type, requestId, action)
      : requestLifecycleApi.cancellationManager(type, requestId, action)),
    onSuccess: (_, v) => { toast.success(`Cancellation ${v.action === 'approved' ? (v.level === 'hr' ? 'approved' : 'sent to HR') : 'rejected'}`); qc.invalidateQueries({ queryKey: ['cancellations'] }); },
    onError: (e) => toast.error(e.response?.data?.error || 'Failed'),
  });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900 tracking-tight flex items-center gap-2"><XCircleIcon className="w-6 h-6 text-orange-500" /> Cancellation Requests</h1>
        <p className="text-sm text-gray-500 mt-1">Employees' requests to cancel an already-approved request. Manager approves, then HR finalises — on approval the request is reversed (balance / attendance / dashboard restore automatically).</p>
      </div>

      <div className="bg-white rounded-xl border border-gray-100 shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-gray-500">
              <tr className="text-left">
                <th className="px-4 py-3 font-semibold">Employee</th>
                <th className="px-4 py-3 font-semibold">Module</th>
                <th className="px-4 py-3 font-semibold">Reason</th>
                <th className="px-4 py-3 font-semibold">Requested</th>
                <th className="px-4 py-3 font-semibold">Manager</th>
                <th className="px-4 py-3 font-semibold text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {isLoading ? (
                <tr><td colSpan={6} className="px-4 py-10 text-center text-gray-400">Loading…</td></tr>
              ) : rows.length === 0 ? (
                <tr><td colSpan={6} className="px-4 py-10 text-center text-gray-400">No pending cancellation requests.</td></tr>
              ) : rows.map(c => (
                <tr key={c.id} className="hover:bg-gray-50/50">
                  <td className="px-4 py-3 font-medium text-gray-800">{c.employeeName || '—'}</td>
                  <td className="px-4 py-3 text-gray-600">{c.requestTypeLabel}</td>
                  <td className="px-4 py-3 text-gray-500 max-w-[18rem] truncate" title={c.reason}>{c.reason || '—'}</td>
                  <td className="px-4 py-3 text-gray-500">{fmt(c.createdOn)}</td>
                  <td className="px-4 py-3"><span className={`inline-flex text-[11px] font-semibold px-2 py-0.5 rounded-full capitalize ${PILL[c.managerStatus] || PILL.pending}`}>{c.managerStatus}</span></td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-1.5 justify-end flex-wrap">
                      {c.managerStatus === 'pending' && (
                        <>
                          <button onClick={() => decide.mutate({ level: 'manager', type: c.requestType, requestId: c.requestId, action: 'approved' })} className="inline-flex items-center gap-1 px-2 py-1 text-xs font-semibold text-blue-700 bg-blue-50 rounded-lg hover:bg-blue-100"><CheckIcon className="w-3.5 h-3.5" /> Mgr Approve</button>
                          <button onClick={() => decide.mutate({ level: 'manager', type: c.requestType, requestId: c.requestId, action: 'rejected' })} className="inline-flex items-center gap-1 px-2 py-1 text-xs font-semibold text-red-700 bg-red-50 rounded-lg hover:bg-red-100"><XMarkIcon className="w-3.5 h-3.5" /> Reject</button>
                        </>
                      )}
                      {c.managerStatus === 'approved' && (
                        <>
                          <button onClick={() => decide.mutate({ level: 'hr', type: c.requestType, requestId: c.requestId, action: 'approved' })} className="inline-flex items-center gap-1 px-2 py-1 text-xs font-semibold text-emerald-700 bg-emerald-50 rounded-lg hover:bg-emerald-100"><CheckIcon className="w-3.5 h-3.5" /> HR Approve</button>
                          <button onClick={() => decide.mutate({ level: 'hr', type: c.requestType, requestId: c.requestId, action: 'rejected' })} className="inline-flex items-center gap-1 px-2 py-1 text-xs font-semibold text-red-700 bg-red-50 rounded-lg hover:bg-red-100"><XMarkIcon className="w-3.5 h-3.5" /> Reject</button>
                        </>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
