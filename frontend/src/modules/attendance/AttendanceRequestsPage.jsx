import { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { CheckIcon, XMarkIcon, ClockIcon, PlusIcon } from '@heroicons/react/24/outline';
import { attendanceRequestApi } from '../../api/endpoints';
import { useAuth } from '../../context/AuthContext';
import Button from '../../components/Button';
import MissingPunchModal from './MissingPunchModal';
import RequestLifecycleActions from '../../components/RequestLifecycleActions';

const STATUS_STYLE = {
  pending: 'bg-amber-50 text-amber-700', approved: 'bg-emerald-50 text-emerald-700', rejected: 'bg-red-50 text-red-700',
};

export default function AttendanceRequestsPage({ autoOpenKind } = {}) {
  const { isHR } = useAuth();
  const qc = useQueryClient();
  const [statusFilter, setStatusFilter] = useState('');
  const [comment, setComment] = useState({});   // per-request comment
  const [modalOpen, setModalOpen] = useState(false);
  const [editRecord, setEditRecord] = useState(null);   // employee editing their own pending request
  const [defaultKind, setDefaultKind] = useState(null); // preselect a request kind (e.g. Early Logout)

  // Deep-link (e.g. the "Early Logout" nav item → /early-logout) opens the request
  // form straight to that kind.
  useEffect(() => {
    if (autoOpenKind) { setEditRecord(null); setDefaultKind(autoOpenKind); setModalOpen(true); }
  }, [autoOpenKind]);

  const { data, isLoading } = useQuery({
    queryKey: ['attendance-requests', statusFilter],
    queryFn: () => attendanceRequestApi.list({ status: statusFilter || undefined }),
    placeholderData: (prev) => prev,
  });
  const rows = data?.data?.data || [];

  const act = useMutation({
    mutationFn: ({ id, action }) => action === 'approved'
      ? attendanceRequestApi.approve(id, comment[id]) : attendanceRequestApi.reject(id, comment[id]),
    onSuccess: (_r, v) => { toast.success(`Request ${v.action === 'approved' ? 'approved — attendance recalculated' : 'rejected'}`); qc.invalidateQueries({ queryKey: ['attendance-requests'] }); qc.invalidateQueries({ queryKey: ['attendance'] }); },
    onError: (e) => toast.error(e.response?.data?.error || 'Action failed'),
  });

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-xl font-bold text-gray-900">Attendance Requests</h1>
          <p className="text-sm text-gray-400">Attendance corrections {isHR() ? '— review & approve' : '— your submitted requests'}</p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <Button icon={PlusIcon} onClick={() => { setEditRecord(null); setDefaultKind(null); setModalOpen(true); }}>New Request</Button>
          <select value={statusFilter} onChange={e => setStatusFilter(e.target.value)}
            className="h-9 px-3 bg-gray-50 border border-gray-200 rounded-lg text-sm text-gray-700 outline-none focus:ring-2 focus:ring-indigo-500/20 cursor-pointer">
            <option value="">All Status</option>
            <option value="pending">Pending</option>
            <option value="approved">Approved</option>
            <option value="rejected">Rejected</option>
          </select>
        </div>
      </div>

      <div className="bg-white rounded-xl border border-gray-100 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs font-semibold text-gray-400 uppercase tracking-wider border-b border-gray-100">
                {isHR() && <th className="px-4 py-3">Employee</th>}
                <th className="px-4 py-3">Date</th>
                <th className="px-4 py-3">Punch Type</th>
                <th className="px-4 py-3">Requested</th>
                <th className="px-4 py-3">Reason</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {isLoading && !rows.length ? (
                <tr><td colSpan={isHR() ? 7 : 6} className="px-4 py-10 text-center text-gray-400">Loading…</td></tr>
              ) : !rows.length ? (
                <tr><td colSpan={isHR() ? 7 : 6} className="px-4 py-10 text-center text-gray-400 flex-col">
                  <ClockIcon className="w-8 h-8 mx-auto text-gray-200 mb-2" />No attendance requests.
                </td></tr>
              ) : rows.map(r => (
                <tr key={r.id} className="hover:bg-gray-50/50">
                  {isHR() && <td className="px-4 py-3 font-medium text-gray-800">{r.employeeName}</td>}
                  <td className="px-4 py-3 text-gray-600">{r.date}</td>
                  <td className="px-4 py-3 text-gray-600">{r.punchTypeLabel}</td>
                  <td className="px-4 py-3 font-semibold text-gray-800 tabular-nums">
                    {r.punchType === 'hour_adjustment' ? `${r.adjustmentHours}h adjustment`
                      : r.punchType === 'early_logout' ? `${r.requestedTime} · ${r.adjustmentHours}h early`
                      : r.requestedTime}
                  </td>
                  <td className="px-4 py-3 text-gray-500 max-w-[220px] truncate" title={r.reason}>{r.reason}</td>
                  <td className="px-4 py-3">
                    <span className={`text-xs font-semibold px-2 py-0.5 rounded-full capitalize ${STATUS_STYLE[r.status] || 'bg-gray-100 text-gray-500'}`}>{r.status}</span>
                  </td>
                  <td className="px-4 py-3">
                    {isHR() ? (
                      r.status === 'pending' ? (
                        <div className="flex items-center gap-2 justify-end">
                          <input value={comment[r.id] || ''} onChange={e => setComment(c => ({ ...c, [r.id]: e.target.value }))} placeholder="Comment"
                            className="w-28 px-2 py-1 text-xs border border-gray-200 rounded-lg bg-gray-50 outline-none" />
                          <button onClick={() => act.mutate({ id: r.id, action: 'approved' })} disabled={act.isPending}
                            className="p-1.5 rounded-lg bg-emerald-50 text-emerald-600 hover:bg-emerald-100 disabled:opacity-50" title="Approve"><CheckIcon className="w-4 h-4" /></button>
                          <button onClick={() => act.mutate({ id: r.id, action: 'rejected' })} disabled={act.isPending}
                            className="p-1.5 rounded-lg bg-red-50 text-red-600 hover:bg-red-100 disabled:opacity-50" title="Reject"><XMarkIcon className="w-4 h-4" /></button>
                        </div>
                      ) : (
                        <span className="text-xs text-gray-400 flex justify-end">{r.approvedBy ? `by ${r.approvedBy}` : '—'}</span>
                      )
                    ) : (
                      // Employee self-service on their OWN request. Approved → History only
                      // (attendance corrections can't be cancelled once applied — a factual record).
                      <RequestLifecycleActions
                        type="attendance_correction" id={r.id} status={r.status}
                        caps={{ canCancel: false }}
                        onEdit={() => { setEditRecord(r); setModalOpen(true); }}
                        onChanged={() => qc.invalidateQueries({ queryKey: ['attendance-requests'] })}
                        invalidateKeys={[['attendance-requests'], ['attendance']]}
                      />
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <MissingPunchModal open={modalOpen} defaultKind={defaultKind} onClose={() => { setModalOpen(false); setEditRecord(null); setDefaultKind(null); }} editRecord={editRecord} />
    </div>
  );
}
