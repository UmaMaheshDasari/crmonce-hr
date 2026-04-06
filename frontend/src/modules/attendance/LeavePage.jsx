import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { leaveApi, employeeApi } from '../../api/endpoints';
import { PlusIcon, CheckIcon, XMarkIcon, CalendarDaysIcon, ClockIcon, DocumentTextIcon } from '@heroicons/react/24/outline';
import { useAuth } from '../../context/AuthContext';
import { format, differenceInCalendarDays } from 'date-fns';
import toast from 'react-hot-toast';

const LEAVE_TYPES = ['Casual Leave', 'Sick Leave', 'Earned Leave', 'Maternity Leave', 'Paternity Leave', 'LOP'];

const LEAVE_TYPE_ICONS = {
  'Casual Leave': { emoji: '\ud83c\udfd6', color: 'bg-sky-50 text-sky-700 border-sky-200' },
  'Sick Leave': { emoji: '\ud83e\ude7a', color: 'bg-rose-50 text-rose-700 border-rose-200' },
  'Earned Leave': { emoji: '\u2b50', color: 'bg-amber-50 text-amber-700 border-amber-200' },
  'Maternity Leave': { emoji: '\ud83d\udc76', color: 'bg-pink-50 text-pink-700 border-pink-200' },
  'Paternity Leave': { emoji: '\ud83d\udc68\u200d\ud83d\udc76', color: 'bg-indigo-50 text-indigo-700 border-indigo-200' },
  'LOP': { emoji: '\u26a0\ufe0f', color: 'bg-gray-50 text-gray-700 border-gray-200' },
};

// Two-level status border colors
function getStatusBorderClass(leave) {
  const l1 = leave.hr_l1status;
  const l2 = leave.hr_l2status;
  const overall = leave.hr_status;

  if (overall === 'rejected' || l1 === 'rejected' || l2 === 'rejected') return 'border-l-red-500';
  if (overall === 'approved') return 'border-l-emerald-500';
  if (l1 === 'approved' && (l2 === 'pending_l2' || l2 === 'pending')) return 'border-l-blue-500';
  if (overall === 'cancelled') return 'border-l-gray-400';
  return 'border-l-amber-400'; // default pending
}

const STATUS_DOT = {
  pending: 'bg-amber-400',
  approved: 'bg-emerald-500',
  rejected: 'bg-red-500',
  cancelled: 'bg-gray-400',
};

const STATUS_TEXT = {
  pending: 'text-amber-700',
  approved: 'text-emerald-700',
  rejected: 'text-red-700',
  cancelled: 'text-gray-500',
};

