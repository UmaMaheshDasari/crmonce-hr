import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { CheckIcon, XMarkIcon, ClockIcon, PlusIcon, TrashIcon } from '@heroicons/react/24/outline';
import { attendanceRequestApi } from '../../api/endpoints';
import { useAuth } from '../../context/AuthContext';
import Button from '../../components/Button';
import MissingPunchModal from './MissingPunchModal';
import RequestLifecycleActions from '../../components/RequestLifecycleActions';

const STATUS_STYLE = {
  pending: 'bg-amber-50 text-amber-700', approved: 'bg-emerald-50 text-emerald-700', rejected: 'bg-red-50 text-red-700',
};

export default function AttendanceRequestsPage({ kind } = {}) {
  const isEarlyLogout = kind === 'early_logout';   // Early Logout has its OWN page/tab
  const { isHR, hasPermission } = useAuth();
  const canApprove = hasPermission('attendance.approve_request');   // RBAC Phase D
  const canReject = hasPermission('attendance.reject_request');
  const canDelete = canApprove || canReject;   // HR/Admin who manage the queue may delete a pending request
  const qc = useQueryClient();
  const [statusFilter, setStatusFilter] = useState('');
  const [comment, setComment] = useState({});   // per-request comment
  const [modalOpen, setModalOpen] = useState(false);
  const [editRecord, setEditRecord] = useState(null);   // employee editing their own pending request
  const [confirmDelete, setConfirmDelete] = useState(null);   // pending request awaiting delete confirmation
  const [approveDialog, setApproveDialog] = useState(null);   // request awaiting the Approve action dialog
  const [finalAction, setFinalAction] = useState('add');      // approver's confirmed final action ('add' | 'delete')

  const { data, isLoading } = useQuery({
    queryKey: ['attendance-requests', statusFilter],
    queryFn: () => attendanceRequestApi.list({ status: statusFilter || undefined }),
    placeholderData: (prev) => prev,
  });
  // Keep Early Logout and Attendance Corrections in SEPARATE tabs — never merged: the
  // Early Logout page shows only early_logout rows; Attendance Requests shows the rest.
  const rows = (data?.data?.data || []).filter(r =>
    isEarlyLogout ? r.punchType === 'early_logout' : r.punchType !== 'early_logout');

  const act = useMutation({
    mutationFn: ({ id, action, finalAction: fa }) => action === 'approved'
      ? attendanceRequestApi.approve(id, comment[id], fa) : attendanceRequestApi.reject(id, comment[id]),
    onSuccess: (_r, v) => { toast.success(`Request ${v.action === 'approved' ? 'approved — attendance recalculated' : 'rejected'}`); setApproveDialog(null); qc.invalidateQueries({ queryKey: ['attendance-requests'] }); qc.invalidateQueries({ queryKey: ['attendance'] }); },
    onError: (e) => toast.error(e.response?.data?.error || 'Action failed'),
  });
  const actionLabel = (a) => (a === 'delete' ? 'Delete Punch' : 'Add Punch');

  const del = useMutation({
    mutationFn: (id) => attendanceRequestApi.remove(id),
    onSuccess: () => { toast.success('Request deleted'); setConfirmDelete(null); qc.invalidateQueries({ queryKey: ['attendance-requests'] }); },
    onError: (e) => toast.error(e.response?.data?.error || 'Delete failed'),
  });

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-xl font-bold text-gray-900">{isEarlyLogout ? 'Early Logout' : 'Attendance Requests'}</h1>
          <p className="text-sm text-gray-400">{isEarlyLogout ? 'Early logout requests' : 'Attendance corrections'} {isHR() ? '— review & approve' : '— your submitted requests'}</p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <Button icon={PlusIcon} onClick={() => { setEditRecord(null); setModalOpen(true); }}>{isEarlyLogout ? 'Request Early Logout' : 'New Request'}</Button>
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
                <th className="px-4 py-3">Action</th>
                <th className="px-4 py-3">Punch Type</th>
                <th className="px-4 py-3">Requested</th>
                <th className="px-4 py-3">Reason</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {isLoading && !rows.length ? (
                <tr><td colSpan={isHR() ? 8 : 7} className="px-4 py-10 text-center text-gray-400">Loading…</td></tr>
              ) : !rows.length ? (
                <tr><td colSpan={isHR() ? 8 : 7} className="px-4 py-10 text-center text-gray-400 flex-col">
                  <ClockIcon className="w-8 h-8 mx-auto text-gray-200 mb-2" />No attendance requests.
                </td></tr>
              ) : rows.map(r => (
                <tr key={r.id} className="hover:bg-gray-50/50">
                  {isHR() && <td className="px-4 py-3 font-medium text-gray-800">{r.employeeName}</td>}
                  <td className="px-4 py-3 text-gray-600">{r.date}</td>
                  <td className="px-4 py-3">
                    <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${r.action === 'delete' ? 'bg-rose-50 text-rose-700' : 'bg-indigo-50 text-indigo-700'}`}>{actionLabel(r.action)}</span>
                  </td>
                  <td className="px-4 py-3 text-gray-600">{r.action === 'delete' ? '—' : r.punchTypeLabel}</td>
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
                    {(canApprove || canReject) ? (
                      r.status === 'pending' ? (
                        <div className="flex items-center gap-2 justify-end">
                          <input value={comment[r.id] || ''} onChange={e => setComment(c => ({ ...c, [r.id]: e.target.value }))} placeholder="Comment"
                            className="w-28 px-2 py-1 text-xs border border-gray-200 rounded-lg bg-gray-50 outline-none" />
                          {canApprove && <button onClick={() => { setFinalAction(r.action || 'add'); setApproveDialog(r); }} disabled={act.isPending}
                            className="p-1.5 rounded-lg bg-emerald-50 text-emerald-600 hover:bg-emerald-100 disabled:opacity-50" title="Approve"><CheckIcon className="w-4 h-4" /></button>}
                          {canReject && <button onClick={() => act.mutate({ id: r.id, action: 'rejected' })} disabled={act.isPending}
                            className="p-1.5 rounded-lg bg-red-50 text-red-600 hover:bg-red-100 disabled:opacity-50" title="Reject"><XMarkIcon className="w-4 h-4" /></button>}
                          {canDelete && <button onClick={() => setConfirmDelete(r)} disabled={del.isPending}
                            className="p-1.5 rounded-lg bg-gray-100 text-gray-600 hover:bg-gray-200 disabled:opacity-50" title="Delete / Cancel request"><TrashIcon className="w-4 h-4" /></button>}
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

      <MissingPunchModal open={modalOpen} lockKind={isEarlyLogout ? 'early_logout' : undefined} onClose={() => { setModalOpen(false); setEditRecord(null); }} editRecord={editRecord} />

      {approveDialog && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => !act.isPending && setApproveDialog(null)}>
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-md p-6" onClick={e => e.stopPropagation()}>
            <h2 className="text-lg font-bold text-gray-900 mb-3">Approve Attendance Correction</h2>
            <div className="rounded-xl border border-gray-100 bg-gray-50/60 p-3 text-sm space-y-1 mb-4">
              <div className="flex justify-between"><span className="text-gray-500">Employee</span><span className="font-semibold text-gray-800">{approveDialog.employeeName || '—'}</span></div>
              <div className="flex justify-between"><span className="text-gray-500">Date</span><span className="font-semibold text-gray-800">{approveDialog.date}</span></div>
              <div className="flex justify-between"><span className="text-gray-500">Requested action</span><span className="font-semibold text-gray-800">{actionLabel(approveDialog.action)}</span></div>
              <div className="flex justify-between"><span className="text-gray-500">{approveDialog.action === 'delete' ? 'Selected punch' : 'Requested time'}</span><span className="font-semibold text-gray-800 tabular-nums">{approveDialog.requestedTime || '—'}</span></div>
              <div className="flex justify-between gap-3"><span className="text-gray-500">Reason</span><span className="font-medium text-gray-700 text-right">{approveDialog.reason || '—'}</span></div>
            </div>
            <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Final action</p>
            <div className="space-y-2 mb-5">
              <label className="flex items-center gap-2 text-sm text-gray-700 cursor-pointer">
                <input type="radio" name="finalAction" checked={finalAction === 'add'} onChange={() => setFinalAction('add')} />
                Add selected time to attendance
              </label>
              <label className="flex items-center gap-2 text-sm text-gray-700 cursor-pointer">
                <input type="radio" name="finalAction" checked={finalAction === 'delete'} onChange={() => setFinalAction('delete')} />
                Delete selected punch / record
              </label>
            </div>
            <div className="flex justify-end gap-3">
              <button onClick={() => setApproveDialog(null)} disabled={act.isPending} className="px-4 py-2 text-sm font-medium text-gray-600 bg-gray-100 rounded-xl hover:bg-gray-200 disabled:opacity-50">Cancel</button>
              <button onClick={() => act.mutate({ id: approveDialog.id, action: 'approved', finalAction })} disabled={act.isPending}
                className="px-5 py-2 text-sm font-medium text-white bg-emerald-600 rounded-xl hover:bg-emerald-700 disabled:opacity-50">{act.isPending ? 'Applying…' : 'Confirm'}</button>
            </div>
          </div>
        </div>
      )}

      {confirmDelete && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => !del.isPending && setConfirmDelete(null)}>
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-md p-6" onClick={e => e.stopPropagation()}>
            <div className="flex items-center gap-3 mb-2">
              <div className="w-10 h-10 rounded-full bg-red-50 flex items-center justify-center"><TrashIcon className="w-5 h-5 text-red-600" /></div>
              <h2 className="text-lg font-bold text-gray-900">Delete this request?</h2>
            </div>
            <p className="text-sm text-gray-500 mb-1">This permanently removes the pending {confirmDelete.punchTypeLabel} request. The employee's attendance and punch records are <b>not</b> changed.</p>
            <p className="text-xs text-gray-400 mb-5">{confirmDelete.employeeName ? `${confirmDelete.employeeName} · ` : ''}{confirmDelete.date}</p>
            <div className="flex justify-end gap-3">
              <button onClick={() => setConfirmDelete(null)} disabled={del.isPending} className="px-4 py-2 text-sm font-medium text-gray-600 bg-gray-100 rounded-xl hover:bg-gray-200 disabled:opacity-50">Cancel</button>
              <button onClick={() => del.mutate(confirmDelete.id)} disabled={del.isPending} className="px-5 py-2 text-sm font-medium text-white bg-red-600 rounded-xl hover:bg-red-700 disabled:opacity-50">{del.isPending ? 'Deleting…' : 'Delete'}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
