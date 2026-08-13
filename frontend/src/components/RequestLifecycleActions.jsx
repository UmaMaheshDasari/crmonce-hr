import { useState } from 'react';
import { useMutation, useQueryClient, useQuery } from '@tanstack/react-query';
import { requestLifecycleApi } from '../api/endpoints';
import { PencilSquareIcon, TrashIcon, ArrowPathIcon, XCircleIcon, ClockIcon, XMarkIcon } from '@heroicons/react/24/outline';
import { format } from 'date-fns';
import toast from 'react-hot-toast';

/**
 * Reusable Request Lifecycle actions for ANY request module. Renders the buttons
 * appropriate to the canonical status and drives the shared /api/requests engine
 * (permanent delete + confirmation, edit & resubmit, request cancellation, audit).
 *
 * Props:
 *   type      module key: 'leave' | 'late_login' | 'comp_off' | 'attendance_correction' | 'document'
 *   id        request id
 *   status    canonical status: pending | manager_approved | approved | rejected | cancelled
 *   caps      optional overrides { canEdit, canResubmit, canCancel } (defaults from status)
 *   onEdit    optional () => void — module opens its own edit form (pending)
 *   onChanged optional () => void — called after any successful action (refetch)
 *   invalidateKeys  optional array of react-query keys to invalidate after an action
 */
export default function RequestLifecycleActions({ type, id, status, caps = {}, onEdit, onChanged, invalidateKeys = [] }) {
  const qc = useQueryClient();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [modal, setModal] = useState(null);   // 'resubmit' | 'cancellation'
  const [reason, setReason] = useState('');
  const [showAudit, setShowAudit] = useState(false);

  const canDelete = caps.canDelete ?? ['pending', 'rejected'].includes(status);
  const canResubmit = caps.canResubmit ?? (status === 'rejected');
  const canCancel = caps.canCancel ?? ['approved', 'manager_approved'].includes(status);
  const canEdit = caps.canEdit ?? (status === 'pending' && !!onEdit);

  const done = (msg) => {
    toast.success(msg);
    setConfirmDelete(false); setModal(null); setReason('');
    qc.invalidateQueries({ queryKey: ['requests', type, id] });
    invalidateKeys.forEach(k => qc.invalidateQueries({ queryKey: k }));
    onChanged?.();
  };
  const fail = (e) => toast.error(e.response?.data?.error || 'Action failed');
  // Delete: show a legitimate business message (e.g. "an approved request cannot be
  // deleted") but NEVER surface a raw server/runtime error to the user — show a
  // friendly line for 5xx/unknown failures and keep the real error in the console (§8).
  const failDelete = (e) => {
    console.error('[request-lifecycle] delete failed:', e);   // real error preserved for debugging
    const status = e?.response?.status;
    const serverMsg = e?.response?.data?.error;
    toast.error(status && status < 500 && serverMsg ? serverMsg : 'Unable to delete the request. Please try again.');
  };

  const del = useMutation({ mutationFn: () => requestLifecycleApi.remove(type, id), onSuccess: () => done('Request deleted'), onError: failDelete });
  const resub = useMutation({ mutationFn: () => requestLifecycleApi.resubmit(type, id, reason ? { reason } : {}), onSuccess: () => done('Resubmitted for approval'), onError: fail });
  const cancelReq = useMutation({ mutationFn: () => requestLifecycleApi.requestCancellation(type, id, reason), onSuccess: () => done('Cancellation requested'), onError: fail });

  const btn = 'inline-flex items-center gap-1 px-2 py-1 text-xs font-semibold rounded-lg';

  return (
    <div className="flex items-center gap-1.5 justify-end flex-wrap">
      {canEdit && (
        <button onClick={onEdit} className={`${btn} text-indigo-700 bg-indigo-50 hover:bg-indigo-100`}><PencilSquareIcon className="w-3.5 h-3.5" /> Edit</button>
      )}
      {canResubmit && (
        <button onClick={() => { setReason(''); setModal('resubmit'); }} className={`${btn} text-blue-700 bg-blue-50 hover:bg-blue-100`}><ArrowPathIcon className="w-3.5 h-3.5" /> Edit &amp; Resubmit</button>
      )}
      {canDelete && (
        <button onClick={() => setConfirmDelete(true)} className={`${btn} text-red-700 bg-red-50 hover:bg-red-100`}><TrashIcon className="w-3.5 h-3.5" /> Delete</button>
      )}
      {canCancel && (
        <button onClick={() => { setReason(''); setModal('cancellation'); }} className={`${btn} text-orange-700 bg-orange-50 hover:bg-orange-100`}><XCircleIcon className="w-3.5 h-3.5" /> Request Cancellation</button>
      )}
      <button onClick={() => setShowAudit(true)} title="History" className={`${btn} text-gray-500 bg-gray-50 hover:bg-gray-100`}><ClockIcon className="w-3.5 h-3.5" /></button>

      {/* Delete confirmation */}
      {confirmDelete && (
        <Overlay onClose={() => setConfirmDelete(false)}>
          <h3 className="text-base font-bold text-gray-900">Delete this request?</h3>
          <p className="text-sm text-gray-500 mt-1">Are you sure you want to delete this request? This permanently removes it and cannot be undone.</p>
          <div className="flex justify-end gap-2 mt-5">
            <button onClick={() => setConfirmDelete(false)} className="px-4 py-2 text-sm font-medium text-gray-600 hover:text-gray-800">Cancel</button>
            <button onClick={() => del.mutate()} disabled={del.isPending} className="px-4 py-2 text-sm font-semibold text-white bg-red-600 rounded-lg hover:bg-red-700 disabled:opacity-50">{del.isPending ? 'Deleting…' : 'Delete'}</button>
          </div>
        </Overlay>
      )}

      {/* Resubmit / Cancellation reason modal */}
      {modal && (
        <Overlay onClose={() => setModal(null)}>
          <h3 className="text-base font-bold text-gray-900">{modal === 'resubmit' ? 'Edit & Resubmit' : 'Request Cancellation'}</h3>
          <p className="text-sm text-gray-500 mt-1">
            {modal === 'resubmit'
              ? 'Add an optional note and resubmit — this starts a fresh approval cycle while keeping the full history.'
              : 'Your cancellation goes to your manager and then HR for approval. On approval the request is reversed.'}
          </p>
          <textarea rows={3} value={reason} onChange={e => setReason(e.target.value)} placeholder={modal === 'resubmit' ? 'Note (optional)' : 'Reason for cancellation'}
            className="mt-3 w-full px-3 py-2 bg-gray-50 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20" />
          <div className="flex justify-end gap-2 mt-4">
            <button onClick={() => setModal(null)} className="px-4 py-2 text-sm font-medium text-gray-600">Cancel</button>
            {modal === 'resubmit' ? (
              <button onClick={() => resub.mutate()} disabled={resub.isPending} className="px-4 py-2 text-sm font-semibold text-white bg-blue-600 rounded-lg hover:bg-blue-700 disabled:opacity-50">{resub.isPending ? 'Resubmitting…' : 'Resubmit'}</button>
            ) : (
              <button onClick={() => cancelReq.mutate()} disabled={cancelReq.isPending || !reason.trim()} className="px-4 py-2 text-sm font-semibold text-white bg-orange-600 rounded-lg hover:bg-orange-700 disabled:opacity-50">{cancelReq.isPending ? 'Submitting…' : 'Submit Cancellation'}</button>
            )}
          </div>
        </Overlay>
      )}

      {showAudit && <AuditModal type={type} id={id} onClose={() => setShowAudit(false)} />}
    </div>
  );
}

