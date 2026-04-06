import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { attendanceApi, employeeApi } from '../../api/endpoints';
import { ArrowPathIcon, ClockIcon, UserGroupIcon, ExclamationTriangleIcon, XCircleIcon, FunnelIcon, CalendarDaysIcon, ComputerDesktopIcon, PencilSquareIcon } from '@heroicons/react/24/outline';
import { useAuth } from '../../context/AuthContext';
import { format, startOfMonth, endOfMonth } from 'date-fns';
import toast from 'react-hot-toast';

const STATUS_CONFIG = {
  present: { dot: 'bg-emerald-500', text: 'text-emerald-700', label: 'Present' },
  absent: { dot: 'bg-red-500', text: 'text-red-700', label: 'Absent' },
  half_day: { dot: 'bg-amber-500', text: 'text-amber-700', label: 'Half Day' },
  incomplete: { dot: 'bg-slate-400', text: 'text-slate-600', label: 'Incomplete' },
};

export default function AttendancePage() {
  const { isHR, user } = useAuth();
  const qc = useQueryClient();
  const today = new Date();
  const [from, setFrom] = useState(format(startOfMonth(today), 'yyyy-MM-dd'));
  const [to, setTo] = useState(format(endOfMonth(today), 'yyyy-MM-dd'));
  const [empId, setEmpId] = useState('');
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const limit = 20;

  const { data, isLoading } = useQuery({
    queryKey: ['attendance', empId, from, to, status, page],
    queryFn: () => attendanceApi.list({ employeeId: empId, from, to, status, page, limit }),
    keepPreviousData: true,
  });

  const { data: empData } = useQuery({
    queryKey: ['employees-all'],
    queryFn: () => employeeApi.list({ limit: 200, status: 'active' }),
    enabled: isHR(),
  });

  const syncMutation = useMutation({
    mutationFn: () => attendanceApi.sync(from, to),
    onSuccess: (res) => {
      toast.success(`Sync complete: ${res.data.synced} records synced`);
      qc.invalidateQueries(['attendance']);
    },
    onError: () => toast.error('Sync failed. Check eTime connection.'),
  });

  const records = data?.data?.data || [];
  const total = data?.data?.count || 0;
  const totalPages = Math.ceil(total / limit);

  const presentCount = records.filter(r => r.hr_status === 'present').length;
  const absentCount = records.filter(r => r.hr_status === 'absent').length;
  const halfDayCount = records.filter(r => r.hr_status === 'half_day').length;
  const incompleteCount = records.filter(r => r.hr_status === 'incomplete').length;

  const statCards = [
    { label: 'Present', count: presentCount, icon: UserGroupIcon, iconBg: 'bg-emerald-100', iconColor: 'text-emerald-600', border: 'border-l-emerald-500' },
    { label: 'Absent', count: absentCount, icon: XCircleIcon, iconBg: 'bg-red-100', iconColor: 'text-red-600', border: 'border-l-red-500' },
    { label: 'Half Day', count: halfDayCount, icon: ClockIcon, iconBg: 'bg-amber-100', iconColor: 'text-amber-600', border: 'border-l-amber-500' },
    { label: 'Incomplete', count: incompleteCount, icon: ExclamationTriangleIcon, iconBg: 'bg-slate-100', iconColor: 'text-slate-500', border: 'border-l-slate-400' },
  ];

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 tracking-tight">Attendance</h1>
          <p className="text-sm text-gray-500 mt-1">{total} records found</p>
        </div>
        {isHR() && (
          <button
            onClick={() => syncMutation.mutate()}
            disabled={syncMutation.isLoading}
            className="inline-flex items-center gap-2.5 px-5 py-2.5 bg-indigo-600 text-white text-sm font-semibold rounded-xl shadow-md shadow-indigo-200 hover:bg-indigo-700 hover:shadow-lg hover:shadow-indigo-200 disabled:opacity-60 transition-all duration-200"
          >
            <ArrowPathIcon className={`w-4.5 h-4.5 ${syncMutation.isLoading ? 'animate-spin' : ''}`} />
            {syncMutation.isLoading ? 'Syncing...' : 'Sync eTime'}
          </button>
        )}
      </div>

      {/* Summary Stat Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {statCards.map(s => (
          <div key={s.label} className={`bg-white rounded-xl border border-gray-100 border-l-4 ${s.border} p-5 shadow-sm hover:shadow-md transition-shadow duration-200`}>
            <div className="flex items-start justify-between">
              <div>
                <p className="text-3xl font-bold text-gray-900 tracking-tight">{s.count}</p>
                <p className="text-sm font-medium text-gray-500 mt-1">{s.label}</p>
              </div>
              <div className={`w-10 h-10 ${s.iconBg} rounded-full flex items-center justify-center flex-shrink-0`}>
                <s.icon className={`w-5 h-5 ${s.iconColor}`} />
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* Filter Bar */}
      <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-4">
        <div className="flex items-center gap-2 mb-3">
          <FunnelIcon className="w-4 h-4 text-gray-400" />
          <span className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Filters</span>
        </div>
        <div className="flex flex-wrap items-end gap-4">
          <div className="flex-1 min-w-[180px]">
            <label className="block text-xs font-medium text-gray-500 mb-1.5">From Date</label>
            <div className="relative">
              <CalendarDaysIcon className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400 pointer-events-none" />
              <input type="date" className="w-full pl-9 pr-3 py-2 bg-gray-50 border border-gray-200 rounded-lg text-sm text-gray-700 focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-400 outline-none transition-all" value={from} onChange={e => { setFrom(e.target.value); setPage(1); }} />
            </div>
          </div>
          <div className="flex-1 min-w-[180px]">
            <label className="block text-xs font-medium text-gray-500 mb-1.5">To Date</label>
            <div className="relative">
              <CalendarDaysIcon className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400 pointer-events-none" />
              <input type="date" className="w-full pl-9 pr-3 py-2 bg-gray-50 border border-gray-200 rounded-lg text-sm text-gray-700 focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-400 outline-none transition-all" value={to} onChange={e => { setTo(e.target.value); setPage(1); }} />
            </div>
          </div>
          {isHR() && (
            <div className="flex-1 min-w-[200px]">
              <label className="block text-xs font-medium text-gray-500 mb-1.5">Employee</label>
              <select className="w-full px-3 py-2 bg-gray-50 border border-gray-200 rounded-lg text-sm text-gray-700 focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-400 outline-none transition-all appearance-none" value={empId} onChange={e => { setEmpId(e.target.value); setPage(1); }}>
                <option value="">All Employees</option>
                {empData?.data?.data?.map(e => (
                  <option key={e.hr_hremployeeid} value={e.hr_hremployeeid}>{e.hr_hremployee1}</option>
                ))}
              </select>
            </div>
          )}
          <div className="min-w-[160px]">
            <label className="block text-xs font-medium text-gray-500 mb-1.5">Status</label>
            <select className="w-full px-3 py-2 bg-gray-50 border border-gray-200 rounded-lg text-sm text-gray-700 focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-400 outline-none transition-all appearance-none" value={status} onChange={e => { setStatus(e.target.value); setPage(1); }}>
              <option value="">All Status</option>
              <option value="present">Present</option>
              <option value="absent">Absent</option>
              <option value="half_day">Half Day</option>
              <option value="incomplete">Incomplete</option>
            </select>
          </div>
        </div>
      </div>

      {/* Table */}
      <div className="bg-white rounded-xl border border-gray-100 shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="bg-gray-50/80">
                {isHR() && <th className="px-5 py-3.5 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">Employee</th>}
                <th className="px-5 py-3.5 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">Date</th>
                <th className="px-5 py-3.5 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">In Time</th>
                <th className="px-5 py-3.5 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">Out Time</th>
                <th className="px-5 py-3.5 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">Punches</th>
                <th className="px-5 py-3.5 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">Effective</th>
                <th className="px-5 py-3.5 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">Break</th>
                <th className="px-5 py-3.5 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">Source</th>
                <th className="px-5 py-3.5 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100/70">
              {isLoading ? (
                Array(10).fill(0).map((_, i) => (
                  <tr key={i}>{Array(isHR() ? 8 : 7).fill(0).map((_, j) => (
                    <td key={j} className="px-5 py-4"><div className="h-4 bg-gray-100 rounded-md animate-pulse" /></td>
                  ))}</tr>
                ))
              ) : records.length === 0 ? (
                <tr><td colSpan={8} className="px-5 py-16 text-center">
                  <div className="flex flex-col items-center gap-2">
                    <CalendarDaysIcon className="w-10 h-10 text-gray-300" />
                    <p className="text-sm text-gray-400 font-medium">No attendance records found for selected period</p>
                  </div>
                </td></tr>
              ) : (
                records.map(r => {
                  const hoursPercent = Math.min(((r.hr_workedhours || 0) / 9) * 100, 100);
                  const cfg = STATUS_CONFIG[r.hr_status] || STATUS_CONFIG.incomplete;
                  return (
                    <tr key={r.hr_hrattendanceid} className="hover:bg-gray-50/50 transition-colors duration-150">
                      {isHR() && (
                        <td className="px-5 py-4">
                          <span className="text-sm font-semibold text-gray-900">
                            {r['_hr_hremployee_value@OData.Community.Display.V1.FormattedValue'] || '—'}
                          </span>
                        </td>
                      )}
                      <td className="px-5 py-4 text-sm text-gray-700 font-medium">{r.hr_date ? format(new Date(r.hr_date), 'dd MMM yyyy') : '—'}</td>
                      <td className="px-5 py-4">
                        <span className="font-mono text-sm text-gray-600 bg-gray-50 px-2 py-0.5 rounded">{r.hr_intime || '—'}</span>
                      </td>
                      <td className="px-5 py-4">
                        <span className="font-mono text-sm text-gray-600 bg-gray-50 px-2 py-0.5 rounded">{r.hr_outtime || '—'}</span>
                      </td>
                      <td className="px-5 py-4">
                        {(() => {
                          let punches = [];
                          try { punches = JSON.parse(r.hr_allpunches || '[]'); } catch (_) {}
                          if (!Array.isArray(punches) || punches.length === 0) {
                            return <span className="text-sm text-gray-300">—</span>;
                          }
                          return (
                            <div className="flex flex-wrap gap-1">
                              {punches.map((p, i) => (
                                <span key={i} className={`font-mono text-xs px-1.5 py-0.5 rounded ${
                                  i === 0 ? 'bg-emerald-50 text-emerald-700 border border-emerald-200' :
                                  i === punches.length - 1 ? 'bg-rose-50 text-rose-700 border border-rose-200' :
                                  i % 2 === 1 ? 'bg-amber-50 text-amber-700 border border-amber-200' :
                                  'bg-blue-50 text-blue-700 border border-blue-200'
                                }`}>
                                  {p}
                                </span>
                              ))}
                            </div>
                          );
                        })()}
                      </td>
                      <td className="px-5 py-4">
                        {(() => {
                          const eff = r.hr_effectivehours || r.hr_workedhours || 0;
                          const pct = Math.min((eff / 9) * 100, 100);
                          return (
                            <div className="flex items-center gap-2">
                              <div className="w-14 h-1.5 bg-gray-100 rounded-full overflow-hidden">
                                <div className={`h-full rounded-full ${eff >= 8 ? 'bg-emerald-500' : eff >= 4 ? 'bg-amber-500' : 'bg-red-400'}`} style={{ width: `${pct}%` }} />
                              </div>
                              <span className={`text-sm font-semibold tabular-nums ${eff >= 8 ? 'text-emerald-600' : eff >= 4 ? 'text-amber-600' : 'text-red-500'}`}>
                                {eff.toFixed(1)}h
                              </span>
                            </div>
                          );
                        })()}
                      </td>
                      <td className="px-5 py-4">
                        {r.hr_breakduration > 0 ? (
                          <span className="inline-flex items-center gap-1 text-xs font-semibold text-orange-600 bg-orange-50 px-2 py-0.5 rounded-md">
                            {r.hr_breakduration.toFixed(1)}h
                          </span>
                        ) : (
                          <span className="text-sm text-gray-300">—</span>
                        )}
                      </td>
                      <td className="px-5 py-4">
                        {r.hr_source === 'etime_device' ? (
                          <span className="inline-flex items-center gap-1.5 text-xs font-medium text-blue-700 bg-blue-50 border border-blue-100 px-2.5 py-1 rounded-lg">
                            <ComputerDesktopIcon className="w-3.5 h-3.5" /> Device
                          </span>
                        ) : r.hr_source === 'web_checkin' ? (
                          <span className="inline-flex items-center gap-1.5 text-xs font-medium text-indigo-700 bg-indigo-50 border border-indigo-100 px-2.5 py-1 rounded-lg">
                            <ClockIcon className="w-3.5 h-3.5" /> Web
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1.5 text-xs font-medium text-gray-600 bg-gray-50 border border-gray-200 px-2.5 py-1 rounded-lg">
                            <PencilSquareIcon className="w-3.5 h-3.5" /> Manual
                          </span>
                        )}
                      </td>
                      <td className="px-5 py-4">
                        <span className={`inline-flex items-center gap-1.5 text-xs font-medium ${cfg.text}`}>
                          <span className={`w-2 h-2 rounded-full ${cfg.dot}`} />
                          {cfg.label}
                        </span>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
        {totalPages > 1 && (
          <div className="px-5 py-3.5 border-t border-gray-100 flex items-center justify-between">
            <span className="text-sm text-gray-500">Showing <span className="font-medium text-gray-700">{((page-1)*limit)+1}\u2013{Math.min(page*limit, total)}</span> of <span className="font-medium text-gray-700">{total}</span></span>
            <div className="flex gap-2">
              <button onClick={() => setPage(p => p-1)} disabled={page === 1} className="px-4 py-1.5 text-sm font-medium text-gray-600 bg-white border border-gray-200 rounded-lg hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors">Prev</button>
              <button onClick={() => setPage(p => p+1)} disabled={page >= totalPages} className="px-4 py-1.5 text-sm font-medium text-gray-600 bg-white border border-gray-200 rounded-lg hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors">Next</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
