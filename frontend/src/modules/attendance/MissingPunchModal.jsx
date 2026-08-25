import { useState, useEffect } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { XMarkIcon } from '@heroicons/react/24/outline';
import toast from 'react-hot-toast';
import { attendanceRequestApi, requestLifecycleApi, attendanceApi } from '../../api/endpoints';
import { useAuth } from '../../context/AuthContext';
import Button from '../../components/Button';

const CORRECTION_TYPES = [
  { value: 'missing_check_in', label: 'Missing Check In' },
  { value: 'missing_check_out', label: 'Missing Check Out' },
  { value: 'missed_break_out', label: 'Missed Break Out' },
  { value: 'missed_break_in', label: 'Missed Break In' },
  { value: 'device_failure', label: 'Device Failure' },
  { value: 'web_checkin_issue', label: 'Web Check-in Issue' },
  { value: 'other', label: 'Other' },
];

const toMin = (t) => { const m = String(t || '').match(/(\d{1,2}):(\d{2})/); return m ? (+m[1]) * 60 + (+m[2]) : null; };
const durLabel = (mins) => `${Math.floor(Math.abs(mins) / 60)}h ${String(Math.abs(mins) % 60).padStart(2, '0')}m`;

// Three request kinds share this modal:
//  • Attendance Correction — fix a PAST punch (inserts a punch, recomputes the day).
//  • Hour Adjustment — HR-approved hours that reduce ONLY that day's required hours.
//  • Early Logout — permitted early leave; the granted hours (shift end − requested
//    logout) reduce ONLY that day's required hours. Both grant hours (no punch change,
//    not a deduction) and are approved by HR before they affect the monthly balance.
export default function MissingPunchModal({ open, onClose, defaultDate, defaultType, editRecord, defaultKind, lockKind }) {
  const { user } = useAuth();
  const qc = useQueryClient();
  const isEdit = !!editRecord;
  // lockKind forces a single kind and HIDES the toggle (Early Logout has its own page,
  // so it is never mixed with Attendance Corrections / Hour Adjustments in one tab).
  const [mode, setMode] = useState(lockKind || 'correction');   // 'correction' | 'adjustment' | 'early_logout'
  const [form, setForm] = useState({ attendanceDate: '', punchType: 'missing_check_out', requestedTime: '', adjustmentHours: '', reason: '' });
  const isAdjust = mode === 'adjustment';
  const isEarly = mode === 'early_logout';

  // Employee shift (for the live Early Logout preview). The server recomputes the
  // authoritative value date-aware; this is an estimate from the current shift.
  const { data: statusRes } = useQuery({ queryKey: ['attendance-my-status'], queryFn: () => attendanceApi.myStatus(), enabled: open && isEarly });
  const shiftEnd = statusRes?.data?.shift?.end || '';

  useEffect(() => {
    if (!open) return;
    if (editRecord) {
      const t = editRecord.punchType;
      setMode(t === 'hour_adjustment' ? 'adjustment' : t === 'early_logout' ? 'early_logout' : 'correction');
      setForm({
        attendanceDate: editRecord.date || '',
        punchType: editRecord.punchType || 'missing_check_out',
        requestedTime: editRecord.requestedTime || '',
        adjustmentHours: t === 'hour_adjustment' ? String(editRecord.adjustmentHours ?? '') : '',
        reason: editRecord.reason || '',
      });
    } else {
      setMode(lockKind || defaultKind || 'correction');   // locked kind (own page) or default
      setForm(f => ({
        ...f,
        attendanceDate: defaultDate || f.attendanceDate || new Date().toISOString().slice(0, 10),
        punchType: defaultType || 'missing_check_out',
        requestedTime: '', adjustmentHours: '',
      }));
    }
  }, [open, defaultDate, defaultType, editRecord, defaultKind, lockKind]);

  // Live Early Logout hours = shift end − requested logout (positive = valid).
  const elMinutes = (isEarly && shiftEnd && form.requestedTime) ? (toMin(shiftEnd) - toMin(form.requestedTime)) : null;
  const elValid = elMinutes != null && elMinutes > 0;

  const kindPunchType = isAdjust ? 'hour_adjustment' : isEarly ? 'early_logout' : form.punchType;
  const baseFields = () => isAdjust
    ? { punchType: 'hour_adjustment', adjustmentHours: Number(form.adjustmentHours), reason: form.reason }
    : { punchType: kindPunchType, requestedTime: form.requestedTime, reason: form.reason };
  const createPayload = () => ({ attendanceDate: form.attendanceDate, ...baseFields() });
  const editPayload = () => ({ date: form.attendanceDate, ...baseFields() });

  const submit = useMutation({
    mutationFn: () => isEdit
      ? requestLifecycleApi.edit('attendance_correction', editRecord.id, editPayload())
      : attendanceRequestApi.submit(createPayload()),
    onSuccess: () => {
      toast.success(isEdit ? 'Request updated' : `${isAdjust ? 'Hour adjustment' : isEarly ? 'Early logout' : 'Attendance correction'} request submitted for approval`);
      qc.invalidateQueries({ queryKey: ['attendance-requests'] });
      onClose();
      if (!isEdit) setForm(f => ({ ...f, requestedTime: '', adjustmentHours: '', reason: '' }));
    },
    onError: (e) => toast.error(e.response?.data?.error || 'Could not submit request'),
  });

  if (!open) return null;
  const set = (k) => (e) => setForm(f => ({ ...f, [k]: e.target.value }));
  const canSubmit = form.attendanceDate && form.reason.trim() && (
    isAdjust ? (Number(form.adjustmentHours) > 0)
      : isEarly ? (form.requestedTime && elValid)
        : (form.punchType && form.requestedTime)
  );
  const title = isEdit ? 'Edit Request' : isAdjust ? 'Request Hour Adjustment' : isEarly ? 'Request Early Logout' : 'Request Attendance Correction';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div className="bg-white rounded-2xl w-full max-w-lg shadow-xl" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
          <h3 className="text-base font-bold text-gray-900">{title}</h3>
          <button onClick={onClose} className="p-1 rounded-lg hover:bg-gray-100"><XMarkIcon className="w-5 h-5 text-gray-500" /></button>
        </div>
        <div className="p-5 space-y-3.5">
          {/* Request-kind toggle — Correction vs Hour Adjustment only. Early Logout has
              its OWN page (lockKind), so it never appears here / is never merged in. */}
          {!isEdit && !lockKind && (
            <div className="grid grid-cols-2 gap-2 p-1 bg-gray-100 rounded-xl">
              {[['correction', 'Correction'], ['adjustment', 'Hour Adjustment']].map(([val, label]) => (
                <button key={val} type="button" onClick={() => setMode(val)}
                  className={`py-2 text-xs font-semibold rounded-lg transition-all ${mode === val ? 'bg-white shadow text-indigo-700' : 'text-gray-500 hover:text-gray-700'}`}>
                  {label}
                </button>
              ))}
            </div>
          )}

          <div>
            <label className="block text-xs font-medium text-gray-500 mb-1">Employee</label>
            <input type="text" value={user?.name || ''} disabled
              className="w-full px-3 py-2 bg-gray-100 border border-gray-200 rounded-lg text-sm text-gray-600 cursor-not-allowed" />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">Attendance Date</label>
              <input type="date" max={new Date().toISOString().slice(0, 10)} value={form.attendanceDate} onChange={set('attendanceDate')}
                className="w-full px-3 py-2 bg-gray-50 border border-gray-200 rounded-lg text-sm outline-none focus:ring-2 focus:ring-indigo-500/20" />
            </div>
            {isAdjust ? (
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">Adjustment Hours <span className="text-red-500">*</span></label>
                <input type="number" min="0.5" step="0.5" value={form.adjustmentHours} onChange={set('adjustmentHours')} placeholder="e.g. 3"
                  className="w-full px-3 py-2 bg-gray-50 border border-gray-200 rounded-lg text-sm outline-none focus:ring-2 focus:ring-indigo-500/20" />
              </div>
            ) : isEarly ? (
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">Requested Logout <span className="text-red-500">*</span></label>
                <input type="time" value={form.requestedTime} onChange={set('requestedTime')}
                  className="w-full px-3 py-2 bg-gray-50 border border-gray-200 rounded-lg text-sm outline-none focus:ring-2 focus:ring-indigo-500/20" />
              </div>
            ) : (
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">Correct Time <span className="text-red-500">*</span></label>
                <input type="time" value={form.requestedTime} onChange={set('requestedTime')}
                  className="w-full px-3 py-2 bg-gray-50 border border-gray-200 rounded-lg text-sm outline-none focus:ring-2 focus:ring-indigo-500/20" />
              </div>
            )}
          </div>

          {/* Mode-specific helper / auto-calculated hours */}
          {isAdjust && (
            <p className="text-[11px] text-gray-400">
              Approved hours reduce only this day's required working hours (9h − adjustment). It is not a salary deduction and does not change punches.
            </p>
          )}
          {isEarly && (
            <div className="rounded-lg bg-gray-50 border border-gray-100 px-3 py-2.5 text-xs">
              <div className="flex items-center justify-between">
                <span className="text-gray-500">Scheduled Shift End</span>
                <span className="font-semibold text-gray-800 tabular-nums">{shiftEnd || '—'}</span>
              </div>
              <div className="flex items-center justify-between mt-1.5">
                <span className="text-gray-500">Early Logout (auto)</span>
                <span className={`font-bold tabular-nums ${elMinutes == null ? 'text-gray-400' : elValid ? 'text-violet-700' : 'text-red-600'}`}>
                  {elMinutes == null ? '—' : elValid ? durLabel(elMinutes) : 'Must be before shift end'}
                </span>
              </div>
              <p className="text-[11px] text-gray-400 mt-2">Approved hours reduce only this day's required hours; actual worked hours are unchanged, and it is not a salary deduction.</p>
            </div>
          )}
          {!isAdjust && !isEarly && (
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">Correction Type</label>
              <select value={form.punchType} onChange={set('punchType')}
                className="w-full px-3 py-2 bg-gray-50 border border-gray-200 rounded-lg text-sm outline-none focus:ring-2 focus:ring-indigo-500/20 cursor-pointer">
                {CORRECTION_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
              </select>
            </div>
          )}

          <div>
            <label className="block text-xs font-medium text-gray-500 mb-1">Reason <span className="text-red-500">*</span></label>
            <textarea rows={3} value={form.reason} onChange={set('reason')}
              placeholder={isAdjust ? 'Why the hours are being adjusted, e.g. Client meeting offsite in the morning.'
                : isEarly ? 'Why you need to leave early, e.g. Medical appointment in the evening.'
                  : 'Explain what happened, e.g. Forgot to check out; left office at 6:30 PM.'}
              className="w-full px-3 py-2 bg-gray-50 border border-gray-200 rounded-lg text-sm outline-none focus:ring-2 focus:ring-indigo-500/20 resize-none" />
          </div>
        </div>
        <div className="flex justify-end gap-2 px-5 py-4 border-t border-gray-100">
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button onClick={() => submit.mutate()} disabled={!canSubmit || submit.isPending}>
            {submit.isPending ? 'Saving…' : (isEdit ? 'Save Changes' : 'Submit Request')}
          </Button>
        </div>
      </div>
    </div>
  );
}
