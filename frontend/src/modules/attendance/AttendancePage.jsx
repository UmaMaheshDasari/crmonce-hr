import { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { attendanceApi, employeeApi } from '../../api/endpoints';
import { ArrowPathIcon, ClockIcon, UserGroupIcon, ExclamationTriangleIcon, XCircleIcon, FunnelIcon, CalendarDaysIcon, ComputerDesktopIcon, PencilSquareIcon, ArrowDownTrayIcon } from '@heroicons/react/24/outline';
import { useAuth } from '../../context/AuthContext';
import { format, startOfMonth, endOfMonth, subDays, subMonths, startOfYear } from 'date-fns';
import { formatDuration } from '../../utils/formatDuration';
import Button from '../../components/Button';
import AttendanceEditModal from './AttendanceEditModal';
import toast from 'react-hot-toast';
import { Link } from 'react-router-dom';

const STATUS_CONFIG = {
  present: { dot: 'bg-emerald-500', text: 'text-emerald-700', label: 'Present' },
  absent: { dot: 'bg-red-500', text: 'text-red-700', label: 'Absent' },
  half_day: { dot: 'bg-amber-500', text: 'text-amber-700', label: 'Half Day' },
  in_progress: { dot: 'bg-indigo-500 animate-pulse', text: 'text-indigo-700', label: 'In Progress' },
  incomplete: { dot: 'bg-slate-400', text: 'text-slate-600', label: 'Incomplete' },
};

/**
 * EFFECTIVE column cell with a LIVE running timer for TODAY's open session.
 * The backend marks today's open IN session as hr_status === 'in_progress' (today-only),
 * so the timer runs ONLY then. Live effective = server effective (completed IN→OUT
 * sessions, breaks already excluded) + time elapsed since the latest (open) IN punch.
 * Breaks are NOT counted (they precede the open IN). Previous days / closed sessions are
 * static. Self-contained interval → only this cell re-renders each second (never the table).
 */
function LiveEffective({ record }) {
  const isLive = record.hr_status === 'in_progress';
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    if (!isLive) return undefined;
    const id = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(id);
  }, [isLive]);

  // Base = completed effective hours (span − breaks; the open IN contributes 0 server-side).
  const base = Number(record.hr_effectivehours || record.hr_workedhours || 0);
  let eff = base;
  if (isLive) {
    let punches = [];
    try { punches = JSON.parse(record.hr_allpunches || '[]'); } catch { /* malformed → static base */ }
    const lastPunch = Array.isArray(punches) && punches.length ? String(punches[punches.length - 1]) : null;
    const m = lastPunch && lastPunch.match(/(\d{1,2}):(\d{2})/);
    if (m) {
      const openIn = new Date(); openIn.setHours(Number(m[1]) || 0, Number(m[2]) || 0, 0, 0);
      const elapsedH = (nowMs - openIn.getTime()) / 3600000;   // hours since the open IN punch
      if (elapsedH > 0) eff = base + elapsedH;                 // add the running open session
    }
  }

  const pct = Math.min((eff / 9) * 100, 100);
  const bar = eff >= 8 ? 'bg-emerald-500' : eff >= 4 ? 'bg-amber-500' : 'bg-red-400';
  const txt = eff >= 8 ? 'text-emerald-600' : eff >= 4 ? 'text-amber-600' : 'text-red-500';
  return (
    <div className="flex items-center gap-2">
      <div className="w-14 h-1.5 bg-gray-100 rounded-full overflow-hidden">
        <div className={`h-full rounded-full ${bar} transition-all duration-500`} style={{ width: `${pct}%` }} />
      </div>
      <span className={`text-sm font-semibold tabular-nums ${txt}`}>{formatDuration(eff)}</span>
      {isLive && (
        <span title="Live — counting the open session" className="inline-flex items-center gap-1 text-[9px] font-bold uppercase tracking-wide text-emerald-600">
          <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />Live
        </span>
      )}
    </div>
  );
}

