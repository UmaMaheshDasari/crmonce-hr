import { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { format, startOfMonth, endOfMonth, subMonths, startOfYear, endOfYear, subYears } from 'date-fns';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from 'recharts';
import toast from 'react-hot-toast';
import {
  UsersIcon, ClockIcon, BriefcaseIcon, CurrencyDollarIcon, CalendarDaysIcon,
  PencilSquareIcon, UserPlusIcon, DocumentTextIcon, ArrowRightOnRectangleIcon,
  ArrowLeftOnRectangleIcon, SignalIcon,
} from '@heroicons/react/24/outline';
import { dashboardApi, attendanceApi, lateLoginApi } from '../../api/endpoints';
import { useAuth } from '../../context/AuthContext';
import ActivityFeed from '../../components/ActivityFeed';
import TodaysCelebrations from './TodaysCelebrations';
import { formatDuration, formatMinutes } from '../../utils/formatDuration';

function greeting() {
  const h = new Date().getHours();
  return h < 12 ? 'Good Morning' : h < 17 ? 'Good Afternoon' : 'Good Evening';
}
function money(n) {
  if (n == null || isNaN(n)) return '₹0';
  if (n >= 1e7) return `₹${(n / 1e7).toFixed(1)}Cr`;
  if (n >= 1e5) return `₹${(n / 1e5).toFixed(1)}L`;
  if (n >= 1e3) return `₹${(n / 1e3).toFixed(1)}K`;
  return `₹${n}`;
}
function useClock() {
  const [now, setNow] = useState(new Date());
  useEffect(() => { const t = setInterval(() => setNow(new Date()), 1000); return () => clearInterval(t); }, []);
  return now;
}

function Kpi({ icon: Icon, label, value, sub, iconBg, iconColor }) {
  return (
    <div className="bg-white rounded-xl border border-gray-100 p-4 flex items-center gap-3.5 h-full">
      <div className={`w-11 h-11 rounded-lg grid place-items-center flex-shrink-0 ${iconBg}`}>
        <Icon className={`w-5 h-5 ${iconColor}`} />
      </div>
      <div className="min-w-0">
        <p className="text-2xl font-bold text-gray-900 tabular-nums leading-none">{value}</p>
        <p className="text-xs font-semibold text-gray-500 mt-1 leading-tight truncate">{label}</p>
        {sub != null && <p className="text-[10px] text-gray-400 leading-tight truncate">{sub}</p>}
      </div>
    </div>
  );
}

function ActionCard({ icon: Icon, label, value, to, iconBg, iconColor }) {
  return (
    <Link to={to} className="bg-white rounded-xl border border-gray-100 p-3 flex items-center gap-3 hover:shadow-sm hover:border-gray-200 transition-all">
      <div className={`w-9 h-9 rounded-lg grid place-items-center flex-shrink-0 ${iconBg}`}>
        <Icon className={`w-4.5 h-4.5 ${iconColor}`} />
      </div>
      <div className="min-w-0">
        <p className="text-lg font-bold text-gray-900 tabular-nums leading-none">{value}</p>
        <p className="text-[11px] font-medium text-gray-500 leading-tight truncate">{label}</p>
      </div>
    </Link>
  );
}

function Stat({ label, value, tone = 'text-gray-800' }) {
  return (
    <div className="bg-gray-50 rounded-lg px-2.5 py-2 text-center">
      <p className="text-[10px] uppercase tracking-wider text-gray-400 font-semibold">{label}</p>
      <p className={`text-sm font-bold tabular-nums ${tone}`}>{value}</p>
    </div>
  );
}

function ChartTooltip({ active, payload, label }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="bg-gray-900 text-white px-3 py-2 rounded-lg shadow-xl text-xs">
      <p className="font-semibold mb-1">{label}</p>
      {payload.map((e, i) => (
        <p key={i} className="flex items-center gap-2">
          <span className="w-2 h-2 rounded-full" style={{ backgroundColor: e.color }} />{e.name}: <span className="font-bold">{e.value}</span>
        </p>
      ))}
    </div>
  );
}

