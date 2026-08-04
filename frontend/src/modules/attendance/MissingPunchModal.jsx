import { useState, useEffect } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { XMarkIcon } from '@heroicons/react/24/outline';
import toast from 'react-hot-toast';
import { attendanceRequestApi } from '../../api/endpoints';
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

// Employees submit an Attendance Correction here to fix a PAST attendance record.
// It never affects their ability to punch (check in/out) going forward.
export default function MissingPunchModal({ open, onClose, defaultDate }) {
  const { user } = useAuth();
  const qc = useQueryClient();
  const [form, setForm] = useState({ attendanceDate: '', punchType: 'missing_check_out', requestedTime: '', reason: '' });

  useEffect(() => {
    if (open) setForm(f => ({ ...f, attendanceDate: defaultDate || f.attendanceDate || new Date().toISOString().slice(0, 10) }));
  }, [open, defaultDate]);

  const submit = useMutation({
    mutationFn: () => attendanceRequestApi.submit(form),
    onSuccess: () => {
      toast.success('Attendance correction request submitted for approval');
      qc.invalidateQueries({ queryKey: ['attendance-requests'] });
      onClose();
      setForm(f => ({ ...f, requestedTime: '', reason: '' }));
    },
    onError: (e) => toast.error(e.response?.data?.error || 'Could not submit request'),
  });

  if (!open) return null;
  const set = (k) => (e) => setForm(f => ({ ...f, [k]: e.target.value }));
  const canSubmit = form.attendanceDate && form.punchType && form.requestedTime && form.reason.trim();

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div className="bg-white rounded-2xl w-full max-w-lg shadow-xl" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
          <h3 className="text-base font-bold text-gray-900">Request Attendance Correction</h3>
          <button onClick={onClose} className="p-1 rounded-lg hover:bg-gray-100"><XMarkIcon className="w-5 h-5 text-gray-500" /></button>
        </div>
        <div className="p-5 space-y-3.5">
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
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">Correct Time <span className="text-red-500">*</span></label>
              <input type="time" value={form.requestedTime} onChange={set('requestedTime')}
                className="w-full px-3 py-2 bg-gray-50 border border-gray-200 rounded-lg text-sm outline-none focus:ring-2 focus:ring-indigo-500/20" />
            </div>
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-500 mb-1">Correction Type</label>
            <select value={form.punchType} onChange={set('punchType')}
              className="w-full px-3 py-2 bg-gray-50 border border-gray-200 rounded-lg text-sm outline-none focus:ring-2 focus:ring-indigo-500/20 cursor-pointer">
              {CORRECTION_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-500 mb-1">Reason <span className="text-red-500">*</span></label>
            <textarea rows={3} value={form.reason} onChange={set('reason')} placeholder="Explain what happened, e.g. Forgot to check out; left office at 6:30 PM."
              className="w-full px-3 py-2 bg-gray-50 border border-gray-200 rounded-lg text-sm outline-none focus:ring-2 focus:ring-indigo-500/20 resize-none" />
          </div>
        </div>
        <div className="flex justify-end gap-2 px-5 py-4 border-t border-gray-100">
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button onClick={() => submit.mutate()} disabled={!canSubmit || submit.isPending}>
            {submit.isPending ? 'Submitting…' : 'Submit Request'}
          </Button>
        </div>
      </div>
    </div>
  );
}