function Overlay({ children, onClose }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4" onClick={onClose}>
      <div className="bg-white w-full max-w-sm rounded-2xl shadow-2xl p-6 text-left" onClick={e => e.stopPropagation()}>{children}</div>
    </div>
  );
}

const ACTION_LABEL = {
  edited: 'Edited', deleted: 'Deleted', resubmitted: 'Resubmitted',
  cancellation_requested: 'Cancellation requested', cancellation_approved: 'Cancellation approved', cancellation_rejected: 'Cancellation rejected',
};
function AuditModal({ type, id, onClose }) {
  const { data } = useQuery({ queryKey: ['request-audit', type, id], queryFn: () => requestLifecycleApi.audit(type, id).then(r => r.data) });
  const rows = data?.data || [];
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4" onClick={onClose}>
      <div className="bg-white w-full max-w-md rounded-2xl shadow-2xl text-left" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
          <h3 className="text-base font-bold text-gray-900">Request History</h3>
          <button onClick={onClose} className="p-1.5 text-gray-400 hover:bg-gray-100 rounded-lg"><XMarkIcon className="w-5 h-5" /></button>
        </div>
        <div className="p-5 max-h-[60vh] overflow-y-auto">
          {rows.length === 0 ? <p className="text-sm text-gray-400">No lifecycle actions recorded.</p> : (
            <ol className="space-y-3">
              {rows.map(r => (
                <li key={r.id} className="flex gap-3">
                  <span className="mt-1 w-2 h-2 rounded-full bg-indigo-400 flex-shrink-0" />
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-gray-800">{ACTION_LABEL[r.action] || r.action}</p>
                    <p className="text-xs text-gray-400">{r.performedBy || '—'}{r.at ? ` · ${safeDate(r.at)}` : ''}</p>
                    {r.detail && <p className="text-xs text-gray-500 mt-0.5">{r.detail}</p>}
                  </div>
                </li>
              ))}
            </ol>
          )}
        </div>
      </div>
    </div>
  );
}
const safeDate = (d) => { try { return format(new Date(d), 'dd-MM-yyyy, HH:mm'); } catch { return ''; } };
