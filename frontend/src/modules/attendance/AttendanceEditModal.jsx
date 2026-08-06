import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { attendanceApi } from '../../api/endpoints';
import Button from '../../components/Button';
import { XMarkIcon, ClockIcon } from '@heroicons/react/24/outline';
import { format } from 'date-fns';
import toast from 'react-hot-toast';

const inp = 'w-full h-10 px-3 bg-gray-50 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-400';
const fmtDT = (d) => { try { return d ? format(new Date(d), 'dd MMM yyyy, HH:mm') : '—'; } catch { return d || '—'; } };

/**
 * HR attendance editor — edit in/out/break/status/overtime with recompute + audit.
 * Works on any record, including days whose correction was already approved.
 */
export default function AttendanceEditModal({ record, onClose }) {
  const qc = useQueryClient();
  const id = record.hr_hrattendanceid;
  const [tab, setTab] = useState('edit');
  const [f, setF] = useState({
    inTime: record.hr_intime || '',
    outTime: record.hr_outtime || '',
    breakHours: record.hr_breakduration ?? '',
    overtime: record.hr_overtime ?? '',
    status: record.hr_status || '',
    reason: '',
  });

  const { data: auditRes } = useQuery({
    queryKey: ['attendance-audit', id],
    queryFn: () => attendanceApi.audit({ attendanceId: id }).then(r => r.data),
    enabled: tab === 'history',
  });
  const history = auditRes?.data || [];

  const save = useMutation({
    mutationFn: () => attendanceApi.edit(id, f),
    onSuccess: () => {
      toast.success('Attendance updated & recalculated');
      qc.invalidateQueries({ queryKey: ['attendance'] });
      qc.invalidateQueries({ queryKey: ['attendance-stats'] });
      onClose();
    },
    onError: (e) => toast.error(e.response?.data?.error || 'Failed to save'),
  });

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4 overflow-y-auto">
      <div className="bg-white w-full max-w-lg rounded-2xl shadow-2xl my-8">
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
          <div>
            <h2 className="text-lg font-bold text-gray-900">Edit Attendance</h2>
            <p className="text-xs text-gray-400">{record['_hr_hremployee_value@OData.Community.Display.V1.FormattedValue'] || 'Employee'} · {record.hr_date ? format(new Date(record.hr_date), 'dd MMM yyyy') : ''}</p>
          </div>
          <button onClick={onClose} className="p-2 text-gray-400 hover:bg-gray-100 rounded-lg"><XMarkIcon className="w-5 h-5" /></button>
        </div>

        <div className="px-6 pt-4">
          <div className="inline-flex bg-gray-100 p-1 rounded-lg gap-0.5">
            {[['edit', 'Edit'], ['history', 'History']].map(([k, l]) => (
              <button key={k} onClick={() => setTab(k)} className={`px-4 py-1.5 rounded-md text-xs font-semibold ${tab === k ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500'}`}>{l}</button>
            ))}
          </div>
        </div>

        {tab === 'edit' ? (
          <div className="p-6 space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <div><label className="block text-xs font-semibold text-gray-600 mb-1">In Time</label>
                <input type="time" className={inp} value={f.inTime} onChange={e => setF(p => ({ ...p, inTime: e.target.value }))} /></div>
              <div><label className="block text-xs font-semibold text-gray-600 mb-1">Out Time</label>
                <input type="time" className={inp} value={f.outTime} onChange={e => setF(p => ({ ...p, outTime: e.target.value }))} /></div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div><label className="block text-xs font-semibold text-gray-600 mb-1">Break (hours)</label>
                <input type="number" step="0.25" min="0" className={inp} value={f.breakHours} onChange={e => setF(p => ({ ...p, breakHours: e.target.value }))} placeholder="auto" /></div>
              <div><label className="block text-xs font-semibold text-gray-600 mb-1">Overtime (hours)</label>
                <input type="number" step="0.25" min="0" className={inp} value={f.overtime} onChange={e => setF(p => ({ ...p, overtime: e.target.value }))} placeholder="auto" /></div>
            </div>
            <div><label className="block text-xs font-semibold text-gray-600 mb-1">Status</label>
              <select className={inp} value={f.status} onChange={e => setF(p => ({ ...p, status: e.target.value }))}>
                <option value="">Auto (recompute)</option>
                <option value="present">Present</option>
                <option value="absent">Absent</option>
                <option value="half_day">Half Day</option>
                <option value="incomplete">Incomplete</option>
                <option value="holiday">Holiday</option>
              </select></div>
            <div><label className="block text-xs font-semibold text-gray-600 mb-1">Reason <span className="text-rose-500">*</span></label>
              <input className={inp} value={f.reason} onChange={e => setF(p => ({ ...p, reason: e.target.value }))} placeholder="Why is this being edited? (audited)" /></div>
            <p className="text-[11px] text-gray-400">Hours, break, late and status recompute from In/Out automatically; the fields above override the computed values. Payroll reflects the change on the next draft generation of that month.</p>
            <div className="flex justify-end gap-3 pt-1">
              <button onClick={onClose} className="px-4 py-2 text-sm text-gray-600">Cancel</button>
              <Button onClick={() => save.mutate()} loading={save.isPending} disabled={!f.reason.trim()}>Save & Recalculate</Button>
            </div>
          </div>
        ) : (
          <div className="p-6 max-h-[55vh] overflow-y-auto">
            {history.length === 0 ? <p className="text-sm text-gray-400 text-center py-8">No edit history for this record.</p> : (
              <ol className="space-y-3">
                {history.map(h => (
                  <li key={h.id} className="border-l-2 border-indigo-200 pl-3">
                    <p className="text-xs font-semibold text-gray-700 flex items-center gap-1"><ClockIcon className="w-3.5 h-3.5" /> {h.action} · {fmtDT(h.updatedOn)} · {h.updatedBy || '—'}</p>
                    <p className="text-xs text-gray-500 mt-0.5">
                      In {h.oldValues?.inTime || '—'}→{h.newValues?.inTime || '—'} · Out {h.oldValues?.outTime || '—'}→{h.newValues?.outTime || '—'} · Status {h.oldValues?.status || '—'}→{h.newValues?.status || '—'}
                    </p>
                    {h.reason && <p className="text-xs text-gray-400 italic mt-0.5">"{h.reason}"</p>}
                  </li>
                ))}
              </ol>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
