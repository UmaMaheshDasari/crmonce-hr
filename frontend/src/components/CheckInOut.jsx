import { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { attendanceApi } from '../api/endpoints';
import {
  ArrowRightOnRectangleIcon,
  ArrowLeftOnRectangleIcon,
  CheckCircleIcon,
  ClockIcon,
} from '@heroicons/react/24/outline';
import toast from 'react-hot-toast';

function formatTime(date) {
  return date.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true });
}
function formatDate(date) {
  return date.toLocaleDateString('en-IN', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
}
function elapsedSince(timeStr) {
  if (!timeStr) return '0h 0m';
  const [h, m] = timeStr.split(':').map(Number);
  const now = new Date();
  const diff = (now.getHours() * 60 + now.getMinutes()) - (h * 60 + m);
  if (diff < 0) return '0h 0m';
  return `${Math.floor(diff / 60)}h ${diff % 60}m`;
}

export default function CheckInOut({ compact = false }) {
  const queryClient = useQueryClient();
  const [now, setNow] = useState(new Date());

  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);
  const [, setTick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setTick(t => t + 1), 60000);
    return () => clearInterval(timer);
  }, []);

  const hasToken = !!localStorage.getItem('accessToken');
  const { data: statusData, isLoading } = useQuery({
    queryKey: ['attendance-my-status'],
    queryFn: () => attendanceApi.myStatus(),
    refetchOnWindowFocus: true,
    enabled: hasToken,
    retry: false,
  });

  const s = statusData?.data ?? {};
  // 'none' | 'in' | 'out' — with a fallback for the old checkedIn/checkedOut API shape
  const state = s.state ?? (s.checkedIn ? 'in' : (s.checkedOut ? 'out' : 'none'));
  const canCheckOut = s.canCheckOut ?? (state === 'in');
  const punchCount = s.punchCount ?? (s.record?.hr_punchcount ?? 0);
  const punches = s.punches ?? [];
  const lastPunch = punches.length
    ? punches[punches.length - 1]
    : (state === 'in' ? s.record?.hr_intime : s.record?.hr_outtime);
  const worked = s.workedHours ?? s.record?.hr_workedhours ?? 0;
  const effective = s.effectiveHours ?? s.record?.hr_effectivehours ?? worked;
  const breakDur = s.breakDuration ?? s.record?.hr_breakduration ?? 0;

  const checkinMutation = useMutation({
    mutationFn: () => attendanceApi.checkin(),
    onSuccess: () => { toast.success('Checked in!'); queryClient.invalidateQueries({ queryKey: ['attendance-my-status'] }); },
    onError: (err) => toast.error(err.response?.data?.error || 'Check-in failed'),
  });
  const checkoutMutation = useMutation({
    mutationFn: () => attendanceApi.checkout(),
    onSuccess: () => { toast.success('Checked out!'); queryClient.invalidateQueries({ queryKey: ['attendance-my-status'] }); },
    onError: (err) => toast.error(err.response?.data?.error || 'Check-out failed'),
  });
  const isActioning = checkinMutation.isPending || checkoutMutation.isPending;

  if (isLoading) {
    return (
      <div className="bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden">
        <div className="h-1.5 bg-gradient-to-r from-indigo-500 to-purple-500" />
        <div className="p-6 animate-pulse space-y-4">
          <div className="h-4 w-32 bg-gray-100 rounded-full" />
          <div className="h-10 w-40 bg-gray-100 rounded-lg" />
          <div className="h-12 w-full bg-gray-100 rounded-xl" />
        </div>
      </div>
    );
  }

  return (
    <div className="bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden">
      <div className="h-1.5 bg-gradient-to-r from-indigo-500 to-purple-500" />
      <div className={compact ? 'p-4' : 'p-6'}>
        <div className="flex items-center gap-2 mb-4">
          <ClockIcon className="w-5 h-5 text-indigo-500" />
          <h3 className="text-sm font-bold text-gray-900 uppercase tracking-wider">Attendance</h3>
          {punchCount > 0 && (
            <span className="ml-auto text-xs font-medium bg-gray-100 text-gray-600 px-2 py-0.5 rounded-full">
              {punchCount} punch{punchCount > 1 ? 'es' : ''}
            </span>
          )}
        </div>

        {/* Live clock */}
        <div className="text-center mb-5">
          <p className="text-4xl font-bold text-gray-900 tabular-nums tracking-tight">{formatTime(now)}</p>
          <p className="text-sm text-gray-500 mt-1">{formatDate(now)}</p>
        </div>

        {/* Current session state */}
        <div className="mb-4">
          {state === 'in' ? (
            <div className="flex items-center gap-3">
              <span className="relative flex h-3 w-3">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75" />
                <span className="relative inline-flex rounded-full h-3 w-3 bg-green-500" />
              </span>
              <span className="text-sm text-gray-700">Checked in — working</span>
              {lastPunch && <span className="ml-auto text-xs font-medium bg-green-50 text-green-700 px-2 py-0.5 rounded-full">{lastPunch}</span>}
            </div>
          ) : state === 'out' ? (
            <div className="flex items-center gap-3">
              <span className="w-3 h-3 rounded-full bg-blue-500" />
              <span className="text-sm text-gray-700">Checked out — you can check in again</span>
              {lastPunch && <span className="ml-auto text-xs font-medium bg-blue-50 text-blue-700 px-2 py-0.5 rounded-full">{lastPunch}</span>}
            </div>
          ) : (
            <div className="flex items-center gap-3">
              <span className="w-3 h-3 rounded-full bg-gray-300" />
              <span className="text-sm text-gray-500">Not checked in yet</span>
            </div>
          )}
        </div>

        {/* Session totals */}
        {punchCount > 0 && (
          <div className="grid grid-cols-3 gap-2 mb-4">
            <div className="bg-gray-50 rounded-xl p-2.5 text-center">
              <p className="text-[10px] uppercase tracking-wider text-gray-400 font-semibold">Worked</p>
              <p className="text-sm font-bold text-gray-800 tabular-nums">{worked}h</p>
            </div>
            <div className="bg-amber-50/60 rounded-xl p-2.5 text-center">
              <p className="text-[10px] uppercase tracking-wider text-amber-500/80 font-semibold">Break</p>
              <p className="text-sm font-bold text-amber-700 tabular-nums">{breakDur}h</p>
            </div>
            <div className="bg-emerald-50/60 rounded-xl p-2.5 text-center">
              <p className="text-[10px] uppercase tracking-wider text-emerald-500/80 font-semibold">Effective</p>
              <p className="text-sm font-bold text-emerald-700 tabular-nums">{effective}h</p>
            </div>
          </div>
        )}

        {/* Elapsed since last check-in */}
        {state === 'in' && (
          <div className="bg-indigo-50/60 rounded-xl p-3 mb-4 text-center border border-indigo-100/50">
            <p className="text-xs font-semibold uppercase tracking-wider text-indigo-600/70 mb-0.5">Since last check-in</p>
            <p className="text-xl font-bold text-indigo-700 tabular-nums">{elapsedSince(lastPunch)}</p>
          </div>
        )}

        {/* Action button — ALWAYS the correct next action; never permanently disabled */}
        {canCheckOut ? (
          <button
            onClick={() => checkoutMutation.mutate()}
            disabled={isActioning}
            className="w-full flex items-center justify-center gap-2 py-3 rounded-xl text-white font-semibold text-sm bg-gradient-to-r from-rose-500 to-red-600 hover:from-rose-600 hover:to-red-700 shadow-sm hover:shadow-md transition-all duration-200 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <ArrowLeftOnRectangleIcon className="w-5 h-5" />
            {checkoutMutation.isPending ? 'Checking out...' : 'Check Out'}
          </button>
        ) : (
          <button
            onClick={() => checkinMutation.mutate()}
            disabled={isActioning}
            className="w-full flex items-center justify-center gap-2 py-3 rounded-xl text-white font-semibold text-sm bg-gradient-to-r from-green-500 to-emerald-600 hover:from-green-600 hover:to-emerald-700 shadow-sm hover:shadow-md transition-all duration-200 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <ArrowRightOnRectangleIcon className="w-5 h-5" />
            {checkinMutation.isPending ? 'Checking in...' : (punchCount > 0 ? 'Check In Again' : 'Check In')}
          </button>
        )}

        {punchCount > 0 && (
          <p className="text-center text-[11px] text-gray-400 mt-3 flex items-center justify-center gap-1">
            <CheckCircleIcon className="w-3.5 h-3.5 text-gray-300" />
            Session stays open — punch in/out as many times as you need
          </p>
        )}
      </div>
    </div>
  );
}
