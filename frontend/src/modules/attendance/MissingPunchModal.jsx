import { useState, useEffect } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { XMarkIcon } from '@heroicons/react/24/outline';
import toast from 'react-hot-toast';
import { attendanceRequestApi } from '../../api/endpoints';
import Button from '../../components/Button';

const PUNCH_TYPES = [
  { value: 'lunch_out', label: 'Lunch Out (forgot to punch out for lunch)' },
  { value: 'lunch_in', label: 'Lunch In (forgot to punch back in)' },
  { value: 'missing_check_in', label: 'Missing Check In' },
  { value: 'missing_check_out', label: 'Missing Check Out' },
];

// Employees submit a Missing Punch request here — they can NEVER edit attendance
// directly; an approved request inserts the punch and recalculates the day.
export default function MissingPunchModal({ open, onClose, defaultDate }) {
  const qc = useQueryClient();
  const [form, setForm] = useState({ attendanceDate: '', punchType: 'lunch_out', requestedTime: '', reason: '', remarks: '', attachmentUrl: '' });

  useEffect(() => {
    if (open) setForm(f => ({ ...f, attendanceDate: defaultDate || f.attendanceDate || new Date().toISOString().slice(0, 10) }));
  }, [open, defaultDate]);

  const submit = useMutation({
    mutationFn: () => attendanceRequestApi.submit(form),
    onSuccess: () => {
      toast.success('Missing Punch request submitted for approval');
      qc.invalidateQueries({ queryKey: ['attendance-requests'] });
      onClose();
      setForm(f => ({ ...f, requestedTime: '', reason: '', remarks: '', attachmentUrl: '' }));
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
          <h3 className="text-base font-bold text-gray-900">Request Missing Punch Correction</h3>
          <button onClick={onClose} className="p-1 rounded-lg hover:bg-gray-100"><XMarkIcon className="w-5 h-5 text-gray-500" /></button>
        </div>
        <div className="p-5 space-y-3.5">
          <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
            You appear to have missed a punch. Submit the correct time and reason — HR will review and, if approved, the punch is inserted and your hours recalculate automatically.
          </p>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">Attendance Date</label>
              <input type="date" max={new Date().toISOString().slice(0, 10)} value={form.attendanceDate} onChange={set('attendanceDate')}
                className="w-full px-3 py-2 bg-gray-50 border border-gray-200 rounded-lg text-sm outline-none focus:ring-2 focus:ring-indigo-500/20" />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">Requested Time</label>
              <input type="time" value={form.requestedTime} onChange={set('requestedTime')}
                className="w-full px-3 py-2 bg-gray-50 border border-gray-200 rounded-lg text-sm outline-none focus:ring-2 focus:ring-indigo-500/20" />
            </div>
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-500 mb-1">Punch Type</label>
            <select value={form.punchType} onChange={set('punchType')}
              className="w-full px-3 py-2 bg-gray-50 border border-gray-200 rounded-lg text-sm outline-none focus:ring-2 focus:ring-indigo-500/20 cursor-pointer">
              {PUNCH_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-500 mb-1">Reason</label>
            <textarea rows={2} value={form.reason} onChange={set('reason')} placeholder="e.g. Forgot to punch while going for lunch."
              className="w-full px-3 py-2 bg-gray-50 border border-gray-200 rounded-lg text-sm outline-none focus:ring-2 focus:ring-indigo-500/20 resize-none" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">Remarks (optional)</label>
              <input type="text" value={form.remarks} onChange={set('remarks')}
                className="w-full px-3 py-2 bg-gray-50 border border-gray-200 rounded-lg text-sm outline-none focus:ring-2 focus:ring-indigo-500/20" />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">Attachment URL (optional)</label>
              <input type="url" value={form.attachmentUrl} onChange={set('attachmentUrl')} placeholder="https://…"
                className="w-full px-3 py-2 bg-gray-50 border border-gray-200 rounded-lg text-sm outline-none focus:ring-2 focus:ring-indigo-500/20" />
            </div>
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
