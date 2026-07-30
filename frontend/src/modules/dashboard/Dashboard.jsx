import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { format, startOfMonth, endOfMonth, subMonths, startOfYear, endOfYear, subYears } from 'date-fns';
import { employeeApi, attendanceApi, leaveApi, payrollApi, recruitmentApi, activityApi } from '../../api/endpoints';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from 'recharts';
import { UsersIcon, ClockIcon, CurrencyDollarIcon, BriefcaseIcon, ArrowTrendingUpIcon, ArrowTrendingDownIcon } from '@heroicons/react/24/outline';
import { useAuth } from '../../context/AuthContext';
import CheckInOut from '../../components/CheckInOut';
import ActivityFeed from '../../components/ActivityFeed';
import EmployeeDashboard from './EmployeeDashboard';

const BORDER_COLORS = {
  'text-indigo-600': 'border-l-indigo-500',
  'text-green-600': 'border-l-emerald-500',
  'text-amber-600': 'border-l-amber-500',
  'text-purple-600': 'border-l-violet-500',
};
const BG_COLORS = {
  'text-indigo-600': 'bg-indigo-50',
  'text-green-600': 'bg-emerald-50',
  'text-amber-600': 'bg-amber-50',
  'text-purple-600': 'bg-violet-50',
};
const ICON_COLORS = {
  'text-indigo-600': 'text-indigo-500',
  'text-green-600': 'text-emerald-500',
  'text-amber-600': 'text-amber-500',
  'text-purple-600': 'text-violet-500',
};

function KPICard({ label, value, icon: Icon, color, sub, loading, trend }) {
  if (loading) return <SkeletonCard />;
  return (
    <div className={`bg-white rounded-xl border border-gray-100 border-l-4 ${BORDER_COLORS[color] || 'border-l-gray-300'} p-5 hover:shadow-lg hover:-translate-y-0.5 transition-all duration-300 group`}>
      <div className="flex items-start justify-between">
        <div className="space-y-1">
          <p className="text-xs font-semibold uppercase tracking-wider text-gray-400">{label}</p>
          <p className="text-3xl font-extrabold text-gray-900 tabular-nums">{value ?? 'N/A'}</p>
          <div className="flex items-center gap-1.5">
            {trend && (
              <span className={`flex items-center gap-0.5 text-xs font-medium ${trend === 'up' ? 'text-emerald-600' : 'text-red-500'}`}>
                {trend === 'up' ? <ArrowTrendingUpIcon className="w-3.5 h-3.5" /> : <ArrowTrendingDownIcon className="w-3.5 h-3.5" />}
              </span>
            )}
            {sub && <p className="text-xs text-gray-400 font-medium">{sub}</p>}
          </div>
        </div>
        <div className={`p-3 rounded-xl ${BG_COLORS[color] || 'bg-gray-100'} group-hover:scale-110 transition-transform duration-300`}>
          <Icon className={`w-6 h-6 ${ICON_COLORS[color] || 'text-gray-500'}`} />
        </div>
      </div>
    </div>
  );
}

function SkeletonCard() {
  return (
    <div className="bg-white rounded-xl border border-gray-100 border-l-4 border-l-gray-200 p-5">
      <div className="animate-pulse space-y-3">
        <div className="h-3 w-24 bg-gray-100 rounded-full" />
        <div className="h-8 w-16 bg-gray-100 rounded-lg" />
        <div className="h-3 w-20 bg-gray-50 rounded-full" />
      </div>
    </div>
  );
}

function CustomTooltip({ active, payload, label }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="bg-gray-900 text-white px-4 py-2.5 rounded-lg shadow-xl text-xs">
      <p className="font-semibold mb-1">{label}</p>
      {payload.map((entry, i) => (
        <p key={i} className="flex items-center gap-2">
          <span className="w-2 h-2 rounded-full" style={{ backgroundColor: entry.color }} />
          {entry.name}: <span className="font-bold">{entry.value}</span>
        </p>
      ))}
    </div>
  );
}

function formatCurrency(amount) {
  if (amount == null || isNaN(amount)) return 'N/A';
  if (amount >= 100000) return `₹${(amount / 100000).toFixed(1)}L`;
  if (amount >= 1000) return `₹${(amount / 1000).toFixed(1)}K`;
  return `₹${amount}`;
}

function getGreeting() {
  const hour = new Date().getHours();
  if (hour < 12) return 'Good morning';
  if (hour < 17) return 'Good afternoon';
  return 'Good evening';
}