export default function AttendancePage() {
  const { isHR } = useAuth();
  const qc = useQueryClient();
  const today = new Date();
  // Default date filter. Admin/HR open on TODAY — they manage day-to-day attendance
  // and should see today's records immediately, without picking the date each visit.
  // Employees keep the current-month view (behaviour unchanged). Uses the app's
  // existing local-time format() (never toISOString/UTC), so "today" is the HR
  // user's local/company date and never shifts to the previous/next day.
  const hrDefaults = isHR();
  const [from, setFrom] = useState(() => format(hrDefaults ? today : startOfMonth(today), 'yyyy-MM-dd'));
  const [to, setTo] = useState(() => format(hrDefaults ? today : endOfMonth(today), 'yyyy-MM-dd'));
  const [range, setRange] = useState(() => (hrDefaults ? 'today' : 'this_month'));   // quick date range preset
  const [empId, setEmpId] = useState('');
  const [status, setStatus] = useState('');
  const [source, setSource] = useState('');
  const [department, setDepartment] = useState('');   // HR filter
  const [late, setLate] = useState(false);            // HR filter — late arrivals
  const [missingPunch, setMissingPunch] = useState(false);   // HR filter — odd/open punches
  const [view, setView] = useState('');       // computed filter for export (late/early/overtime/…)
  const [exporting, setExporting] = useState(false);
  const [editRec, setEditRec] = useState(null);       // HR: attendance record being edited
  const [page, setPage] = useState(1);
  const limit = 20;

  // Any HR filter that needs server-side computed filtering forces the paged path.
  const hrFilterActive = !!department || late || missingPunch;
  // In the "All" view we fetch all rows for the range (up to 2000) so records and
  // synthesized absentees can be merged and sorted DATE-WISE on the client.
  const allView = status === '' && !hrFilterActive;
  const { data, isLoading } = useQuery({
    queryKey: ['attendance', empId, from, to, status, source, department, late, missingPunch, allView ? 'all' : page],
    queryFn: () => attendanceApi.list({ employeeId: empId, from, to, status, source, department: department || undefined, late: late || undefined, missingPunch: missingPunch || undefined, page: allView ? 1 : page, limit: allView ? 2000 : limit }),
    placeholderData: (prev) => prev,
  });

  // Aggregate stats for the cards — computed on the backend the SAME way as the
  // Excel export (Absent = Working − Attended − Leave), so all views agree.
  const { data: statsData } = useQuery({
    queryKey: ['attendance-stats', empId, from, to, department],
    queryFn: () => attendanceApi.stats({ employeeId: empId, from, to, department: department || undefined }),
    placeholderData: (prev) => prev,
  });
  const stats = statsData?.data;
  // Per-(employee,date) leave rows for the table overlay (approved/pending, no punch).
  const leaveDays = stats?.leaveDays || [];

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

  // Dynamic Attendance Start Date — the (selected) employee's earliest attendance
  // record. Drives the date-picker minDate + quick-filter clamping. Never hardcoded;
  // refetched per employee so each employee gets their OWN minimum selectable date.
  const { data: firstDateData } = useQuery({
    queryKey: ['attendance-first-date', empId],
    queryFn: () => attendanceApi.firstDate({ employeeId: empId || undefined }),
    placeholderData: (prev) => prev,
  });
  const startDate = firstDateData?.data?.firstDate || null;   // 'YYYY-MM-DD' or null
  const clampFrom = (d) => (startDate && d && d < startDate ? startDate : d);

  // The view opens on the CURRENT MONTH by default (employees should not initially
  // see every record). `startDate` is still used to clamp the pickers so nothing
  // before the first punch is selectable — but it no longer auto-expands the range.

  const guardDate = (v) => {
    if (startDate && v && v < startDate) {
      toast.error('Attendance records are available only from your first attendance date.');
      return startDate;   // auto-reset to the Attendance Start Date
    }
    return v;
  };

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
    let f = null, t = null;
    if (r === 'today') { f = fmt(now); t = fmt(now); }
    else if (r === 'yesterday') { const y = subDays(now, 1); f = fmt(y); t = fmt(y); }
    else if (r === 'this_month') { f = fmt(startOfMonth(now)); t = fmt(endOfMonth(now)); }
    else if (r === 'last_month') { const lm = subMonths(now, 1); f = fmt(startOfMonth(lm)); t = fmt(endOfMonth(lm)); }
    else if (r === 'this_year') { f = fmt(startOfYear(now)); t = fmt(now); }
    // 'custom' → keep current from/to, user edits the date inputs
    if (f !== null) { setFrom(clampFrom(f)); setTo(t); }   // clamp start to the Attendance Start Date
  };

  const resetFilters = () => {
    // Reset returns to the role's default: Admin/HR → Today, employees → this month.
    setRange(hrDefaults ? 'today' : 'this_month');
    setFrom(clampFrom(format(hrDefaults ? today : startOfMonth(today), 'yyyy-MM-dd')));
    setTo(format(hrDefaults ? today : endOfMonth(today), 'yyyy-MM-dd'));
    setEmpId(''); setStatus(''); setSource(''); setView(''); setDepartment(''); setLate(false); setMissingPunch(false); setPage(1);
  };

  const { data: empData } = useQuery({
    queryKey: ['employees-all'],
    queryFn: () => employeeApi.list({ limit: 500, status: 'active' }),
    enabled: isHR(),
  });

  // Departments for the HR department filter.
  const { data: deptData } = useQuery({
    queryKey: ['departments-list'],
    queryFn: () => employeeApi.departments(),
    enabled: isHR(),
  });
  const departments = (deptData?.data?.data || deptData?.data || []).map(d => (typeof d === 'string' ? d : (d?.name || d?.hr_name || d?.department))).filter(Boolean);

  // Year quick-filter → sets the range to a full calendar year.
  const applyYear = (y) => {
    if (!y) return;
    setRange('custom'); setPage(1);
    setFrom(clampFrom(`${y}-01-01`)); setTo(`${y}-12-31`);
  };
  const yearOptions = (() => { const y = today.getFullYear(); return [y, y - 1, y - 2, y - 3]; })();

  // Attendance now syncs via the Office Sync Agent (office LAN → HTTPS → backend →
  // Dataverse); the VPS never dials the office device. The button reports the agent's
  // status + latest sync result instead of attempting an (impossible) direct pull.
  const syncMutation = useMutation({
    mutationFn: () => attendanceApi.etimeSyncStatus(),
    onSuccess: (res) => {
      const s = res.data || {};
      qc.invalidateQueries({ queryKey: ['attendance'] });
      // Precise status per the actual architecture (agent ↔ device ↔ HR server).
      if (s.condition === 'offline') {
        toast.error('Office Attendance Sync Agent is offline.', { duration: 6000 });
        return;
      }
      if (s.condition === 'device_unavailable') {
        toast.error('ZK device is unavailable.', { duration: 6000 });
        return;
      }
      const r = s.lastResult;
      if (r) {
        toast.success(
          `Sync completed\nFetched: ${r.received} · Created: ${r.created} · Updated: ${r.updated} · Duplicates: ${r.duplicates} · Failed: ${r.failed}`,
          { duration: 7000 },
        );
      } else {
        toast('Office sync agent is online. Waiting for the first sync…', { icon: 'ℹ️', duration: 5000 });
      }
    },
    // The HR page can't reach the OFFICE agent directly; a read failure here means the
    // HR server/status call failed.
    onError: () => toast.error('HR server is unavailable.'),
  });

  const records = data?.data?.data || [];
  const serverTotal = data?.data?.count || 0;

  // Combined, DATE-WISE list. All view = records + absentees merged, newest date
  // first, with present/incomplete before absent within the same day. Absent-only
  // view = absentees. Both are paginated on the client. Other filters stay
  // server-paginated (records only).
  let combined = null;
  if (allView) {
    // Leave rows for dates the employee has NO punch on (present always wins).
    const recKeys = new Set(records.map(r => `${r._hr_hremployee_value}|${String(r.hr_date || '').slice(0, 10)}`));
    const leaveRows = leaveDays.filter(l => !recKeys.has(`${l.employeeId}|${l.date}`));
    combined = [
      ...records.map(r => ({ type: 'record', date: String(r.hr_date || '').slice(0, 10), r })),
      ...absentees.map(a => ({ type: 'absent', date: a.date, a })),
      ...leaveRows.map(l => ({ type: 'leave', date: l.date, l })),
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
    { label: 'Present', value: 'present', filterable: true, count: stats?.present ?? 0, icon: UserGroupIcon, iconBg: 'bg-emerald-100', iconColor: 'text-emerald-600', border: 'border-l-emerald-500' },
    { label: 'Absent', value: 'absent', filterable: true, count: stats?.absent ?? 0, icon: XCircleIcon, iconBg: 'bg-red-100', iconColor: 'text-red-600', border: 'border-l-red-500' },
    { label: 'Half Day', value: 'half_day', filterable: true, count: stats?.halfDay ?? 0, icon: ClockIcon, iconBg: 'bg-amber-100', iconColor: 'text-amber-600', border: 'border-l-amber-500' },
    { label: 'Incomplete', value: 'incomplete', filterable: true, count: stats?.incomplete ?? 0, icon: ExclamationTriangleIcon, iconBg: 'bg-slate-100', iconColor: 'text-slate-500', border: 'border-l-slate-400' },
    // Leave summary — informational (respects the same Employee / Date / Department filters).
    { label: 'Leave Applied', value: null, filterable: false, count: stats?.leaveApplied ?? 0, icon: CalendarDaysIcon, iconBg: 'bg-indigo-100', iconColor: 'text-indigo-600', border: 'border-l-indigo-500' },
    { label: 'Leave Pending', value: null, filterable: false, count: stats?.leavePending ?? 0, icon: ClockIcon, iconBg: 'bg-sky-100', iconColor: 'text-sky-600', border: 'border-l-sky-500' },
    { label: 'Leave Approved', value: null, filterable: false, count: stats?.leaveApproved ?? 0, icon: CalendarDaysIcon, iconBg: 'bg-teal-100', iconColor: 'text-teal-600', border: 'border-l-teal-500' },
  ];

  const toggleCard = (val) => { setStatus(status === val ? '' : val); setPage(1); };

  // Absent rows are synthesized (no attendance record exists for an absent day).
  const renderAbsentRow = (a, key) => (
    <tr key={key} className="hover:bg-red-50/30 transition-colors duration-150">
      {isHR() && <td className="px-5 py-4"><span className="text-sm font-semibold text-gray-900">{a.employee}</span></td>}
      <td className="px-5 py-4 text-sm text-gray-700 font-medium">{a.date ? format(new Date(a.date), 'dd-MM-yyyy') : '—'}</td>
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

  // A leave date with no punch — shown as Approved/Pending Leave + the leave type,
  // NEVER as Absent/LOP (pending) or hidden (approved). Same rule as payroll.
  const renderLeaveRow = (l, key) => {
    const approved = l.leaveStatus === 'approved';
    return (
      <tr key={key} className={`transition-colors duration-150 ${approved ? 'hover:bg-emerald-50/30' : 'hover:bg-sky-50/30'}`}>
        {isHR() && <td className="px-5 py-4"><span className="text-sm font-semibold text-gray-900">{l.employee}</span></td>}
        <td className="px-5 py-4 text-sm text-gray-700 font-medium">{l.date ? format(new Date(l.date), 'dd-MM-yyyy') : '—'}</td>
        <td className="px-5 py-4 text-sm text-gray-300">—</td>
        <td className="px-5 py-4 text-sm text-gray-300">—</td>
        <td className="px-5 py-4 text-sm text-gray-300">—</td>
        <td className="px-5 py-4 text-sm text-gray-300">—</td>
        <td className="px-5 py-4 text-sm text-gray-300">—</td>
        <td className="px-5 py-4 text-sm text-gray-300">—</td>
        <td className="px-5 py-4">
          <div className="flex flex-col gap-0.5">
            <span className={`inline-flex items-center gap-1.5 text-xs font-medium ${approved ? 'text-emerald-700' : 'text-sky-700'}`}>
              <span className={`w-2 h-2 rounded-full ${approved ? 'bg-emerald-500' : 'bg-sky-500'}`} />
              {approved ? 'Approved Leave' : 'Pending Leave'}
            </span>
            {l.leaveType && <span className="text-[11px] font-semibold text-gray-500 pl-3.5">{l.leaveType}</span>}
          </div>
        </td>
      </tr>
    );
  };

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
        <td className="px-5 py-4 text-sm text-gray-700 font-medium">{r.hr_date ? format(new Date(r.hr_date), 'dd-MM-yyyy') : '—'}</td>
        <td className="px-5 py-4"><span className="font-mono text-sm text-gray-600 bg-gray-50 px-2 py-0.5 rounded">{r.hr_intime || '—'}</span></td>
        <td className="px-5 py-4"><span className="font-mono text-sm text-gray-600 bg-gray-50 px-2 py-0.5 rounded">{r.hr_outtime || '—'}</span></td>
        <td className="px-5 py-4">
          {(() => {
            let punches = [];
            try { punches = JSON.parse(r.hr_allpunches || '[]'); } catch { /* malformed punches → empty */ }
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
          <LiveEffective record={r} />
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
          <div className="flex items-center gap-2">
            <span className={`inline-flex items-center gap-1.5 text-xs font-medium ${cfg.text}`}>
              <span className={`w-2 h-2 rounded-full ${cfg.dot}`} />
              {cfg.label}
            </span>
            {r.hr_lateloginapproved && (
              <span title="An approved Late Login covers this day" className="inline-flex items-center text-[11px] font-semibold text-indigo-700 bg-indigo-50 border border-indigo-100 px-2 py-0.5 rounded-full">
                {r.hr_lateloginlabel || 'Late Present'}
              </span>
            )}
            {isHR() && (
              <button onClick={() => setEditRec(r)} title="Edit attendance"
                className="p-1 rounded-md text-gray-400 hover:text-indigo-600 hover:bg-indigo-50">
                <PencilSquareIcon className="w-4 h-4" />
              </button>
            )}
          </div>
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
          <p className="text-sm text-gray-500 mt-1">Attendance Summary</p>
        </div>
        <div className="flex items-center gap-2 flex-wrap justify-end">
          <Link to="/attendance-requests">
            <Button variant="secondary" icon={PencilSquareIcon}>{isHR() ? 'Requests' : 'My Requests'}</Button>
          </Link>
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
            onClick={() => s.filterable && toggleCard(s.value)}
            className={`text-left bg-white rounded-xl border border-l-4 ${s.border} p-5 shadow-sm transition-all duration-200 ${s.filterable ? 'hover:shadow-md cursor-pointer' : 'cursor-default'} ${s.filterable && status === s.value ? 'ring-2 ring-indigo-400 border-gray-200' : 'border-gray-100'}`}
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
              <option value="this_year">This Year</option>
              <option value="custom">Custom Range</option>
            </select>
          </div>
          <div className="min-w-[110px]">
            <label className="block text-xs font-medium text-gray-500 mb-1.5">Year</label>
            <select className="w-full px-3 py-2 bg-gray-50 border border-gray-200 rounded-lg text-sm text-gray-700 focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-400 outline-none transition-all appearance-none cursor-pointer" value={to.slice(0, 4)} onChange={e => applyYear(e.target.value)}>
              {yearOptions.map(y => <option key={y} value={y}>{y}</option>)}
            </select>
          </div>
          <div className="flex-1 min-w-[160px]">
            <label className="block text-xs font-medium text-gray-500 mb-1.5">From Date</label>
            <div className="relative">
              <CalendarDaysIcon className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400 pointer-events-none" />
              <input type="date" min={startDate || undefined} className="w-full pl-9 pr-3 py-2 bg-gray-50 border border-gray-200 rounded-lg text-sm text-gray-700 focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-400 outline-none transition-all" value={from} onChange={e => { setFrom(guardDate(e.target.value)); setRange('custom'); setPage(1); }} />
            </div>
          </div>
          <div className="flex-1 min-w-[160px]">
            <label className="block text-xs font-medium text-gray-500 mb-1.5">To Date</label>
            <div className="relative">
              <CalendarDaysIcon className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400 pointer-events-none" />
              <input type="date" min={startDate || undefined} className="w-full pl-9 pr-3 py-2 bg-gray-50 border border-gray-200 rounded-lg text-sm text-gray-700 focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-400 outline-none transition-all" value={to} onChange={e => { setTo(guardDate(e.target.value)); setRange('custom'); setPage(1); }} />
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
              <option value="in_progress">In Progress</option>
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
          {isHR() && (
            <div className="min-w-[170px]">
              <label className="block text-xs font-medium text-gray-500 mb-1.5">Department</label>
              <select className="w-full px-3 py-2 bg-gray-50 border border-gray-200 rounded-lg text-sm text-gray-700 focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-400 outline-none transition-all appearance-none" value={department} onChange={e => { setDepartment(e.target.value); setPage(1); }}>
                <option value="">All Departments</option>
                {departments.map(d => <option key={d} value={d}>{d}</option>)}
              </select>
            </div>
          )}
          {isHR() && (
            <div className="flex items-end gap-3 pb-0.5">
              <label className="inline-flex items-center gap-1.5 text-xs font-medium text-gray-600 cursor-pointer">
                <input type="checkbox" checked={late} onChange={e => { setLate(e.target.checked); setPage(1); }} /> Late Entry
              </label>
              <label className="inline-flex items-center gap-1.5 text-xs font-medium text-gray-600 cursor-pointer">
                <input type="checkbox" checked={missingPunch} onChange={e => { setMissingPunch(e.target.checked); setPage(1); }} /> Missing Punch
              </label>
              <label className="inline-flex items-center gap-1.5 text-xs font-medium text-gray-600 cursor-pointer">
                <input type="checkbox" checked={status === 'absent'} onChange={e => { setStatus(e.target.checked ? 'absent' : ''); setPage(1); }} /> LOP / Absent
              </label>
            </div>
          )}
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
                  : item.type === 'leave'
                    ? renderLeaveRow(item.l, `lv-${item.l.employeeId}-${item.date}-${i}`)
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

      {editRec && <AttendanceEditModal record={editRec} onClose={() => setEditRec(null)} />}
    </div>
  );
}
