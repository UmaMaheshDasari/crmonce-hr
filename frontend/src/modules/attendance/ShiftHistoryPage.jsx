import { useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import toast from 'react-hot-toast';
import { employeeApi, shiftHistoryApi } from '../../api/endpoints';

const SHIFTS = ['Morning Shift', 'General Shift', 'Day Shift', 'Evening Shift', 'Night Shift'];
const todayStr = () => new Date().toISOString().slice(0, 10);
const dmy = (d) => (d ? String(d).slice(0, 10).split('-').reverse().join('-') : '');
const dt = (s) => { if (!s) return ''; const d = new Date(s); return isNaN(d) ? '' : d.toLocaleString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }); };

export default function ShiftHistoryPage() {
  const qc = useQueryClient();
  const [employeeId, setEmployeeId] = useState('');

  const { data: emps = [] } = useQuery({
    queryKey: ['employees-shift-min'],
    queryFn: () => employeeApi.list().then((r) => r.data?.data || r.data || []),
  });
  const empList = useMemo(
    () => [...emps].sort((a, b) => String(a.hr_hremployee1 || '').localeCompare(String(b.hr_hremployee1 || ''))),
    [emps],
  );
  const selectedEmp = emps.find((e) => e.hr_hremployeeid === employeeId);

  const { data: history = [], isLoading } = useQuery({
    enabled: !!employeeId,
    queryKey: ['shift-history', employeeId],
    queryFn: () => shiftHistoryApi.history(employeeId).then((r) => r.data?.data || []),
  });
  const current = history.find((h) => !h.effectiveTo) || null;

  const { register, handleSubmit, reset, formState: { errors } } = useForm({
    defaultValues: { shiftName: 'General Shift', shiftStart: '09:00', shiftEnd: '18:00', graceMins: 5, effectiveFrom: todayStr(), reason: '' },
  });

  const changeMut = useMutation({
    mutationFn: (v) => shiftHistoryApi.change({ ...v, graceMins: Number(v.graceMins) || 5, employeeId }),
    onSuccess: () => {
      toast.success('Shift updated');
      qc.invalidateQueries({ queryKey: ['shift-history', employeeId] });
      reset({ shiftName: 'General Shift', shiftStart: '09:00', shiftEnd: '18:00', graceMins: 5, effectiveFrom: todayStr(), reason: '' });
    },
    onError: (e) => toast.error(e.response?.data?.error || 'Failed to change shift'),
  });

  const inp = 'w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#1B4F72]/30 focus:border-[#1B4F72]';

  return (
    <div className="p-6 max-w-6xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Shift History</h1>
        <p className="text-gray-500 text-sm mt-1">Effective-dated shift assignments per employee. Attendance always uses the shift that was effective on each attendance date — a shift change never re-judges a past day.</p>
      </div>

      {/* Employee picker */}
      <div className="bg-white rounded-xl border border-gray-200 p-4">
        <label className="block text-sm font-medium text-gray-600 mb-1.5">Employee</label>
        <select className={inp} value={employeeId} onChange={(e) => setEmployeeId(e.target.value)}>
          <option value="">— Select an employee —</option>
          {empList.map((e) => (
            <option key={e.hr_hremployeeid} value={e.hr_hremployeeid}>{e.hr_hremployee1 || e.hr_hremployeeid}</option>
          ))}
        </select>
        {selectedEmp && (
          <div className="mt-3 text-sm text-gray-600">
            Current shift:{' '}
            <span className="font-medium text-gray-900">
              {current ? `${current.shiftName || '—'} (${current.shiftStart}–${current.shiftEnd || '—'}, grace ${current.graceMins}m)` : (selectedEmp.hr_shiftname ? `${selectedEmp.hr_shiftname} (${selectedEmp.hr_shiftstarttime || '—'}–${selectedEmp.hr_shiftendtime || '—'})` : 'Not set')}
            </span>
            {!current && <span className="ml-2 text-xs text-gray-400">(no history yet — the current shift applies to all past dates)</span>}
          </div>
        )}
      </div>

      {employeeId && (
        <div className="grid gap-6 lg:grid-cols-3">
          {/* Change shift */}
          <div className="bg-white rounded-xl border border-gray-200 p-4 lg:col-span-1 h-fit">
            <h2 className="font-semibold text-gray-900 mb-3">Change Shift</h2>
            <form onSubmit={handleSubmit((v) => changeMut.mutate(v))} className="space-y-3">
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Shift Name</label>
                <select className={inp} {...register('shiftName')}>{SHIFTS.map((s) => <option key={s}>{s}</option>)}</select>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">Start</label>
                  <input type="time" className={inp} {...register('shiftStart', { required: true })} />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">End</label>
                  <input type="time" className={inp} {...register('shiftEnd')} />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">Grace (min)</label>
                  <input type="number" min="0" max="120" className={inp} {...register('graceMins')} />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">Effective From</label>
                  <input type="date" className={inp} {...register('effectiveFrom', { required: true })} />
                  {errors.effectiveFrom && <p className="text-xs text-red-500 mt-1">Required</p>}
                </div>
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Reason (optional)</label>
                <input className={inp} placeholder="e.g. moved to night operations" {...register('reason')} />
              </div>
              <button type="submit" disabled={changeMut.isPending}
                className="w-full py-2.5 rounded-lg text-sm font-semibold text-white bg-[#1B4F72] hover:bg-[#154360] disabled:opacity-50 transition-colors">
                {changeMut.isPending ? 'Saving…' : 'Save Shift Change'}
              </button>
              <p className="text-[11px] text-gray-400 leading-relaxed">The previous assignment is kept (closed the day before this date) — history is never overwritten. A date on or before an existing assignment is rejected.</p>
            </form>
          </div>

          {/* History timeline */}
          <div className="bg-white rounded-xl border border-gray-200 lg:col-span-2 overflow-hidden">
            <div className="px-4 py-3 border-b border-gray-100"><h2 className="font-semibold text-gray-900">Assignment History</h2></div>
            {isLoading ? (
              <div className="p-6 text-center text-gray-400 text-sm">Loading…</div>
            ) : history.length === 0 ? (
              <div className="p-6 text-center text-gray-400 text-sm">No shift-history rows yet. The employee's current shift applies to every date until a change is recorded here.</div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-xs uppercase tracking-wide text-gray-400 border-b border-gray-100">
                      <th className="px-4 py-2.5 font-semibold">Shift</th>
                      <th className="px-3 py-2.5 font-semibold">Timing</th>
                      <th className="px-3 py-2.5 font-semibold">Grace</th>
                      <th className="px-3 py-2.5 font-semibold">Effective From</th>
                      <th className="px-3 py-2.5 font-semibold">Effective To</th>
                      <th className="px-3 py-2.5 font-semibold">Changed By / At</th>
                      <th className="px-4 py-2.5 font-semibold">Reason</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-50">
                    {history.map((h) => (
                      <tr key={h.id} className={!h.effectiveTo ? 'bg-[#1B4F72]/[0.03]' : ''}>
                        <td className="px-4 py-3 font-medium text-gray-900">{h.shiftName || '—'}</td>
                        <td className="px-3 py-3 text-gray-600 whitespace-nowrap">{h.shiftStart}{h.shiftEnd ? `–${h.shiftEnd}` : ''}</td>
                        <td className="px-3 py-3 text-gray-600">{h.graceMins}m</td>
                        <td className="px-3 py-3 text-gray-600 whitespace-nowrap">{dmy(h.effectiveFrom)}</td>
                        <td className="px-3 py-3 whitespace-nowrap">
                          {h.effectiveTo ? <span className="text-gray-600">{dmy(h.effectiveTo)}</span> : <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-semibold bg-green-100 text-green-700">Current</span>}
                        </td>
                        <td className="px-3 py-3 text-gray-500 text-xs whitespace-nowrap">{h.changedBy || '—'}<br />{dt(h.changedOn)}</td>
                        <td className="px-4 py-3 text-gray-500 text-xs max-w-[16rem]">{h.reason || '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