// -- Approval Timeline Stepper --
function ApprovalTimeline({ leave }) {
  const l1 = leave.hr_l1status || 'pending';
  const l2 = leave.hr_l2status || 'not_required';

  const stepColor = (status) => {
    if (status === 'approved') return 'bg-emerald-500';
    if (status === 'rejected') return 'bg-red-500';
    if (status === 'pending_l2') return 'bg-amber-400';
    if (status === 'pending') return 'bg-gray-300';
    return 'bg-gray-200'; // not_required
  };

  const stepRing = (status) => {
    if (status === 'approved') return 'ring-emerald-200';
    if (status === 'rejected') return 'ring-red-200';
    if (status === 'pending_l2') return 'ring-amber-200';
    if (status === 'pending') return 'ring-gray-200';
    return 'ring-gray-100';
  };

  const stepLabel = (status) => {
    if (status === 'approved') return 'Approved';
    if (status === 'rejected') return 'Rejected';
    if (status === 'pending_l2') return 'Waiting';
    if (status === 'pending') return 'Pending';
    if (status === 'not_required') return 'N/A';
    return status;
  };

  const stepTextColor = (status) => {
    if (status === 'approved') return 'text-emerald-700';
    if (status === 'rejected') return 'text-red-700';
    if (status === 'pending_l2') return 'text-amber-700';
    if (status === 'pending') return 'text-gray-500';
    return 'text-gray-400';
  };

  const lineColor = l1 === 'approved' ? 'bg-emerald-300' : l1 === 'rejected' ? 'bg-red-300' : 'bg-gray-200';

  return (
    <div className="mt-3 pt-3 border-t border-gray-100">
      <div className="flex items-start gap-0">
        {/* Step 1: L1 Manager */}
        <div className="flex flex-col items-center min-w-0" style={{ width: '120px' }}>
          <div className={`w-3.5 h-3.5 rounded-full ring-4 ${stepColor(l1)} ${stepRing(l1)}`} />
          <p className="text-[11px] font-semibold text-gray-700 mt-1.5 leading-tight text-center">L1 - Manager</p>
          <p className={`text-[10px] font-medium mt-0.5 ${stepTextColor(l1)}`}>{stepLabel(l1)}</p>
          {leave.hr_l1approver_name && (
            <p className="text-[10px] text-gray-400 mt-0.5 truncate max-w-full text-center">{leave.hr_l1approver_name}</p>
          )}
          {leave.hr_l1date && (
            <p className="text-[10px] text-gray-300">{format(new Date(leave.hr_l1date), 'dd MMM')}</p>
          )}
          {leave.hr_l1remarks && (
            <p className="text-[10px] text-gray-400 italic truncate max-w-full text-center" title={leave.hr_l1remarks}>"{leave.hr_l1remarks}"</p>
          )}
        </div>

        {/* Connecting line */}
        <div className="flex-1 flex items-center pt-1.5">
          <div className={`h-0.5 w-full rounded ${lineColor}`} />
        </div>

        {/* Step 2: L2 Senior Manager */}
        <div className="flex flex-col items-center min-w-0" style={{ width: '140px' }}>
          <div className={`w-3.5 h-3.5 rounded-full ring-4 ${stepColor(l2)} ${stepRing(l2)}`} />
          <p className="text-[11px] font-semibold text-gray-700 mt-1.5 leading-tight text-center">L2 - Senior Manager</p>
          <p className={`text-[10px] font-medium mt-0.5 ${stepTextColor(l2)}`}>{stepLabel(l2)}</p>
          {leave.hr_l2approver_name && (
            <p className="text-[10px] text-gray-400 mt-0.5 truncate max-w-full text-center">{leave.hr_l2approver_name}</p>
          )}
          {leave.hr_l2date && (
            <p className="text-[10px] text-gray-300">{format(new Date(leave.hr_l2date), 'dd MMM')}</p>
          )}
          {leave.hr_l2remarks && (
            <p className="text-[10px] text-gray-400 italic truncate max-w-full text-center" title={leave.hr_l2remarks}>"{leave.hr_l2remarks}"</p>
          )}
        </div>
      </div>
    </div>
  );
}