// Thin router: employees get the redesigned single-API dashboard; HR/admins keep
// the operational overview below.
export default function Dashboard() {
  const { isHR } = useAuth();
  return isHR() ? <HRDashboard /> : <EmployeeDashboard />;
}

function HRDashboard() {
  const { user } = useAuth();

  const { data: empData, isLoading: empLoading } = useQuery({
    queryKey: ['employees-count'],
    queryFn: () => employeeApi.list({ limit: 1, status: 'active' }),
  });
  const { data: jobsData, isLoading: jobsLoading } = useQuery({
    queryKey: ['jobs-open'],
    queryFn: () => recruitmentApi.jobs({ status: 'open' }),
  });

  const today = new Date().toISOString().split('T')[0];
  const { data: todayAttendance, isLoading: todayAttLoading } = useQuery({
    queryKey: ['attendance-today', today],
    queryFn: () => attendanceApi.list({ from: today, to: today, limit: 500 }),
  });
  const { data: pendingLeaves, isLoading: pendingLeavesLoading } = useQuery({
    queryKey: ['leaves-pending'],
    queryFn: () => leaveApi.list({ status: 'pending' }),
  });

  const currentMonth = new Date().getMonth() + 1;
  const currentYear = new Date().getFullYear();
  const { data: payrollData, isLoading: payrollLoading } = useQuery({
    queryKey: ['payroll-current', currentMonth, currentYear],
    queryFn: () => payrollApi.list({ month: currentMonth, year: currentYear, limit: 500 }),
  });

  const presentToday = todayAttendance?.data?.data?.length ?? todayAttendance?.data?.count ?? 0;
  const totalPayroll = (() => {
    const records = payrollData?.data?.data;
    if (!Array.isArray(records) || records.length === 0) return null;
    return records.reduce((sum, r) => sum + (r.hr_netpay || 0), 0);
  })();

  const { data: weeklyData } = useQuery({
    queryKey: ['attendance-weekly'],
    queryFn: () => attendanceApi.weekly(),
  });
  const weeklyAttendanceData = weeklyData?.data?.data
    || ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'].map(day => ({ day, present: 0, absent: 0 }));

  const { data: activityData, isLoading: activityLoading } = useQuery({
    queryKey: ['recent-activity'],
    queryFn: () => activityApi.list(6),
    refetchInterval: 30000,
  });
  const activityItems = activityData?.data?.data ?? [];

  // HR's own leave summary (period-filtered).
  const [leaveRange, setLeaveRange] = useState('this_year');
  const [leaveCustom, setLeaveCustom] = useState({ from: '', to: '' });
  const leavePeriod = (() => {
    const d = new Date(), fmt = (x) => format(x, 'yyyy-MM-dd');
    switch (leaveRange) {
      case 'this_month': return { from: fmt(startOfMonth(d)), to: fmt(endOfMonth(d)) };
      case 'last_month': { const lm = subMonths(d, 1); return { from: fmt(startOfMonth(lm)), to: fmt(endOfMonth(lm)) }; }
      case 'last_year': { const ly = subYears(d, 1); return { from: fmt(startOfYear(ly)), to: fmt(endOfYear(ly)) }; }
      case 'custom': return { from: leaveCustom.from || undefined, to: leaveCustom.to || undefined };
      default: return { from: fmt(startOfYear(d)), to: fmt(endOfYear(d)) };   // this_year
    }
  })();
  const { data: leaveSummaryData } = useQuery({
    queryKey: ['leave-summary', user?.id, leavePeriod.from, leavePeriod.to],
    queryFn: () => leaveApi.summary({ from: leavePeriod.from, to: leavePeriod.to }),
    enabled: !!user?.id && (leaveRange !== 'custom' || (!!leaveCustom.from && !!leaveCustom.to)),
  });
  const ls = leaveSummaryData?.data;
  const leaveCards = ls ? [
    { label: 'Pending Approval', value: ls.pendingCount ?? 0, sub: `${ls.pendingDays ?? 0} day${ls.pendingDays === 1 ? '' : 's'}`, tone: 'text-amber-700 bg-amber-50' },
    { label: 'Approved Leaves', value: ls.approvedCount ?? 0, sub: `${ls.approvedDays ?? 0} day${ls.approvedDays === 1 ? '' : 's'}`, tone: 'text-emerald-700 bg-emerald-50' },
    { label: 'Rejected Leaves', value: ls.rejectedCount ?? 0, sub: 'requests', tone: 'text-red-700 bg-red-50' },
    { label: 'Total Leave Taken', value: ls.taken ?? 0,
      sub: (ls.approvedCount ?? 0) === 0 ? 'No approved leave for selected period' : 'approved days',
      tone: 'text-indigo-700 bg-indigo-50' },
  ] : [];

  return (
    <div className="space-y-8">
      {/* Welcome Banner */}
      <div className="relative overflow-hidden rounded-2xl bg-gradient-to-br from-indigo-600 via-indigo-700 to-violet-700 p-6">
        <div className="absolute inset-0 bg-[url('data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iNjAiIGhlaWdodD0iNjAiIHZpZXdCb3g9IjAgMCA2MCA2MCIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj48ZyBmaWxsPSJub25lIiBmaWxsLXJ1bGU9ImV2ZW5vZGQiPjxnIGZpbGw9IiNmZmYiIGZpbGwtb3BhY2l0eT0iMC4wMyI+PHBhdGggZD0iTTM2IDE4YzAtOS45NC04LjA2LTE4LTE4LTE4UzAgOC4wNiAwIDE4czguMDYgMTggMTggMTggMTgtOC4wNiAxOC0xOCIvPjwvZz48L2c+PC9zdmc+')] opacity-50" />
        <div className="relative">
          <h1 className="text-2xl sm:text-3xl font-bold text-white">
            {getGreeting()}, {user?.name?.split(' ')[0] || 'there'}
          </h1>
          <p className="text-indigo-200 mt-1.5 text-sm">
            {new Date().toLocaleDateString('en-IN', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-5">
        <KPICard label="Total Employees" value={empData?.data?.count ?? 0} icon={UsersIcon} color="text-indigo-600" sub="Active headcount" loading={empLoading} trend="up" />
        <KPICard label="Present Today" value={presentToday} icon={ClockIcon} color="text-green-600" sub="Via eTime sync" loading={todayAttLoading} trend="up" />
        <KPICard label="Open Positions" value={jobsData?.data?.data?.length ?? 0} icon={BriefcaseIcon} color="text-amber-600" sub="Hiring now" loading={jobsLoading} />
        <KPICard label="Payroll This Month" value={formatCurrency(totalPayroll)} icon={CurrencyDollarIcon} color="text-purple-600" sub={totalPayroll != null ? 'Processed' : 'Not yet processed'} loading={payrollLoading} />
      </div>
      <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
        <div className="xl:col-span-2" />
        <CheckInOut compact />
      </div>

      {/* Charts & Quick Stats */}
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
        <div className="bg-white rounded-xl border border-gray-100 p-6 hover:shadow-md transition-shadow duration-300">
          <div className="flex items-center justify-between mb-6">
            <div>
              <h2 className="text-base font-bold text-gray-900">Attendance Overview</h2>
              <p className="text-xs text-gray-400 mt-0.5">This week's attendance breakdown</p>
            </div>
            <div className="flex items-center gap-4 text-xs">
              <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-full bg-indigo-500" /> Present</span>
              <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-full bg-red-400" /> Absent</span>
            </div>
          </div>
          {todayAttLoading ? (
            <div className="h-[220px] animate-pulse bg-gray-50 rounded-xl" />
          ) : (
            <ResponsiveContainer width="100%" height={220}>
              <BarChart data={weeklyAttendanceData} barGap={6} barSize={32}>
                <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" vertical={false} />
                <XAxis dataKey="day" tick={{ fontSize: 12, fill: '#94a3b8' }} axisLine={false} tickLine={false} />
                <YAxis tick={{ fontSize: 12, fill: '#94a3b8' }} axisLine={false} tickLine={false} />
                <Tooltip content={<CustomTooltip />} cursor={{ fill: '#f8fafc' }} />
                <Bar dataKey="present" name="Present" fill="#6366f1" radius={[6, 6, 0, 0]} />
                <Bar dataKey="absent" name="Absent" fill="#f87171" radius={[6, 6, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          )}
        </div>

        <div className="bg-white rounded-xl border border-gray-100 p-6 hover:shadow-md transition-shadow duration-300">
          <div className="mb-6">
            <h2 className="text-base font-bold text-gray-900">Quick Stats</h2>
            <p className="text-xs text-gray-400 mt-0.5">Key metrics at a glance</p>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="bg-amber-50/60 rounded-xl p-4 border border-amber-100/50">
              <p className="text-xs font-semibold uppercase tracking-wider text-amber-600/70 mb-1">Pending Leaves</p>
              <p className="text-2xl font-extrabold text-amber-700 tabular-nums">
                {pendingLeavesLoading ? <span className="inline-block w-6 h-6 bg-amber-100 rounded animate-pulse" /> : (pendingLeaves?.data?.data?.length ?? 0)}
              </p>
            </div>
            <div className="bg-indigo-50/60 rounded-xl p-4 border border-indigo-100/50">
              <p className="text-xs font-semibold uppercase tracking-wider text-indigo-600/70 mb-1">Active Employees</p>
              <p className="text-2xl font-extrabold text-indigo-700 tabular-nums">
                {empLoading ? <span className="inline-block w-6 h-6 bg-indigo-100 rounded animate-pulse" /> : (empData?.data?.count ?? 0)}
              </p>
            </div>
            <div className="bg-emerald-50/60 rounded-xl p-4 border border-emerald-100/50">
              <p className="text-xs font-semibold uppercase tracking-wider text-emerald-600/70 mb-1">Open Positions</p>
              <p className="text-2xl font-extrabold text-emerald-700 tabular-nums">
                {jobsLoading ? <span className="inline-block w-6 h-6 bg-emerald-100 rounded animate-pulse" /> : (jobsData?.data?.data?.length ?? 0)}
              </p>
            </div>
            <div className="bg-violet-50/60 rounded-xl p-4 border border-violet-100/50">
              <p className="text-xs font-semibold uppercase tracking-wider text-violet-600/70 mb-1">Monthly Payroll</p>
              <p className="text-2xl font-extrabold text-violet-700 tabular-nums">
                {payrollLoading ? <span className="inline-block w-6 h-6 bg-violet-100 rounded animate-pulse" /> : formatCurrency(totalPayroll)}
              </p>
            </div>
          </div>
        </div>
      </div>

      {/* Leave Summary */}
      <div className="bg-white rounded-xl border border-gray-100 p-5">
        <div className="flex items-center justify-between gap-3 mb-4 flex-wrap">
          <h2 className="text-base font-bold text-gray-900">Leave Summary</h2>
          <div className="flex items-center gap-2 flex-wrap">
            <select value={leaveRange} onChange={e => setLeaveRange(e.target.value)}
              className="h-9 px-3 bg-gray-50 border border-gray-200 rounded-lg text-sm text-gray-700 focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-400 outline-none cursor-pointer">
              <option value="this_month">This Month</option>
              <option value="last_month">Last Month</option>
              <option value="this_year">This Year</option>
              <option value="last_year">Last Year</option>
              <option value="custom">Custom Range</option>
            </select>
            {leaveRange === 'custom' && (
              <>
                <input type="date" value={leaveCustom.from} onChange={e => setLeaveCustom(c => ({ ...c, from: e.target.value }))} className="h-9 px-2 bg-gray-50 border border-gray-200 rounded-lg text-sm text-gray-700 outline-none focus:ring-2 focus:ring-indigo-500/20" />
                <span className="text-gray-400 text-sm">–</span>
                <input type="date" value={leaveCustom.to} min={leaveCustom.from} onChange={e => setLeaveCustom(c => ({ ...c, to: e.target.value }))} className="h-9 px-2 bg-gray-50 border border-gray-200 rounded-lg text-sm text-gray-700 outline-none focus:ring-2 focus:ring-indigo-500/20" />
              </>
            )}
          </div>
        </div>
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          {leaveCards.map(c => (
            <div key={c.label} className={`rounded-xl px-4 py-3 ${c.tone}`}>
              <p className="text-2xl font-extrabold tabular-nums leading-none">{c.value}</p>
              <p className="text-[13px] font-semibold mt-1.5 leading-tight">{c.label}</p>
              <p className="text-[11px] mt-0.5 opacity-70">{c.sub}</p>
            </div>
          ))}
          {leaveCards.length === 0 && Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="rounded-xl px-4 py-3 bg-gray-50 animate-pulse h-[74px]" />
          ))}
        </div>
      </div>

      {/* Activity Feed */}
      <div className="bg-white rounded-xl border border-gray-100 p-6 hover:shadow-md transition-shadow duration-300">
        <div className="flex items-start justify-between mb-6">
          <div>
            <h2 className="text-base font-bold text-gray-900">Recent Activity</h2>
            <p className="text-xs text-gray-400 mt-0.5">Important system events · updates every 30s</p>
          </div>
          <Link to="/activities" className="text-xs font-semibold text-indigo-600 hover:text-indigo-700 flex-shrink-0">
            View all →
          </Link>
        </div>
        <ActivityFeed items={activityItems} loading={activityLoading} />
      </div>
    </div>
  );
}
