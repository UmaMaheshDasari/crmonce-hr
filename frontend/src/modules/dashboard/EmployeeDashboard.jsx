import { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { format, startOfMonth, endOfMonth, subMonths, startOfYear, endOfYear, subYears } from 'date-fns';
import toast from 'react-hot-toast';
import {
  CheckCircleIcon, XCircleIcon, ClockIcon, CalendarDaysIcon, BriefcaseIcon,
  CurrencyDollarIcon, SunIcon, ArrowRightOnRectangleIcon,
  ArrowLeftOnRectangleIcon, DocumentCheckIcon, BellAlertIcon, ExclamationTriangleIcon,
} from '@heroicons/react/24/outline';
import { dashboardApi, attendanceApi, employeeApi, documentApi, leaveApi } from '../../api/endpoints';
import { useAuth } from '../../context/AuthContext';
import Button from '../../components/Button';
import MissingPunchModal from '../attendance/MissingPunchModal';
import ActivityFeed from '../../components/ActivityFeed';
import { formatDuration, formatMinutes } from '../../utils/formatDuration';

function greeting() {
  const h = new Date().getHours();
  return h < 12 ? 'Good Morning' : h < 17 ? 'Good Afternoon' : 'Good Evening';
}
const fmtDay = (iso) => { try { return format(new Date(`${iso}T00:00:00`), 'dd MMM'); } catch { return '—'; } };

// today's status → { label, tone } for the hero pill.
// An "incomplete" day (a punch exists, one is just missing) counts as Present —
// the employee showed up; the missing punch is surfaced separately as a warning.
function todayStatus(t) {
  if (!t) return { label: 'Loading…', tone: 'bg-white/15 text-white' };
  if (t.state === 'in') return { label: 'Checked In', tone: 'bg-emerald-400/25 text-emerald-50 ring-1 ring-emerald-300/40' };
  switch (t.status) {
    case 'present':
    case 'incomplete': return { label: 'Present', tone: 'bg-emerald-400/25 text-emerald-50 ring-1 ring-emerald-300/40' };
    case 'half_day': return { label: 'Half Day', tone: 'bg-amber-400/25 text-amber-50 ring-1 ring-amber-300/40' };
    default: return { label: 'Not Checked In', tone: 'bg-white/15 text-white ring-1 ring-white/25' };
  }
}
const STATUS_PILL = {
  present: 'bg-emerald-50 text-emerald-700', half_day: 'bg-amber-50 text-amber-700',
  incomplete: 'bg-slate-100 text-slate-600', absent: 'bg-red-50 text-red-700',
};

// ── compact KPI card (~35% shorter than the old p-5/text-3xl card) ──────────────
function Kpi({ label, value, sub, iconBg, iconColor }) {
  return (
    <div className="bg-white rounded-xl border border-gray-100 p-3.5 flex items-center gap-3 hover:shadow-sm transition-shadow">
      <div className={`w-9 h-9 rounded-lg grid place-items-center flex-shrink-0 ${iconBg}`}>
        <Icon className={`w-5 h-5 ${iconColor}`} />
      </div>
      <div className="min-w-0">
        <p className="text-xl font-bold text-gray-900 tabular-nums leading-none">{value}</p>
        <p className="text-[11px] font-semibold text-gray-500 mt-1 leading-tight truncate">{label}</p>
        {sub != null && <p className="text-[10px] text-gray-400 leading-tight truncate">{sub}</p>}
      </div>
    </div>
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

function useClock() {
  const [now, setNow] = useState(new Date());
  useEffect(() => { const t = setInterval(() => setNow(new Date()), 1000); return () => clearInterval(t); }, []);
  return now;
}

export default function EmployeeDashboard() {
  const { user } = useAuth();
  const qc = useQueryClient();
  const now = useClock();

  // Leave Summary filter — defaults to This Year (a year-to-date figure).
  const [leaveRange, setLeaveRange] = useState('this_year');
  const [leaveCustom, setLeaveCustom] = useState({ from: '', to: '' });
  const period = (() => {
    const d = new Date(), f = (x) => format(x, 'yyyy-MM-dd');
    switch (leaveRange) {
      case 'this_month': return { from: f(startOfMonth(d)), to: f(endOfMonth(d)) };
      case 'last_month': { const lm = subMonths(d, 1); return { from: f(startOfMonth(lm)), to: f(endOfMonth(lm)) }; }
      case 'last_year': { const ly = subYears(d, 1); return { from: f(startOfYear(ly)), to: f(endOfYear(ly)) }; }
      case 'custom': return { from: leaveCustom.from || undefined, to: leaveCustom.to || undefined };
      default: return { from: f(startOfYear(d)), to: f(endOfYear(d)) };   // this_year
    }
  })();

  const { data, isLoading } = useQuery({
    queryKey: ['dashboard-summary', user?.id, period.from, period.to],
    queryFn: () => dashboardApi.summary({ from: period.from, to: period.to }),
    enabled: !!user?.id && (leaveRange !== 'custom' || (!!leaveCustom.from && !!leaveCustom.to)),
    placeholderData: (prev) => prev,
  });
  const d = data?.data;
  const t = d?.today, m = d?.month, lv = d?.leave;
  const alerts = d?.alerts || [];

  // ESS profile snapshot (completion %, verification, missing docs).
  const { data: profileRes } = useQuery({ queryKey: ['employee', user?.id], queryFn: () => employeeApi.get(user.id), enabled: !!user?.id });
  const prof = profileRes?.data;
  const completion = prof?._completion || { percent: 0, missing: [] };
  const vstatus = prof?._verifystatus || prof?.hr_verifystatus || 'verified';
  const { data: myDocsRes } = useQuery({ queryKey: ['documents', user?.id], queryFn: () => documentApi.list({ employeeId: user.id }), enabled: !!user?.id });
  // Allocation-based leave balance (auto-calculated from approved leave) — req 8.
  const { data: leaveBalRes } = useQuery({ queryKey: ['leave-balance', 'self', new Date().getFullYear()], queryFn: () => leaveApi.balance({}) });
  const lb = leaveBalRes?.data;
  const REQUIRED_DOCS = ['Aadhaar Card', 'PAN Card', 'Cancelled Cheque', 'Photo'];
  const uploadedNames = new Set((myDocsRes?.data?.data || []).map(x => x.hr_name));
  const missingDocs = REQUIRED_DOCS.filter(n => !uploadedNames.has(n));
  const V_TONE = { verified: 'bg-emerald-50 text-emerald-700', pending: 'bg-amber-50 text-amber-700', changes: 'bg-orange-50 text-orange-700', rejected: 'bg-red-50 text-red-700' };
  const V_TEXT = { verified: 'Verified', pending: 'Pending HR Verification', changes: 'Changes Requested', rejected: 'Rejected' };
  const [correctionModal, setCorrectionModal] = useState({ open: false, date: '', type: '' });

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['dashboard-summary'] });
    qc.invalidateQueries({ queryKey: ['attendance-my-status'] });
  };
  const checkin = useMutation({
    mutationFn: () => attendanceApi.checkin(),
    onSuccess: () => { toast.success('Checked in!'); invalidate(); },
    onError: (e) => toast.error(e.response?.data?.error || 'Check-in failed'),
  });
  const checkout = useMutation({
    mutationFn: () => attendanceApi.checkout(),
    onSuccess: () => { toast.success('Checked out!'); invalidate(); },
    onError: (e) => toast.error(e.response?.data?.error || 'Check-out failed'),
  });
  const busy = checkin.isPending || checkout.isPending;

  // Incomplete days count as Present (the employee attended — a punch is just
  // missing). Half days count as 0.5. Missing punches are flagged, not penalised.
  const daysPresent = m ? (m.presentDays + m.incompleteDays + m.halfDays * 0.5) : 0;
  const st = todayStatus(t);

  const kpis = m && lv ? [
    { icon: CheckCircleIcon, label: 'Days Present', value: Number.isInteger(daysPresent) ? daysPresent : daysPresent.toFixed(1), sub: `of ${m.workingElapsed} working`, iconBg: 'bg-emerald-50', iconColor: 'text-emerald-600' },
    { icon: XCircleIcon, label: 'Absent Days', value: m.absentDays, sub: 'this month', iconBg: 'bg-red-50', iconColor: 'text-red-600' },
    { icon: ClockIcon, label: 'Late Days', value: m.lateDays, sub: 'this month', iconBg: 'bg-amber-50', iconColor: 'text-amber-600' },
    { icon: BriefcaseIcon, label: 'Worked Hours', value: formatDuration(m.workedHours), sub: 'this month', iconBg: 'bg-indigo-50', iconColor: 'text-indigo-600' },
    { icon: CalendarDaysIcon, label: 'Pending Leave', value: lv.pendingCount, sub: `${lv.pendingDays} day${lv.pendingDays === 1 ? '' : 's'}`, iconBg: 'bg-orange-50', iconColor: 'text-orange-600' },
    { icon: DocumentCheckIcon, label: 'Approved Leave', value: lv.approvedCount, sub: `${lv.approvedDays} day${lv.approvedDays === 1 ? '' : 's'}`, iconBg: 'bg-emerald-50', iconColor: 'text-emerald-600' },
    { icon: CurrencyDollarIcon, label: 'Next Payday', value: fmtDay(d.nextPayday), sub: 'salary date', iconBg: 'bg-violet-50', iconColor: 'text-violet-600' },
    { icon: SunIcon, label: 'Upcoming Holiday', value: d.upcomingHoliday ? fmtDay(d.upcomingHoliday.date) : '—', sub: d.upcomingHoliday ? (d.upcomingHoliday.name || 'holiday') : 'none scheduled', iconBg: 'bg-sky-50', iconColor: 'text-sky-600' },
  ] : [];

  const leaveCards = lv ? [
    { label: 'Pending Approval', value: lv.pendingCount, sub: `${lv.pendingDays} day${lv.pendingDays === 1 ? '' : 's'}`, tone: 'text-amber-700 bg-amber-50' },
    { label: 'Approved Leaves', value: lv.approvedCount, sub: `${lv.approvedDays} day${lv.approvedDays === 1 ? '' : 's'}`, tone: 'text-emerald-700 bg-emerald-50' },
    { label: 'Rejected Leaves', value: lv.rejectedCount, sub: 'requests', tone: 'text-red-700 bg-red-50' },
    { label: 'Total Leave Taken', value: lv.taken, sub: lv.hasActivity ? 'approved days' : 'No leave activity for selected period', tone: 'text-indigo-700 bg-indigo-50' },
  ] : [];

  return (
    <div className="space-y-5">
      {/* ── Hero banner (compact) ─────────────────────────────────────────── */}
      <div className="rounded-2xl bg-gradient-to-br from-indigo-600 via-indigo-700 to-violet-700 px-5 py-4">
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <div className="min-w-0">
            <h1 className="text-xl sm:text-2xl font-bold text-white leading-tight">
              {greeting()}, {d?.employee?.name?.split(' ')[0] || user?.name?.split(' ')[0] || 'there'}
            </h1>
            <p className="text-indigo-200 text-xs mt-1">
              {now.toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}
              {d?.employee?.designation ? ` · ${d.employee.designation}` : ''}
            </p>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            {d?.shift && (
              <span className="text-xs font-medium bg-white/15 text-white ring-1 ring-white/25 px-3 py-1.5 rounded-lg">
                Shift {d.shift.start}–{d.shift.end}
              </span>
            )}
            <span className={`text-xs font-semibold px-3 py-1.5 rounded-lg ${st.tone}`}>{st.label}</span>
          </div>
        </div>
      </div>

      {/* ── Profile completion / verification / documents ─────────────────── */}
      {(completion.percent < 100 || vstatus !== 'verified' || missingDocs.length > 0) && (
        <div className="bg-white rounded-2xl border border-gray-100 p-4 sm:p-5 flex flex-wrap items-center gap-4">
          <div className="flex items-center gap-3 flex-1 min-w-[200px]">
            <div className="relative w-12 h-12 flex-shrink-0">
              <svg viewBox="0 0 36 36" className="w-12 h-12 -rotate-90">
                <circle cx="18" cy="18" r="15.5" fill="none" stroke="#e5e7eb" strokeWidth="4" />
                <circle cx="18" cy="18" r="15.5" fill="none" stroke="#6366f1" strokeWidth="4" strokeLinecap="round"
                  strokeDasharray={2 * Math.PI * 15.5} strokeDashoffset={(1 - completion.percent / 100) * 2 * Math.PI * 15.5} />
              </svg>
              <span className="absolute inset-0 flex items-center justify-center text-xs font-bold text-gray-800">{completion.percent}%</span>
            </div>
            <div className="min-w-0">
              <p className="text-sm font-semibold text-gray-900">Profile Completion</p>
              <p className="text-xs text-gray-400 truncate">{completion.missing?.length ? `Missing: ${completion.missing.join(', ')}` : 'Your profile is complete'}</p>
            </div>
          </div>
          <span className={`text-xs font-semibold px-3 py-1.5 rounded-lg ${V_TONE[vstatus] || V_TONE.verified}`}>{V_TEXT[vstatus] || 'Verified'}</span>
          {missingDocs.length > 0 && (
            <span className="text-xs font-medium text-gray-500 bg-gray-50 border border-gray-100 px-3 py-1.5 rounded-lg">Missing docs: {missingDocs.join(', ')}</span>
          )}
          <Link to="/profile" className="ml-auto inline-flex items-center gap-1.5 px-4 py-2 text-sm font-semibold text-white bg-indigo-600 rounded-xl hover:bg-indigo-700 transition-colors">Complete Profile</Link>
        </div>
      )}

      {/* ── Top KPI cards ─────────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
        {isLoading && !d
          ? Array.from({ length: 8 }).map((_, i) => <div key={i} className="bg-gray-50 rounded-xl h-[62px] animate-pulse" />)
          : kpis.map(k => <Kpi key={k.label} {...k} />)}
      </div>

      {/* ── Attendance Alerts (auto-detected exceptions) ──────────────────── */}
      <div className="bg-white rounded-xl border border-gray-100 p-5">
        <div className="flex items-center gap-2 mb-3">
          <BellAlertIcon className="w-5 h-5 text-amber-500" />
          <h2 className="text-base font-bold text-gray-900">Attendance Alerts</h2>
          {alerts.length > 0 && <span className="text-[11px] font-semibold px-2 py-0.5 rounded-full bg-amber-50 text-amber-700">{alerts.length}</span>}
        </div>
        {alerts.length === 0 ? (
          <div className="flex items-center gap-2 text-sm text-gray-400 py-2">
            <CheckCircleIcon className="w-5 h-5 text-emerald-500" /> No attendance issues detected.
          </div>
        ) : (
          <div className="space-y-2">
            {alerts.map(a => (
              <div key={a.date + a.code} className="flex items-center gap-3 rounded-xl border border-amber-100 bg-amber-50/50 px-4 py-3 flex-wrap">
                <div className={`w-9 h-9 rounded-lg grid place-items-center flex-shrink-0 ${a.priority === 'high' ? 'bg-red-100' : 'bg-amber-100'}`}>
                  <ExclamationTriangleIcon className={`w-5 h-5 ${a.priority === 'high' ? 'text-red-600' : 'text-amber-600'}`} />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-semibold text-gray-800">{a.label}</p>
                  <p className="text-xs text-gray-500">{fmtDay(a.date)}{a.punches?.length ? ` · Recorded: ${a.punches.join(', ')}` : ''}</p>
                </div>
                <span className="text-[11px] font-semibold px-2 py-0.5 rounded-full bg-red-50 text-red-700">Action Required</span>
                <Button variant="secondary" onClick={() => setCorrectionModal({ open: true, date: a.date, type: a.code })}>Raise Request</Button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ── Attendance widget + Leave Summary ─────────────────────────────── */}
      <div className="grid grid-cols-1 xl:grid-cols-3 gap-5">
        {/* Attendance widget */}
        <div className="xl:col-span-2 bg-white rounded-xl border border-gray-100 p-5">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2">
              <ClockIcon className="w-5 h-5 text-indigo-500" />
              <h2 className="text-base font-bold text-gray-900">Today's Attendance</h2>
              {t && <span className={`text-[11px] font-semibold px-2 py-0.5 rounded-full ${t.status === 'incomplete' ? STATUS_PILL.present : (STATUS_PILL[t.status] || 'bg-gray-100 text-gray-500')}`}>
                {t.state === 'in' ? 'Working'
                  : t.status === 'incomplete' ? 'Present · missing punch'
                  : t.status === 'absent' ? 'No punch yet'
                  : t.status.replace('_', ' ')}
              </span>}
            </div>
            <p className="text-lg font-bold text-gray-900 tabular-nums">
              {now.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true })}
            </p>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2">
            <Stat label="First Punch" value={t?.firstPunch || '—'} />
            <Stat label="Last Punch" value={t?.lastPunch || '—'} />
            <Stat label="Shift" value={d?.shift ? `${d.shift.start}–${d.shift.end}` : '—'} />
            <Stat label="Punches" value={t?.punchCount ?? 0} />
            <Stat label="Worked" value={formatDuration(t?.workedHours)} />
            <Stat label="Break" value={formatDuration(t?.breakHours)} tone="text-amber-700" />
            <Stat label="Effective" value={formatDuration(t?.effectiveHours)} tone="text-emerald-700" />
            <Stat label="Overtime" value={formatDuration(t?.overtimeHours)} tone="text-violet-700" />
            <Stat label="Late By" value={formatMinutes(t?.lateByMin)} tone={t?.lateByMin > 0 ? 'text-amber-700' : 'text-gray-800'} />
            <Stat label="Early Exit" value={formatMinutes(t?.earlyExitMin)} tone={t?.earlyExitMin > 0 ? 'text-orange-700' : 'text-gray-800'} />
          </div>

          <div className="mt-4">
            {t?.canCheckOut ? (
              <button onClick={() => checkout.mutate()} disabled={busy}
                className="w-full flex items-center justify-center gap-2 py-2.5 rounded-xl text-white font-semibold text-sm bg-gradient-to-r from-rose-500 to-red-600 hover:from-rose-600 hover:to-red-700 disabled:opacity-50 transition-all">
                <ArrowLeftOnRectangleIcon className="w-5 h-5" />
                {checkout.isPending ? 'Checking out…' : 'Check Out'}
              </button>
            ) : (
              <button onClick={() => checkin.mutate()} disabled={busy}
                className="w-full flex items-center justify-center gap-2 py-2.5 rounded-xl text-white font-semibold text-sm bg-gradient-to-r from-emerald-500 to-green-600 hover:from-emerald-600 hover:to-green-700 disabled:opacity-50 transition-all">
                <ArrowRightOnRectangleIcon className="w-5 h-5" />
                {checkin.isPending ? 'Checking in…' : (t?.punchCount > 0 ? 'Check In Again' : 'Check In')}
              </button>
            )}
          </div>
        </div>

        {/* Leave Summary */}
        <div className="bg-white rounded-xl border border-gray-100 p-5">
          <div className="flex items-center justify-between gap-2 mb-4 flex-wrap">
            <h2 className="text-base font-bold text-gray-900">Leave Summary</h2>
            <select value={leaveRange} onChange={e => setLeaveRange(e.target.value)}
              className="h-8 px-2 bg-gray-50 border border-gray-200 rounded-lg text-xs text-gray-700 outline-none focus:ring-2 focus:ring-indigo-500/20 cursor-pointer">
              <option value="this_month">This Month</option>
              <option value="last_month">Last Month</option>
              <option value="this_year">This Year</option>
              <option value="last_year">Last Year</option>
              <option value="custom">Custom Range</option>
            </select>
          </div>
          {leaveRange === 'custom' && (
            <div className="flex items-center gap-2 mb-3">
              <input type="date" value={leaveCustom.from} onChange={e => setLeaveCustom(c => ({ ...c, from: e.target.value }))}
                className="h-8 px-2 bg-gray-50 border border-gray-200 rounded-lg text-xs text-gray-700 outline-none w-full" />
              <span className="text-gray-400 text-xs">–</span>
              <input type="date" value={leaveCustom.to} min={leaveCustom.from} onChange={e => setLeaveCustom(c => ({ ...c, to: e.target.value }))}
                className="h-8 px-2 bg-gray-50 border border-gray-200 rounded-lg text-xs text-gray-700 outline-none w-full" />
            </div>
          )}
          <div className="grid grid-cols-2 gap-2.5">
            {leaveCards.length
              ? leaveCards.map(c => (
                <div key={c.label} className={`rounded-xl px-3 py-2.5 ${c.tone}`}>
                  <p className="text-xl font-extrabold tabular-nums leading-none">{c.value}</p>
                  <p className="text-[12px] font-semibold mt-1 leading-tight">{c.label}</p>
                  <p className="text-[10px] mt-0.5 opacity-70 leading-tight">{c.sub}</p>
                </div>
              ))
              : Array.from({ length: 4 }).map((_, i) => <div key={i} className="rounded-xl bg-gray-50 h-[74px] animate-pulse" />)}
          </div>
        </div>
      </div>

      {/* ── Leave Balance (allocation-based, auto-calculated) ─────────────── */}
      {lb && (
        <div className="bg-white rounded-xl border border-gray-100 p-5">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-base font-bold text-gray-900">Leave Balance · {lb.year}</h2>
            <Link to="/leave" className="text-xs font-semibold text-indigo-600 hover:text-indigo-700">Details →</Link>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
            {[
              { label: 'Casual (CL)', value: `${Number(lb.casual?.remaining || 0)}/${Number(lb.casual?.entitled || 0)}`, tone: 'bg-sky-50 text-sky-700' },
              { label: 'Sick (SL)', value: `${Number(lb.sick?.remaining || 0)}/${Number(lb.sick?.entitled || 0)}`, tone: 'bg-rose-50 text-rose-700' },
              { label: 'Comp Off', value: `${Number(lb.compOff?.balance || 0)}`, tone: 'bg-emerald-50 text-emerald-700' },
              { label: 'LOP', value: `${Number(lb.lop?.fromLeave || 0)}`, tone: 'bg-amber-50 text-amber-700' },
            ].map(c => (
              <div key={c.label} className={`rounded-xl px-3 py-2.5 ${c.tone}`}>
                <p className="text-xl font-extrabold tabular-nums leading-none">{c.value}</p>
                <p className="text-[12px] font-semibold mt-1 leading-tight">{c.label}</p>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── Recent Activity ───────────────────────────────────────────────── */}
      <div className="bg-white rounded-xl border border-gray-100 p-5">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-base font-bold text-gray-900">Recent Activity</h2>
          <Link to="/activities" className="text-xs font-semibold text-indigo-600 hover:text-indigo-700">View all →</Link>
        </div>
        <ActivityFeed items={d?.activity ?? []} loading={isLoading && !d} emptyText="No recent activity yet." />
      </div>

      {/* One-click: opens the correction form pre-filled from the detected exception. */}
      <MissingPunchModal
        open={correctionModal.open}
        defaultDate={correctionModal.date}
        defaultType={correctionModal.type}
        onClose={() => setCorrectionModal({ open: false, date: '', type: '' })}
      />
    </div>
  );
}