// -- Remarks Confirmation Dialog --
function RemarksDialog({ title, actionLabel, actionColor, onConfirm, onCancel, isLoading }) {
  const [remarks, setRemarks] = useState('');

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-sm overflow-hidden">
        <div className="px-5 py-4 border-b border-gray-100">
          <h3 className="text-sm font-bold text-gray-900">{title}</h3>
        </div>
        <div className="p-5">
          <label className="block text-xs font-semibold text-gray-600 mb-1.5">Remarks (optional)</label>
          <textarea
            className="w-full px-3 py-2.5 bg-gray-50 border border-gray-200 rounded-xl text-sm text-gray-700 placeholder-gray-400 h-20 resize-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-400 outline-none transition-all"
            placeholder="Add any remarks..."
            value={remarks}
            onChange={e => setRemarks(e.target.value)}
            autoFocus
          />
        </div>
        <div className="px-5 py-3 border-t border-gray-100 bg-gray-50/50 flex gap-2">
          <button
            onClick={onCancel}
            disabled={isLoading}
            className="flex-1 px-4 py-2 text-sm font-semibold text-gray-700 bg-white border border-gray-200 rounded-xl hover:bg-gray-50 transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={() => onConfirm(remarks)}
            disabled={isLoading}
            className={`flex-1 px-4 py-2 text-sm font-semibold text-white rounded-xl shadow-sm flex items-center justify-center gap-2 transition-all disabled:opacity-50 ${actionColor}`}
          >
            {isLoading && <div className="w-3.5 h-3.5 border-2 border-white border-t-transparent rounded-full animate-spin" />}
            {actionLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

// -- Leave Card Action Buttons --
function LeaveActions({ leave, user, isHR }) {
  const qc = useQueryClient();
  const [remarksAction, setRemarksAction] = useState(null); // { type: 'l1_approve' | 'l1_reject' | 'l2_approve' | 'l2_reject' | 'hr_approve' | 'hr_reject' }

  const l1Mutation = useMutation({
    mutationFn: ({ id, action, remarks }) => leaveApi.approveL1(id, action, remarks),
    onSuccess: (_, vars) => {
      toast.success(`L1 ${vars.action === 'approved' ? 'Approved' : 'Rejected'}`);
      qc.invalidateQueries(['leaves']);
      qc.invalidateQueries(['pendingApprovals']);
    },
    onError: () => toast.error('L1 action failed'),
  });

  const l2Mutation = useMutation({
    mutationFn: ({ id, action, remarks }) => leaveApi.approveL2(id, action, remarks),
    onSuccess: (_, vars) => {
      toast.success(`L2 ${vars.action === 'approved' ? 'Approved' : 'Rejected'}`);
      qc.invalidateQueries(['leaves']);
      qc.invalidateQueries(['pendingApprovals']);
    },
    onError: () => toast.error('L2 action failed'),
  });

  const hrMutation = useMutation({
    mutationFn: ({ id, status, remarks }) => leaveApi.approve(id, status, remarks),
    onSuccess: (_, vars) => {
      toast.success(`Leave ${vars.status}`);
      qc.invalidateQueries(['leaves']);
      qc.invalidateQueries(['pendingApprovals']);
    },
    onError: () => toast.error('Action failed'),
  });

  const handleConfirm = (remarks) => {
    const id = leave.hr_hrleaveid;
    switch (remarksAction?.type) {
      case 'l1_approve':
        l1Mutation.mutate({ id, action: 'approved', remarks });
        break;
      case 'l1_reject':
        l1Mutation.mutate({ id, action: 'rejected', remarks });
        break;
      case 'l2_approve':
        l2Mutation.mutate({ id, action: 'approved', remarks });
        break;
      case 'l2_reject':
        l2Mutation.mutate({ id, action: 'rejected', remarks });
        break;
      case 'hr_approve':
        hrMutation.mutate({ id, status: 'approved', remarks });
        break;
      case 'hr_reject':
        hrMutation.mutate({ id, status: 'rejected', remarks });
        break;
      default:
        break;
    }
    setRemarksAction(null);
  };

  const isAnyLoading = l1Mutation.isLoading || l2Mutation.isLoading || hrMutation.isLoading;
  const l1 = leave.hr_l1status;
  const l2 = leave.hr_l2status;
  const isSuperAdmin = user?.role === 'super_admin';

  const buttons = [];

  // L1 buttons: show when L1 is pending
  if (l1 === 'pending') {
    buttons.push(
      <button
        key="l1-approve"
        onClick={() => setRemarksAction({ type: 'l1_approve' })}
        disabled={isAnyLoading}
        className="inline-flex items-center gap-1.5 px-3.5 py-1.5 bg-white text-emerald-700 border-2 border-emerald-200 rounded-xl text-xs font-semibold hover:bg-emerald-50 hover:border-emerald-300 active:scale-95 transition-all duration-150 disabled:opacity-50"
      >
        <CheckIcon className="w-3.5 h-3.5" /> Approve (L1)
      </button>
    );
    buttons.push(
      <button
        key="l1-reject"
        onClick={() => setRemarksAction({ type: 'l1_reject' })}
        disabled={isAnyLoading}
        className="inline-flex items-center gap-1.5 px-3.5 py-1.5 bg-white text-red-700 border-2 border-red-200 rounded-xl text-xs font-semibold hover:bg-red-50 hover:border-red-300 active:scale-95 transition-all duration-150 disabled:opacity-50"
      >
        <XMarkIcon className="w-3.5 h-3.5" /> Reject (L1)
      </button>
    );
  }

  // L2 buttons: show when L2 is pending
  if (l2 === 'pending_l2') {
    buttons.push(
      <button
        key="l2-approve"
        onClick={() => setRemarksAction({ type: 'l2_approve' })}
        disabled={isAnyLoading}
        className="inline-flex items-center gap-1.5 px-3.5 py-1.5 bg-white text-blue-700 border-2 border-blue-200 rounded-xl text-xs font-semibold hover:bg-blue-50 hover:border-blue-300 active:scale-95 transition-all duration-150 disabled:opacity-50"
      >
        <CheckIcon className="w-3.5 h-3.5" /> Approve (L2)
      </button>
    );
    buttons.push(
      <button
        key="l2-reject"
        onClick={() => setRemarksAction({ type: 'l2_reject' })}
        disabled={isAnyLoading}
        className="inline-flex items-center gap-1.5 px-3.5 py-1.5 bg-white text-red-700 border-2 border-red-200 rounded-xl text-xs font-semibold hover:bg-red-50 hover:border-red-300 active:scale-95 transition-all duration-150 disabled:opacity-50"
      >
        <XMarkIcon className="w-3.5 h-3.5" /> Reject (L2)
      </button>
    );
  }

  // HR / super_admin override buttons (existing behavior)
  if ((isHR() || isSuperAdmin) && leave.hr_status !== 'approved' && leave.hr_status !== 'rejected' && leave.hr_status !== 'cancelled') {
    buttons.push(
      <button
        key="hr-approve"
        onClick={() => setRemarksAction({ type: 'hr_approve' })}
        disabled={isAnyLoading}
        className="inline-flex items-center gap-1.5 px-3.5 py-1.5 bg-emerald-600 text-white rounded-xl text-xs font-semibold hover:bg-emerald-700 active:scale-95 transition-all duration-150 shadow-sm disabled:opacity-50"
      >
        <CheckIcon className="w-3.5 h-3.5" /> Approve
      </button>
    );
    buttons.push(
      <button
        key="hr-reject"
        onClick={() => setRemarksAction({ type: 'hr_reject' })}
        disabled={isAnyLoading}
        className="inline-flex items-center gap-1.5 px-3.5 py-1.5 bg-red-600 text-white rounded-xl text-xs font-semibold hover:bg-red-700 active:scale-95 transition-all duration-150 shadow-sm disabled:opacity-50"
      >
        <XMarkIcon className="w-3.5 h-3.5" /> Reject
      </button>
    );
  }

  if (buttons.length === 0) return null;

  const remarksTitle = remarksAction
    ? {
        l1_approve: 'Approve Leave (L1)',
        l1_reject: 'Reject Leave (L1)',
        l2_approve: 'Approve Leave (L2)',
        l2_reject: 'Reject Leave (L2)',
        hr_approve: 'Approve Leave (HR Override)',
        hr_reject: 'Reject Leave (HR Override)',
      }[remarksAction.type]
    : '';

  const remarksActionLabel = remarksAction?.type?.includes('approve') ? 'Confirm Approve' : 'Confirm Reject';
  const remarksActionColor = remarksAction?.type?.includes('approve') ? 'bg-emerald-600 hover:bg-emerald-700' : 'bg-red-600 hover:bg-red-700';

  return (
    <>
      <div className="flex gap-2 flex-shrink-0 flex-wrap justify-end pt-1">
        {buttons}
      </div>
      {remarksAction && (
        <RemarksDialog
          title={remarksTitle}
          actionLabel={remarksActionLabel}
          actionColor={remarksActionColor}
          onConfirm={handleConfirm}
          onCancel={() => setRemarksAction(null)}
          isLoading={isAnyLoading}
        />
      )}
    </>
  );
}

function ApplyLeaveModal({ onClose }) {
  const qc = useQueryClient();
  const { user } = useAuth();
  const [form, setForm] = useState({ type: 'Casual Leave', from: '', to: '', reason: '' });

  const mutation = useMutation({
    mutationFn: () => leaveApi.apply({
      'hr_employee@odata.bind': `/hr_employees(${user.id})`,
      hr_leavetype: form.type,
      hr_fromdate: form.from,
      hr_todate: form.to,
      hr_reason: form.reason,
      hr_days: differenceInCalendarDays(new Date(form.to), new Date(form.from)) + 1,
      hr_status: 'pending',
    }),
    onSuccess: () => { toast.success('Leave applied!'); qc.invalidateQueries(['leaves']); onClose(); },
    onError: () => toast.error('Failed to apply leave'),
  });

  const days = form.from && form.to ? differenceInCalendarDays(new Date(form.to), new Date(form.from)) + 1 : 0;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg overflow-hidden">
        {/* Modal Header */}
        <div className="px-6 py-5 border-b border-gray-100 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-indigo-100 rounded-xl flex items-center justify-center">
              <DocumentTextIcon className="w-5 h-5 text-indigo-600" />
            </div>
            <div>
              <h2 className="text-lg font-bold text-gray-900">Apply for Leave</h2>
              <p className="text-xs text-gray-500 mt-0.5">Fill in the details below</p>
            </div>
          </div>
          <button onClick={onClose} className="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-gray-100 text-gray-400 hover:text-gray-600 transition-colors">
            <XMarkIcon className="w-5 h-5" />
          </button>
        </div>

        <div className="p-6 space-y-5">
          {/* Leave Type Visual Selector */}
          <div>
            <label className="block text-sm font-semibold text-gray-700 mb-2.5">Leave Type</label>
            <div className="grid grid-cols-3 gap-2">
              {LEAVE_TYPES.map(t => {
                const cfg = LEAVE_TYPE_ICONS[t] || LEAVE_TYPE_ICONS['LOP'];
                const isSelected = form.type === t;
                return (
                  <button
                    key={t}
                    type="button"
                    onClick={() => setForm(p => ({ ...p, type: t }))}
                    className={`flex flex-col items-center gap-1 px-3 py-3 rounded-xl border-2 text-xs font-medium transition-all duration-150 ${
                      isSelected
                        ? 'border-indigo-500 bg-indigo-50 text-indigo-700 shadow-sm ring-2 ring-indigo-500/20'
                        : 'border-gray-150 bg-white text-gray-600 hover:border-gray-300 hover:bg-gray-50'
                    }`}
                  >
                    <span className="text-base">{cfg.emoji}</span>
                    <span className="leading-tight text-center">{t}</span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Date Range Side by Side */}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-semibold text-gray-700 mb-1.5">From Date</label>
              <div className="relative">
                <CalendarDaysIcon className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400 pointer-events-none" />
                <input type="date" className="w-full pl-9 pr-3 py-2.5 bg-gray-50 border border-gray-200 rounded-xl text-sm text-gray-700 focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-400 outline-none transition-all" value={form.from} onChange={e => setForm(p => ({ ...p, from: e.target.value }))} />
              </div>
            </div>
            <div>
              <label className="block text-sm font-semibold text-gray-700 mb-1.5">To Date</label>
              <div className="relative">
                <CalendarDaysIcon className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400 pointer-events-none" />
                <input type="date" className="w-full pl-9 pr-3 py-2.5 bg-gray-50 border border-gray-200 rounded-xl text-sm text-gray-700 focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-400 outline-none transition-all" value={form.to} min={form.from} onChange={e => setForm(p => ({ ...p, to: e.target.value }))} />
              </div>
            </div>
          </div>

          {/* Days Badge */}
          {days > 0 && (
            <div className="flex items-center justify-center">
              <div className="inline-flex items-center gap-3 bg-gradient-to-r from-indigo-50 to-violet-50 border border-indigo-100 rounded-2xl px-6 py-3">
                <div className="w-11 h-11 bg-indigo-600 text-white rounded-full flex items-center justify-center text-lg font-bold shadow-md shadow-indigo-200">
                  {days}
                </div>
                <div>
                  <p className="text-sm font-bold text-indigo-900">day{days > 1 ? 's' : ''} of leave</p>
                  <p className="text-xs text-indigo-500">{form.from && format(new Date(form.from), 'dd MMM')} - {form.to && format(new Date(form.to), 'dd MMM yyyy')}</p>
                </div>
              </div>
            </div>
          )}

          {/* Reason */}
          <div>
            <label className="block text-sm font-semibold text-gray-700 mb-1.5">Reason</label>
            <textarea
              className="w-full px-4 py-3 bg-gray-50 border border-gray-200 rounded-xl text-sm text-gray-700 placeholder-gray-400 h-20 resize-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-400 outline-none transition-all"
              placeholder="Brief reason for leave..."
              value={form.reason}
              onChange={e => setForm(p => ({ ...p, reason: e.target.value }))}
            />
          </div>
        </div>

        {/* Modal Footer */}
        <div className="px-6 py-4 border-t border-gray-100 bg-gray-50/50 flex gap-3">
          <button onClick={onClose} className="flex-1 px-4 py-2.5 text-sm font-semibold text-gray-700 bg-white border border-gray-200 rounded-xl hover:bg-gray-50 transition-colors">
            Cancel
          </button>
          <button
            onClick={() => mutation.mutate()}
            disabled={!form.from || !form.to || mutation.isLoading}
            className="flex-1 px-4 py-2.5 text-sm font-semibold text-white bg-indigo-600 rounded-xl shadow-md shadow-indigo-200 hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2 transition-all"
          >
            {mutation.isLoading && <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />}
            Submit Application
          </button>
        </div>
      </div>
    </div>
  );
}

// -- Overall status label for display --
function getOverallStatusLabel(leave) {
  const l1 = leave.hr_l1status;
  const l2 = leave.hr_l2status;
  const overall = leave.hr_status;

  if (overall === 'rejected' || l1 === 'rejected' || l2 === 'rejected') return { label: 'Rejected', dot: 'bg-red-500', text: 'text-red-700' };
  if (overall === 'approved') return { label: 'Approved', dot: 'bg-emerald-500', text: 'text-emerald-700' };
  if (overall === 'cancelled') return { label: 'Cancelled', dot: 'bg-gray-400', text: 'text-gray-500' };
  if (l1 === 'approved' && (l2 === 'pending_l2' || l2 === 'pending')) return { label: 'L2 Pending', dot: 'bg-blue-500', text: 'text-blue-700' };
  if (l1 === 'pending') return { label: 'L1 Pending', dot: 'bg-amber-400', text: 'text-amber-700' };
  return { label: overall?.charAt(0).toUpperCase() + overall?.slice(1), dot: STATUS_DOT[overall] || 'bg-gray-400', text: STATUS_TEXT[overall] || 'text-gray-500' };
}

export default function LeavePage() {
  const { isHR, user } = useAuth();
  const qc = useQueryClient();
  const [showModal, setShowModal] = useState(false);
  const [filter, setFilter] = useState('pending');

  // Standard leave list query
  const { data, isLoading } = useQuery({
    queryKey: ['leaves', filter],
    queryFn: () => {
      if (filter === 'my_approvals') {
        return leaveApi.pendingApprovals();
      }
      return leaveApi.list({ status: filter || undefined });
    },
  });

  const leaves = data?.data?.data || [];

  const tabs = [
    { key: '', label: 'All', count: null },
    { key: 'pending', label: 'Pending', count: null },
    { key: 'approved', label: 'Approved', count: null },
    { key: 'rejected', label: 'Rejected', count: null },
    { key: 'my_approvals', label: 'Pending My Approval', count: null },
  ];

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 tracking-tight">Leave Management</h1>
          <p className="text-sm text-gray-500 mt-1">{leaves.length} requests</p>
        </div>
        <button
          onClick={() => setShowModal(true)}
          className="inline-flex items-center gap-2 px-5 py-2.5 bg-indigo-600 text-white text-sm font-semibold rounded-xl shadow-md shadow-indigo-200 hover:bg-indigo-700 hover:shadow-lg hover:shadow-indigo-200 transition-all duration-200"
        >
          <PlusIcon className="w-4.5 h-4.5" /> Apply Leave
        </button>
      </div>

      {/* Pill-style Status Tabs */}
      <div className="inline-flex bg-gray-100/80 p-1 rounded-xl gap-0.5 flex-wrap">
        {tabs.map(t => (
          <button
            key={t.key}
            onClick={() => setFilter(t.key)}
            className={`px-5 py-2 rounded-lg text-sm font-semibold transition-all duration-200 whitespace-nowrap ${
              filter === t.key
                ? 'bg-white text-gray-900 shadow-sm'
                : 'text-gray-500 hover:text-gray-700 hover:bg-white/50'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Leave Cards */}
      <div className="space-y-3">
        {isLoading ? (
          Array(4).fill(0).map((_, i) => (
            <div key={i} className="bg-white rounded-xl border border-gray-100 h-28 animate-pulse">
              <div className="p-5 space-y-3">
                <div className="h-4 bg-gray-100 rounded w-1/3" />
                <div className="h-3 bg-gray-100 rounded w-1/2" />
                <div className="h-3 bg-gray-50 rounded w-1/4" />
              </div>
            </div>
          ))
        ) : leaves.length === 0 ? (
          <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-16 text-center">
            <CalendarDaysIcon className="w-12 h-12 text-gray-300 mx-auto mb-3" />
            <p className="text-sm font-medium text-gray-400">No leave requests found</p>
            <p className="text-xs text-gray-300 mt-1">Try adjusting your filters</p>
          </div>
        ) : (
          leaves.map(leave => {
            const statusBorder = getStatusBorderClass(leave);
            const statusInfo = getOverallStatusLabel(leave);
            const typeConfig = LEAVE_TYPE_ICONS[leave.hr_leavetype] || LEAVE_TYPE_ICONS['LOP'];
            return (
              <div key={leave.hr_hrleaveid} className={`bg-white rounded-xl border border-gray-100 border-l-4 ${statusBorder} shadow-sm hover:shadow-md transition-all duration-200`}>
                <div className="p-5">
                  <div className="flex items-start justify-between gap-4">
                    <div className="flex-1 min-w-0">
                      {/* Top row: Name + Status */}
                      <div className="flex items-center gap-3 flex-wrap">
                        {isHR() && (
                          <h3 className="text-base font-bold text-gray-900">
                            {leave['_hr_employee_value@OData.Community.Display.V1.FormattedValue'] || 'Employee'}
                          </h3>
                        )}
                        <span className={`inline-flex items-center gap-1 text-xs font-medium border px-2.5 py-0.5 rounded-full ${typeConfig.color}`}>
                          <span className="text-xs">{typeConfig.emoji}</span> {leave.hr_leavetype}
                        </span>
                        <span className={`inline-flex items-center gap-1.5 text-xs font-semibold ${statusInfo.text}`}>
                          <span className={`w-2 h-2 rounded-full ${statusInfo.dot}`} />
                          {statusInfo.label}
                        </span>
                      </div>

                      {/* Date range with calendar icon */}
                      <div className="flex items-center gap-4 mt-3">
                        <div className="inline-flex items-center gap-2 text-sm text-gray-600">
                          <CalendarDaysIcon className="w-4 h-4 text-gray-400 flex-shrink-0" />
                          <span className="font-medium">
                            {leave.hr_fromdate ? format(new Date(leave.hr_fromdate), 'dd MMM yyyy') : '\u2014'}
                          </span>
                          <span className="text-gray-300">\u2192</span>
                          <span className="font-medium">
                            {leave.hr_todate ? format(new Date(leave.hr_todate), 'dd MMM yyyy') : '\u2014'}
                          </span>
                        </div>
                        {/* Days circle badge */}
                        <div className="flex items-center gap-1.5">
                          <span className="inline-flex items-center justify-center w-7 h-7 bg-indigo-100 text-indigo-700 rounded-full text-xs font-bold">
                            {leave.hr_days}
                          </span>
                          <span className="text-xs text-gray-400 font-medium">day{leave.hr_days > 1 ? 's' : ''}</span>
                        </div>
                      </div>

                      {/* Reason */}
                      {leave.hr_reason && (
                        <p className="text-sm text-gray-400 mt-2 italic leading-relaxed">"{leave.hr_reason}"</p>
                      )}

                      {/* Approval Timeline Stepper */}
                      <ApprovalTimeline leave={leave} />
                    </div>

                    {/* Approve / Reject actions */}
                    <LeaveActions leave={leave} user={user} isHR={isHR} />
                  </div>
                </div>
              </div>
            );
          })
        )}
      </div>

      {showModal && <ApplyLeaveModal onClose={() => setShowModal(false)} />}
    </div>
  );
}
