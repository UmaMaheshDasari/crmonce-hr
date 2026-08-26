import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { attendanceApi, employeeApi } from '../../api/endpoints';
import Button from '../../components/Button';
import { ArrowUpTrayIcon, ExclamationTriangleIcon, CheckCircleIcon, ClockIcon } from '@heroicons/react/24/outline';
import { format } from 'date-fns';
import toast from 'react-hot-toast';
import { useAuth } from '../../context/AuthContext';

const inp = 'w-full h-10 px-3 bg-gray-50 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-400';
const todayStr = new Date().toISOString().slice(0, 10);
const STATUSES = ['present', 'absent', 'half_day', 'holiday', 'week_off', 'lop'];
const STATUS_LABEL = { present: 'Present', absent: 'Absent', half_day: 'Half Day', holiday: 'Holiday', week_off: 'Week Off', lop: 'LOP' };

// HR/Admin one-time entry of attendance from before the HRMS went live.
export default function HistoricalAttendancePage() {
  const { hasPermission } = useAuth();
  const canEnter = hasPermission('attendance.edit');   // RBAC Phase D (page also route-gated to HR)
  const qc = useQueryClient();
  const [f, setF] = useState({ employeeId: '', date: '', inTime: '', outTime: '', status: 'present', remarks: '' });
  const [dupWarn, setDupWarn] = useState(false);
  const [recent, setRecent] = useState([]);

  const { data: empRes } = useQuery({ queryKey: ['employees-lite', 'active'], queryFn: () => employeeApi.list({ limit: 500, status: 'active' }) });
  const employees = empRes?.data?.data || empRes?.data || [];
  const empName = (id) => employees.find(e => e.hr_hremployeeid === id)?.hr_hremployee1 || 'Employee';

  const submit = useMutation({
    mutationFn: (overwrite) => attendanceApi.historical({ ...f, overwrite }),
    onSuccess: (_r, overwrite) => {
      toast.success(overwrite ? 'Historical attendance updated' : 'Historical attendance added');
      setRecent(r => [{ name: empName(f.employeeId), date: f.date, status: STATUS_LABEL[f.status] || f.status, when: new Date().toISOString() }, ...r].slice(0, 20));
      setDupWarn(false);
      setF(p => ({ ...p, date: '', inTime: '', outTime: '', remarks: '' }));
      qc.invalidateQueries({ queryKey: ['attendance'] });
    },
    onError: (e) => {
      if (e.response?.status === 409 || e.response?.data?.duplicate) { setDupWarn(true); }
      else { toast.error(e.response?.data?.error || 'Failed to save'); }
    },
  });

  const invalid = !f.employeeId || !f.date;

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 tracking-tight">Historical Attendance</h1>
          <p className="text-sm text-gray-500 mt-1">Enter attendance from before the HRMS went live. Feeds monthly attendance, payroll, reports and the dashboard.</p>
        </div>
        <Link to="/import-export" className="inline-flex items-center gap-1.5 h-10 px-3 bg-white border border-gray-200 rounded-lg text-sm font-semibold text-indigo-600 hover:bg-indigo-50">
          <ArrowUpTrayIcon className="w-4 h-4" /> Bulk Excel Import
        </Link>
      </div>

      <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-5">
        <h2 className="text-sm font-bold text-gray-900 mb-4">Manual Entry</h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          <div><label className="block text-xs font-semibold text-gray-600 mb-1">Employee</label>
            <select className={inp} value={f.employeeId} onChange={e => { setF(p => ({ ...p, employeeId: e.target.value })); setDupWarn(false); }}>
              <option value="">Select employee…</option>
              {employees.map(e => <option key={e.hr_hremployeeid} value={e.hr_hremployeeid}>{e.hr_hremployee1}</option>)}
            </select></div>
          <div><label className="block text-xs font-semibold text-gray-600 mb-1">Date</label>
            <input type="date" max={todayStr} className={inp} value={f.date} onChange={e => { setF(p => ({ ...p, date: e.target.value })); setDupWarn(false); }} /></div>
          <div><label className="block text-xs font-semibold text-gray-600 mb-1">Status</label>
            <select className={inp} value={f.status} onChange={e => setF(p => ({ ...p, status: e.target.value }))}>
              {STATUSES.map(s => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
            </select></div>
          <div><label className="block text-xs font-semibold text-gray-600 mb-1">In Time</label>
            <input type="time" className={inp} value={f.inTime} onChange={e => setF(p => ({ ...p, inTime: e.target.value }))} /></div>
          <div><label className="block text-xs font-semibold text-gray-600 mb-1">Out Time</label>
            <input type="time" className={inp} value={f.outTime} onChange={e => setF(p => ({ ...p, outTime: e.target.value }))} /></div>
          <div><label className="block text-xs font-semibold text-gray-600 mb-1">Remarks</label>
            <input className={inp} value={f.remarks} onChange={e => setF(p => ({ ...p, remarks: e.target.value }))} placeholder="optional" /></div>
        </div>

        {dupWarn && (
          <div className="mt-4 flex items-start gap-2 text-sm bg-amber-50 border border-amber-200 rounded-lg px-3 py-2.5 text-amber-800">
            <ExclamationTriangleIcon className="w-5 h-5 flex-shrink-0" />
            <div className="flex-1">
              Attendance already exists for {empName(f.employeeId)} on {f.date}. Overwrite it?
              <div className="mt-2 flex gap-2">
                <button onClick={() => submit.mutate(true)} className="px-3 py-1 text-xs font-semibold text-white bg-amber-600 rounded-lg hover:bg-amber-700">Overwrite</button>
                <button onClick={() => setDupWarn(false)} className="px-3 py-1 text-xs font-semibold text-amber-700 bg-white border border-amber-200 rounded-lg">Keep existing</button>
              </div>
            </div>
          </div>
        )}

        <div className="flex justify-end mt-4">
          {canEnter && <Button onClick={() => submit.mutate(false)} loading={submit.isPending && !dupWarn} disabled={invalid}>Add Entry</Button>}
        </div>
      </div>

      {recent.length > 0 && (
        <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-5">
          <h2 className="text-sm font-bold text-gray-900 mb-3">Added this session</h2>
          <ul className="space-y-2">
            {recent.map((r, i) => (
              <li key={i} className="flex items-center gap-2 text-sm text-gray-600">
                <CheckCircleIcon className="w-4 h-4 text-emerald-500" />
                <span className="font-medium text-gray-800">{r.name}</span> · {r.date} · {r.status}
                <span className="text-xs text-gray-400 ml-auto inline-flex items-center gap-1"><ClockIcon className="w-3 h-3" /> {format(new Date(r.when), 'HH:mm')}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
