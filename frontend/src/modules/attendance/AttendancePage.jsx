import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { attendanceApi, employeeApi } from '../../api/endpoints';
import { ArrowPathIcon, ClockIcon, UserGroupIcon, ExclamationTriangleIcon, XCircleIcon, FunnelIcon, CalendarDaysIcon, ComputerDesktopIcon, PencilSquareIcon, ArrowDownTrayIcon } from '@heroicons/react/24/outline';
import { useAuth } from '../../context/AuthContext';
import { format, startOfMonth, endOfMonth, subDays, subMonths } from 'date-fns';
import { formatDuration } from '../../utils/formatDuration';
import Button from '../../components/Button';
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
  const [range, setRange] = useState('this_month');   // quick date range preset
  const [empId, setEmpId] = useState('');
  const [status, setStatus] = useState('');
  const [source, setSource] = useState('');
  const [view, setView] = useState('');       // computed filter for export (late/early/overtime/…)
  const [exporting, setExporting] = useState(false);
  const [page, setPage] = useState(1);
  const limit = 20;

  // In the "All" view we fetch all rows for the range (up to 2000) so records and
  // synthesized absentees can be merged and sorted DATE-WISE on the client.
  const allView = status === '';
  const { data, isLoading } = useQuery({
    queryKey: ['attendance', empId, from, to, status, source, allView ? 'all' : page],
    queryFn: () => attendanceApi.list({ employeeId: empId, from, to, status, source, page: allView ? 1 : page, limit: allView ? 2000 : limit }),
    placeholderData: (prev) => prev,
  });

  // Aggregate stats for the cards — computed on the backend the SAME way as the
  // Excel export (Absent = Working − Attended − Leave), so all views agree.
  const { data: statsData } = useQuery({
    queryKey: ['attendance-stats', empId, from, to],
    queryFn: () => attendanceApi.stats({ employeeId: empId, from, to }),
    placeholderData: (prev) => prev,
  });
  const stats = statsData?.data;

  // Absent days have no attendance record, so we synthesize absentee rows and show
  // them both in the "All" view (appended) and when the Absent filter is active.
  const isAbsentView = status === 'absent';
  const includeAbsentees = status === '' || isAbsentView;   // All view or Absent-only
  const { data: absentData, isLoading: absentLoading } = useQuery({
    queryKey: ['attendance-absentees', empId, from, to],
    queryFn: () => attendanceApi.absentees({ employeeId: empId, from, to }),
    enabled: includeAbsentees,
    placeholderData: (prev) => prev,
  });
  const absentees = absentData?.data?.data || [];

  const handleExport = async () => {
    setExporting(true);
    try {
      const res = await attendanceApi.exportExcel({ from, to, employeeId: empId, status, source, view });
      const url = window.URL.createObjectURL(new Blob([res.data]));
      const a = document.createElement('a');
      a.href = url; a.download = `Attendance_${from}_to_${to}.xlsx`;
      document.body.appendChild(a); a.click(); a.remove();
      window.URL.revokeObjectURL(url);
      toast.success('Exported current filtered data');
    } catch { toast.error('Export failed'); }
    finally { setExporting(false); }
  };

  // Quick date-range presets → set From/To. 'custom' leaves the inputs editable.
  const fmt = (d) => format(d, 'yyyy-MM-dd');
  const applyRange = (r) => {
    setRange(r);
    setPage(1);
    const now = new Date();
    if (r === 'today') { setFrom(fmt(now)); setTo(fmt(now)); }
    else if (r === 'yesterday') { const y = subDays(now, 1); setFrom(fmt(y)); setTo(fmt(y)); }
    else if (r === 'this_month') { setFrom(fmt(startOfMonth(now))); setTo(fmt(endOfMonth(now))); }
    else if (r === 'last_month') { const lm = subMonths(now, 1); setFrom(fmt(startOfMonth(lm))); setTo(fmt(endOfMonth(lm))); }
    // 'custom' → keep current from/to, user edits the date inputs
  };

  const resetFilters = () => {
    setRange('this_month');
    setFrom(format(startOfMonth(today), 'yyyy-MM-dd'));
    setTo(format(endOfMonth(today), 'yyyy-MM-dd'));
    setEmpId(''); setStatus(''); setSource(''); setView(''); setPage(1);
  };

  const { data: empData } = useQuery({
    queryKey: ['employees-all'],
    queryFn: () => employeeApi.list({ limit: 200, status: 'active' }),
    enabled: isHR(),
  });

  const syncMutation = useMutation({
    mutationFn: () => attendanceApi.sync(from, to),
    onSuccess: (res) => {
      toast.success(`Sync complete: ${res.data.synced} records synced`);
      qc.invalidateQueries({ queryKey: ['attendance'] });
    },
    onError: () => toast.error('Sync failed. Check eTime connection.'),
  });

  const records = data?.data?.data || [];
  const serverTotal = data?.data?.count || 0;

  // Combined, DATE-WISE list. All view = records + absentees merged, newest date
  // first, with present/incomplete before absent within the same day. Absent-only
  // view = absentees. Both are paginated on the client. Other filters stay
  // server-paginated (records only).
  let combined = null;
  if (allView) {
    combined = [
      ...records.map(r => ({ type: 'record', date: String(r.hr_date || '').slice(0, 10), r })),
      ...absentees.map(a => ({ type: 'absent', date: a.date, a })),
    ].sort((x, y) => (x.date !== y.date ? (x.date < y.date ? 1 : -1) : (x.type === y.type ? 0 : x.type === 'record' ? -1 : 1)));
  } else if (isAbsentView) {
    combined = absentees.map(a => ({ type: 'absent', date: a.date, a }));
  }
  const clientPaged = combined !== null;
  const displayTotal = clientPaged ? combined.length : serverTotal;
  const totalPages = Math.max(1, Math.ceil(displayTotal / limit));
  const pageRows = clientPaged
    ? combined.slice((page - 1) * limit, page * limit)
    : records.map(r => ({ type: 'record', r }));
  const tableLoading = isLoading || (includeAbsentees && absentLoading);

  // Counts come from the aggregate /stats endpoint (whole filtered range, all
  // employees) — NOT from filtering the current page, and Absent is computed
  // (Working − Attended − Leave), never by looking for absent records.
  const statCards = [
    { label: 'Present', value: 'present', count: stats?.present ?? 0, icon: UserGroupIcon, iconBg: 'bg-emerald-100', iconColor: 'text-emerald-600', border: 'border-l-emerald-500' },
    { label: 'Absent', value: 'absent', count: stats?.absent ?? 0, icon: XCircleIcon, iconBg: 'bg-red-100', iconColor: 'text-red-600', border: 'border-l-red-500' },
    { label: 'Half Day', value: 'half_day', count: stats?.halfDay ?? 0, icon: ClockIcon, iconBg: 'bg-amber-100', iconColor: 'text-amber-600', border: 'border-l-amber-500' },
    { label: 'Incomplete', value: 'incomplete', count: stats?.incomplete ?? 0, icon: ExclamationTriangleIcon, iconBg: 'bg-slate-100', iconColor: 'text-slate-500', border: 'border-l-slate-400' },
  ];

  const toggleCard = (val) => { setStatus(status === val ? '' : val); setPage(1); };

  // Absent rows are synthesized (no attendance record exists for an absent day).
  const renderAbsentRow = (a, key) => (
    <tr key={key} className="hover:bg-red-50/30 transition-colors duration-150">
      {isHR() && <td className="px-5 py-4"><span className="text-sm font-semibold text-gray-900">{a.employee}</span></td>}
      <td className="px-5 py-4 text-sm text-gray-700 font-medium">{a.date ? format(new Date(a.date), 'dd MMM yyyy') : '—'}</td>
      <td className="px-5 py-4 text-sm text-gray-300">—</td>
      <td className="px-5 py-4 text-sm text-gray-300">—</td>
      <td className="px-5 py-4 text-sm text-gray-300">—</td>
      <td className="px-5 py-4 text-sm text-gray-300">—</td>
      <td className="px-5 py-4 text-sm text-gray-300">—</td>
      <td className="px-5 py-4 text-sm text-gray-300">—</td>
      <td className="px-5 py-4">
        <span className="inline-flex items-center gap-1.5 text-xs font-medium text-red-700">
          <span className="w-2 h-2 rounded-full bg-red-500" /> Absent
        </span>
      </td>
    </tr>
  );

  const renderRecordRow = (r) => {
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
        <td className="px-5 py-4"><span className="font-mono text-sm text-gray-600 bg-gray-50 px-2 py-0.5 rounded">{r.hr_intime || '—'}</span></td>
        <td className="px-5 py-4"><span className="font-mono text-sm text-gray-600 bg-gray-50 px-2 py-0.5 rounded">{r.hr_outtime || '—'}</span></td>
        <td className="px-5 py-4">
          {(() => {
            let punches = [];
            try { punches = JSON.parse(r.hr_allpunches || '[]'); } catch (_) {}
            if (!Array.isArray(punches) || punches.length === 0) return <span className="text-sm text-gray-300">—</span>;
            return (
              <div className="flex flex-wrap gap-1">
                {punches.map((p, i) => (
                  <span key={i} className={`font-mono text-xs px-1.5 py-0.5 rounded ${
                    i === 0 ? 'bg-emerald-50 text-emerald-700 border border-emerald-200' :
                    i === punches.length - 1 ? 'bg-rose-50 text-rose-700 border border-rose-200' :
                    i % 2 === 1 ? 'bg-amber-50 text-amber-700 border border-amber-200' :
                    'bg-blue-50 text-blue-700 border border-blue-200'}`}>{p}</span>
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
                <span className={`text-sm font-semibold tabular-nums ${eff >= 8 ? 'text-emerald-600' : eff >= 4 ? 'text-amber-600' : 'text-red-500'}`}>{formatDuration(eff)}</span>
              </div>
            );
          })()}
        </td>
        <td className="px-5 py-4">
          {r.hr_breakduration > 0 ? (
            <span className="inline-flex items-center gap-1 text-xs font-semibold text-orange-600 bg-orange-50 px-2 py-0.5 rounded-md">{formatDuration(r.hr_breakduration)}</span>
          ) : (<span className="text-sm text-gray-300">—</span>)}
        </td>
        <td className="px-5 py-4">
          {r.hr_source === 'etime_device' ? (
            <span className="inline-flex items-center gap-1.5 text-xs font-medium text-blue-700 bg-blue-50 border border-blue-100 px-2.5 py-1 rounded-lg"><ComputerDesktopIcon className="w-3.5 h-3.5" /> Device</span>
          ) : r.hr_source === 'web_checkin' ? (
            <span className="inline-flex items-center gap-1.5 text-xs font-medium text-indigo-700 bg-indigo-50 border border-indigo-100 px-2.5 py-1 rounded-lg"><ClockIcon className="w-3.5 h-3.5" /> Web</span>
          ) : (
            <span className="inline-flex items-center gap-1.5 text-xs font-medium text-gray-600 bg-gray-50 border border-gray-200 px-2.5 py-1 rounded-lg"><PencilSquareIcon className="w-3.5 h-3.5" /> Manual</span>
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
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 tracking-tight">Attendance</h1>
          <p className="text-sm text-gray-500 mt-1">
            {isAbsentView
              ? `${absentees.length} absentee${absentees.length === 1 ? '' : 's'}`
              : allView
                ? `${records.length} marked${absentees.length ? ` · ${absentees.length} absent` : ''}`
                : `${serverTotal} record${serverTotal === 1 ? '' : 's'}`}
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap justify-end">
          <Button variant="secondary" icon={XCircleIcon} onClick={resetFilters}>Reset Filters</Button>
          <Button variant="success" icon={ArrowDownTrayIcon} loading={exporting} onClick={handleExport}>
            {exporting ? 'Exporting…' : 'Export Excel'}
          </Button>
          {isHR() && (
            <Button icon={ArrowPathIcon} loading={syncMutation.isPending} onClick={() => syncMutation.mutate()}>
              {syncMutation.isPending ? 'Syncing…' : 'Sync eTime'}
            </Button>
          )}
        </div>
      </div>

      {/* Summary Stat Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {statCards.map(s => (
          <button
            key={s.label}
            type="button"
            onClick={() => toggleCard(s.value)}
            className={`text-left bg-white rounded-xl border border-l-4 ${s.border} p-5 shadow-sm hover:shadow-md transition-all duration-200 ${status === s.value ? 'ring-2 ring-indigo-400 border-gray-200' : 'border-gray-100'}`}
          >
            <div className="flex items-start justify-between">
              <div>
                <p className="text-3xl font-bold text-gray-900 tracking-tight">{s.count}</p>
                <p className="text-sm font-medium text-gray-500 mt-1">{s.label}</p>
              </div>
              <div className={`w-10 h-10 ${s.iconBg} rounded-full flex items-center justify-center flex-shrink-0`}>
                <s.icon className={`w-5 h-5 ${s.iconColor}`} />
              </div>
            </div>
          </button>
        ))}
      </div>

      {/* Filter Bar */}
      <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-4">
        <div className="flex items-center gap-2 mb-3">
          <FunnelIcon className="w-4 h-4 text-gray-400" />
          <span className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Filters</span>
        </div>
        <div className="flex flex-wrap items-end gap-4">
          <div className="flex-1 min-w-[150px]">
            <label className="block text-xs font-medium text-gray-500 mb-1.5">Quick Range</label>
            <select className="w-full px-3 py-2 bg-gray-50 border border-gray-200 rounded-lg text-sm text-gray-700 focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-400 outline-none transition-all appearance-none cursor-pointer" value={range} onChange={e => applyRange(e.target.value)}>
              <option value="today">Today</option>
              <option value="yesterday">Yesterday</option>
              <option value="this_month">This Month</option>
              <option value="last_month">Last Month</option>
              <option value="custom">Custom</option>
            </select>
          </div>
          <div className="flex-1 min-w-[160px]">
            <label className="block text-xs font-medium text-gray-500 mb-1.5">From Date</label>
            <div className="relative">
              <CalendarDaysIcon className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400 pointer-events-none" />
              <input type="date" className="w-full pl-9 pr-3 py-2 bg-gray-50 border border-gray-200 rounded-lg text-sm text-gray-700 focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-400 outline-none transition-all" value={from} onChange={e => { setFrom(e.target.value); setRange('custom'); setPage(1); }} />
            </div>
          </div>
          <div className="flex-1 min-w-[160px]">
            <label className="block text-xs font-medium text-gray-500 mb-1.5">To Date</label>
            <div className="relative">
              <CalendarDaysIcon className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400 pointer-events-none" />
              <input type="date" className="w-full pl-9 pr-3 py-2 bg-gray-50 border border-gray-200 rounded-lg text-sm text-gray-700 focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-400 outline-none transition-all" value={to} onChange={e => { setTo(e.target.value); setRange('custom'); setPage(1); }} />
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
          <div className="min-w-[150px]">
            <label className="block text-xs font-medium text-gray-500 mb-1.5">Source</label>
            <select className="w-full px-3 py-2 bg-gray-50 border border-gray-200 rounded-lg text-sm text-gray-700 focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-400 outline-none transition-all appearance-none" value={source} onChange={e => { setSource(e.target.value); setPage(1); }}>
              <option value="">All Sources</option>
              <option value="etime_device">Device</option>
              <option value="manual_correction">Manual</option>
              <option value="web_checkin">Web</option>
            </select>
          </div>
          <div className="min-w-[170px]">
            <label className="block text-xs font-medium text-gray-500 mb-1.5">Export filter</label>
            <select className="w-full px-3 py-2 bg-gray-50 border border-gray-200 rounded-lg text-sm text-gray-700 focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-400 outline-none transition-all appearance-none" value={view} onChange={e => setView(e.target.value)} title="Applies to the Excel export">
              <option value="">All records</option>
              <option value="working">Working Days only</option>
              <option value="present">Present only</option>
              <option value="absent">Absent only</option>
              <option value="half">Half Day only</option>
              <option value="incomplete">Incomplete only</option>
              <option value="late">Late Arrivals</option>
              <option value="early">Early Exits</option>
              <option value="overtime">Overtime</option>
              <option value="less">Less than Required Hours</option>
              <option value="more">More than Required Hours</option>
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
              {tableLoading ? (
                Array(10).fill(0).map((_, i) => (
                  <tr key={i}>{Array(isHR() ? 8 : 7).fill(0).map((_, j) => (
                    <td key={j} className="px-5 py-4"><div className="h-4 bg-gray-100 rounded-md animate-pulse" /></td>
                  ))}</tr>
                ))
              ) : pageRows.length === 0 ? (
                <tr><td colSpan={9} className="px-5 py-16 text-center">
                  <div className="flex flex-col items-center gap-2">
                    <CalendarDaysIcon className="w-10 h-10 text-gray-300" />
                    <p className="text-sm text-gray-400 font-medium">
                      {isAbsentView ? 'No absentees for the selected period' : 'No attendance found for the selected period'}
                    </p>
                  </div>
                </td></tr>
              ) : (
                pageRows.map((item, i) => item.type === 'absent'
                  ? renderAbsentRow(item.a, `abs-${item.a.employee}-${item.date}-${i}`)
                  : renderRecordRow(item.r))
              )}
            </tbody>
          </table>
        </div>
        {totalPages > 1 && (
          <div className="px-5 py-3.5 border-t border-gray-100 flex items-center justify-between">
            <span className="text-sm text-gray-500">Showing <span className="font-medium text-gray-700">{((page-1)*limit)+1}&ndash;{Math.min(page*limit, displayTotal)}</span> of <span className="font-medium text-gray-700">{displayTotal}</span></span>
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