export default function AdminDashboard() {
  const { user } = useAuth();
  const qc = useQueryClient();
  const now = useClock();

  const [leaveRange, setLeaveRange] = useState('this_year');
  const period = (() => {
    const dt = new Date(), f = (x) => format(x, 'yyyy-MM-dd');
    switch (leaveRange) {
      case 'this_month': return { from: f(startOfMonth(dt)), to: f(endOfMonth(dt)) };
      case 'last_month': { const lm = subMonths(dt, 1); return { from: f(startOfMonth(lm)), to: f(endOfMonth(lm)) }; }
      case 'last_year': { const ly = subYears(dt, 1); return { from: f(startOfYear(ly)), to: f(endOfYear(ly)) }; }
      default: return { from: f(startOfYear(dt)), to: f(endOfYear(dt)) };   // this_year
    }
  })();

  const { data, isLoading } = useQuery({
    queryKey: ['admin-summary', period.from, period.to],
    queryFn: () => dashboardApi.adminSummary({ from: period.from, to: period.to }),
    placeholderData: (prev) => prev,
    refetchInterval: 60000,
  });
  const d = data?.data;
  const k = d?.kpis, a = d?.actions, t = d?.today, lv = d?.leave;

  // Org-wide Late Login summary (this month) — HR approval workload.
  const llMonth = format(new Date(), 'yyyy-MM');
  const { data: llRes } = useQuery({ queryKey: ['late-login-summary', 'admin', llMonth], queryFn: () => lateLoginApi.summary({ month: llMonth }).then(r => r.data), refetchInterval: 60000 });
  const ll = llRes || null;

  const invalidate = () => qc.invalidateQueries({ queryKey: ['admin-summary'] });
  const checkin = useMutation({ mutationFn: () => attendanceApi.checkin(), onSuccess: () => { toast.success('Checked in!'); invalidate(); }, onError: (e) => toast.error(e.response?.data?.error || 'Check-in failed') });
  const checkout = useMutation({ mutationFn: () => attendanceApi.checkout(), onSuccess: () => { toast.success('Checked out!'); invalidate(); }, onError: (e) => toast.error(e.response?.data?.error || 'Check-out failed') });
  const busy = checkin.isPending || checkout.isPending;

  const kpis = k ? [
    { icon: UsersIcon, label: 'Total Employees', value: k.totalEmployees, sub: 'active headcount', iconBg: 'bg-indigo-50', iconColor: 'text-indigo-600' },
    { icon: ClockIcon, label: 'Present Today', value: k.presentToday, sub: `of ${k.totalEmployees}`, iconBg: 'bg-emerald-50', iconColor: 'text-emerald-600' },
    { icon: BriefcaseIcon, label: 'Open Positions', value: k.openPositions, sub: 'hiring now', iconBg: 'bg-amber-50', iconColor: 'text-amber-600' },
    { icon: CurrencyDollarIcon, label: 'Payroll Status', value: k.payroll.status, sub: k.payroll.netTotal ? money(k.payroll.netTotal) : 'this month', iconBg: 'bg-violet-50', iconColor: 'text-violet-600' },
  ] : [];

  const actions = a ? [
    { icon: CalendarDaysIcon, label: 'Pending Leave Approvals', value: a.pendingLeaveApprovals, to: '/leave', iconBg: 'bg-amber-50', iconColor: 'text-amber-600' },
    { icon: PencilSquareIcon, label: 'Corrections Pending', value: a.correctionsPending, to: '/attendance', iconBg: 'bg-orange-50', iconColor: 'text-orange-600' },
    { icon: UserPlusIcon, label: 'New Employees This Month', value: a.newEmployeesThisMonth, to: '/employees', iconBg: 'bg-emerald-50', iconColor: 'text-emerald-600' },
    { icon: DocumentTextIcon, label: 'Documents Pending Review', value: a.documentsPendingReview, to: '/documents', iconBg: 'bg-blue-50', iconColor: 'text-blue-600' },
  ] : [];

  const leaveCards = lv ? [
    { label: 'Pending', value: lv.pendingCount, sub: `${lv.pendingDays} day${lv.pendingDays === 1 ? '' : 's'}`, tone: 'text-amber-700 bg-amber-50' },
    { label: 'Approved', value: lv.approvedCount, sub: `${lv.approvedDays} day${lv.approvedDays === 1 ? '' : 's'}`, tone: 'text-emerald-700 bg-emerald-50' },
    { label: 'Rejected', value: lv.rejectedCount, sub: 'requests', tone: 'text-red-700 bg-red-50' },
    { label: 'Leave Taken', value: lv.taken, sub: lv.hasActivity ? 'approved days' : 'No leave activity for the selected period', tone: 'text-indigo-700 bg-indigo-50' },
  ] : [];

  return (
    <div className="space-y-5">
      {/* ── Compact hero ─────────────────────────────────────────────────── */}
      <div className="rounded-2xl bg-gradient-to-br from-indigo-600 via-indigo-700 to-violet-700 px-5 py-3.5">
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <div className="min-w-0">
            <h1 className="text-lg sm:text-xl font-bold text-white leading-tight">
              {greeting()}, {d?.employee?.name?.split(' ')[0] || user?.name?.split(' ')[0] || 'Admin'}
            </h1>
            <p className="text-indigo-200 text-xs mt-0.5">
              {now.toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}
              {' · '}<span className="tabular-nums">{now.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true })}</span>
            </p>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            {d?.shift && <span className="text-xs font-medium bg-white/15 text-white ring-1 ring-white/25 px-3 py-1.5 rounded-lg">Shift {d.shift.start}–{d.shift.end}</span>}
            <span className="text-xs font-semibold bg-emerald-400/25 text-emerald-50 ring-1 ring-emerald-300/40 px-3 py-1.5 rounded-lg flex items-center gap-1.5">
              <SignalIcon className="w-3.5 h-3.5" /> {d ? 'All systems operational' : 'Connecting…'}
            </span>
          </div>
        </div>
      </div>

      {/* ── 4 KPI cards ──────────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {isLoading && !d
          ? Array.from({ length: 4 }).map((_, i) => <div key={i} className="bg-gray-50 rounded-xl h-[76px] animate-pulse" />)
          : kpis.map(c => <Kpi key={c.label} {...c} />)}
      </div>

      {/* ── Attendance Overview + Action items ───────────────────────────── */}
      <div className="grid grid-cols-1 xl:grid-cols-3 gap-5">
        <div className="xl:col-span-2 bg-white rounded-xl border border-gray-100 p-5">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-base font-bold text-gray-900">Attendance Overview</h2>
            <div className="flex items-center gap-3 text-[11px]">
              <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-indigo-500" /> Present</span>
              <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-red-400" /> Absent</span>
              <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-amber-400" /> Late</span>
            </div>
          </div>
          <ResponsiveContainer width="100%" height={130}>
            <BarChart data={d?.overview || []} barGap={2} barSize={14}>
              <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" vertical={false} />
              <XAxis dataKey="day" tick={{ fontSize: 11, fill: '#94a3b8' }} axisLine={false} tickLine={false} />
              <YAxis tick={{ fontSize: 11, fill: '#94a3b8' }} axisLine={false} tickLine={false} width={24} />
              <Tooltip content={<ChartTooltip />} cursor={{ fill: '#f8fafc' }} />
              <Bar dataKey="present" name="Present" fill="#6366f1" radius={[4, 4, 0, 0]} />
              <Bar dataKey="absent" name="Absent" fill="#f87171" radius={[4, 4, 0, 0]} />
              <Bar dataKey="late" name="Late" fill="#fbbf24" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>

        <div className="grid grid-cols-2 xl:grid-cols-1 gap-3 content-start">
          {actions.length
            ? actions.map(c => <ActionCard key={c.label} {...c} />)
            : Array.from({ length: 4 }).map((_, i) => <div key={i} className="bg-gray-50 rounded-xl h-[60px] animate-pulse" />)}
          {ll && <ActionCard icon={ClockIcon} label="Late Login Requests Pending" value={ll.pending || 0} to="/late-login" iconBg="bg-rose-50" iconColor="text-rose-600" />}
        </div>
      </div>

      {/* ── Attendance widget + Recent Activity ──────────────────────────── */}
      <div className="grid grid-cols-1 xl:grid-cols-3 gap-5">
        {/* My attendance */}
        <div className="bg-white rounded-xl border border-gray-100 p-5">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-base font-bold text-gray-900">My Attendance</h2>
            <p className="text-sm font-bold text-gray-900 tabular-nums">{now.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true })}</p>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <Stat label="Shift" value={d?.shift ? `${d.shift.start}–${d.shift.end}` : '—'} />
            <Stat label="Status" value={t ? (t.state === 'in' ? 'Working' : t.status.replace('_', ' ')) : '—'} tone="text-indigo-700" />
            <Stat label="First Punch" value={t?.firstPunch || '—'} />
            <Stat label="Last Punch" value={t?.lastPunch || '—'} />
            <Stat label="Worked" value={formatDuration(t?.workedHours)} />
            <Stat label="Break" value={formatDuration(t?.breakHours)} tone="text-amber-700" />
            <Stat label="Effective" value={formatDuration(t?.effectiveHours)} tone="text-emerald-700" />
            <Stat label="Late By" value={formatMinutes(t?.lateByMin)} tone={t?.lateByMin > 0 ? 'text-amber-700' : 'text-gray-800'} />
          </div>
          <div className="mt-4">
            {t?.canCheckOut ? (
              <button onClick={() => checkout.mutate()} disabled={busy}
                className="w-full flex items-center justify-center gap-2 py-2.5 rounded-xl text-white font-semibold text-sm bg-gradient-to-r from-rose-500 to-red-600 hover:from-rose-600 hover:to-red-700 disabled:opacity-50 transition-all">
                <ArrowLeftOnRectangleIcon className="w-5 h-5" />{checkout.isPending ? 'Checking out…' : 'Check Out'}
              </button>
            ) : (
              <button onClick={() => checkin.mutate()} disabled={busy}
                className="w-full flex items-center justify-center gap-2 py-2.5 rounded-xl text-white font-semibold text-sm bg-gradient-to-r from-emerald-500 to-green-600 hover:from-emerald-600 hover:to-green-700 disabled:opacity-50 transition-all">
                <ArrowRightOnRectangleIcon className="w-5 h-5" />{checkin.isPending ? 'Checking in…' : (t?.punchCount > 0 ? 'Check In Again' : 'Check In')}
              </button>
            )}
          </div>
        </div>

        {/* Recent Activity (above Leave Summary) */}
        <div className="xl:col-span-2 bg-white rounded-xl border border-gray-100 p-5">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-base font-bold text-gray-900">Recent Activity</h2>
            <Link to="/activities" className="text-xs font-semibold text-indigo-600 hover:text-indigo-700">View all →</Link>
          </div>
          <ActivityFeed items={d?.activity ?? []} loading={isLoading && !d} emptyText="No recent activity yet." />
        </div>
      </div>

      {/* ── Today's Celebrations ──────────────────────────────────────────── */}
      <TodaysCelebrations />

      {/* ── Leave Summary (compact) ──────────────────────────────────────── */}
      <div className="bg-white rounded-xl border border-gray-100 p-5">
        <div className="flex items-center justify-between gap-2 mb-4 flex-wrap">
          <h2 className="text-base font-bold text-gray-900">Leave Summary</h2>
          <select value={leaveRange} onChange={e => setLeaveRange(e.target.value)}
            className="h-8 px-2 bg-gray-50 border border-gray-200 rounded-lg text-xs text-gray-700 outline-none focus:ring-2 focus:ring-indigo-500/20 cursor-pointer">
            <option value="this_month">This Month</option>
            <option value="last_month">Last Month</option>
            <option value="this_year">This Year</option>
            <option value="last_year">Last Year</option>
          </select>
        </div>
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          {leaveCards.length
            ? leaveCards.map(c => (
              <div key={c.label} className={`rounded-xl px-4 py-3 ${c.tone}`}>
                <p className="text-2xl font-extrabold tabular-nums leading-none">{c.value}</p>
                <p className="text-[13px] font-semibold mt-1.5 leading-tight">{c.label}</p>
                <p className="text-[11px] mt-0.5 opacity-70 leading-tight">{c.sub}</p>
              </div>
            ))
            : Array.from({ length: 4 }).map((_, i) => <div key={i} className="rounded-xl bg-gray-50 h-[74px] animate-pulse" />)}
        </div>
      </div>
    </div>
  );
}
