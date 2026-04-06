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
  if (!timeStr) return null;
  const [h, m] = timeStr.split(':').map(Number);
  const now = new Date();
  const diffMin = (now.getHours() * 60 + now.getMinutes()) - (h * 60 + m);
  if (diffMin < 0) return '0h 0m';
  const hours = Math.floor(diffMin / 60);
  const mins = diffMin % 60;
  return `${hours}h ${mins}m`;
}

export default function CheckInOut({ compact = false }) {
  const queryClient = useQueryClient();
  const [now, setNow] = useState(new Date());

  // Live clock — update every second
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);

  // Elapsed time — update every minute
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

  const status = statusData?.data;
  const checkedIn = status?.checkedIn ?? false;
  const checkedOut = status?.checkedOut ?? false;
  const record = status?.record ?? null;

  const checkinMutation = useMutation({
    mutationFn: () => attendanceApi.checkin(),
    onSuccess: () => {
      toast.success('Checked in successfully!');
      queryClient.invalidateQueries({ queryKey: ['attendance-my-status'] });
    },
    onError: (err) => {
      toast.error(err.response?.data?.error || 'Check-in failed');
    },
  });

  const checkoutMutation = useMutation({
    mutationFn: () => attendanceApi.checkout(),
    onSuccess: () => {
      toast.success('Checked out successfully!');
      queryClient.invalidateQueries({ queryKey: ['attendance-my-status'] });
    },
    onError: (err) => {
      toast.error(err.response?.data?.error || 'Check-out failed');
    },
  });

  const isActioning = checkinMutation.isPending || checkoutMutation.isPending;

  if (isLoading) {
    return (
      <div className={`bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden ${compact ? '' : ''}`}>
        <div className="h-1.5 bg-gradient-to-r from-indigo-500 to-purple-500" />
        <div className="p-6 animate-pulse space-y-4">
          <div className="h-4 w-32 bg-gray-100 rounded-full" />
          <div className="h-10 w-40 bg-gray-100 rounded-lg" />
          <div className="h-4 w-48 bg-gray-100 rounded-full" />
          <div className="h-12 w-full bg-gray-100 rounded-xl" />
        </div>
      </div>
    );
  }

  return (
    <div className="bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden">
      {/* Gradient header bar */}
      <div className="h-1.5 bg-gradient-to-r from-indigo-500 to-purple-500" />

      <div className={compact ? 'p-4' : 'p-6'}>
        {/* Header */}
        <div className="flex items-center gap-2 mb-4">
          <ClockIcon className="w-5 h-5 text-indigo-500" />
          <h3 className="text-sm font-bold text-gray-900 uppercase tracking-wider">Attendance</h3>
        </div>

        {/* Current time */}
        <div className="text-center mb-5">
          <p className="text-4xl font-bold text-gray-900 tabular-nums tracking-tight">
            {formatTime(now)}
          </p>
          <p className="text-sm text-gray-500 mt-1">{formatDate(now)}</p>
        </div>

        {/* Status indicator */}
        <div className="mb-5 space-y-3">
          {/* Check-in status */}
          <div className="flex items-center gap-3">
            {!checkedIn ? (
              <>
                <span className="relative flex h-3 w-3">
                  <span className="w-3 h-3 rounded-full bg-gray-300" />
                </span>
                <span className="text-sm text-gray-500">Not checked in</span>
              </>
            ) : (
              <>
                <span className="relative flex h-3 w-3">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75" />
                  <span className="relative inline-flex rounded-full h-3 w-3 bg-green-500" />
                </span>
                <span className="text-sm text-gray-700">Checked in</span>
                <span className="ml-auto text-xs font-medium bg-green-50 text-green-700 px-2 py-0.5 rounded-full">
                  {record?.hr_intime}
                </span>
              </>
            )}
          </div>

          {/* Check-out status */}
          {checkedIn && (
            <div className="flex items-center gap-3">
              {!checkedOut ? (
                <>
                  <span className="w-3 h-3 rounded-full bg-gray-300" />
                  <span className="text-sm text-gray-500">Not checked out</span>
                </>
              ) : (
                <>
                  <span className="w-3 h-3 rounded-full bg-blue-500" />
                  <span className="text-sm text-gray-700">Checked out</span>
                  <span className="ml-auto text-xs font-medium bg-blue-50 text-blue-700 px-2 py-0.5 rounded-full">
                    {record?.hr_outtime}
                  </span>
                </>
              )}
            </div>
          )}

          {/* Worked hours */}
          {checkedIn && checkedOut && record?.hr_workedhours != null && (
            <div className="flex items-center gap-3">
              <CheckCircleIcon className="w-3 h-3 text-emerald-500" />
              <span className="text-sm text-gray-700">Worked hours</span>
              <span className="ml-auto text-xs font-medium bg-emerald-50 text-emerald-700 px-2 py-0.5 rounded-full">
                {record.hr_workedhours}h
              </span>
            </div>
          )}
        </div>

        {/* Elapsed time (live) */}
        {checkedIn && !checkedOut && (
          <div className="bg-indigo-50/60 rounded-xl p-3 mb-4 text-center border border-indigo-100/50">
            <p className="text-xs font-semibold uppercase tracking-wider text-indigo-600/70 mb-0.5">Time Elapsed</p>
            <p className="text-xl font-bold text-indigo-700 tabular-nums">{elapsedSince(record?.hr_intime)}</p>
          </div>
        )}

        {/* Completed state */}
        {checkedIn && checkedOut && (
          <div className="bg-emerald-50/60 rounded-xl p-3 mb-4 text-center border border-emerald-100/50">
            <div className="flex items-center justify-center gap-2">
              <CheckCircleIcon className="w-5 h-5 text-emerald-600" />
              <p className="text-sm font-semibold text-emerald-700">Day completed</p>
            </div>
          </div>
        )}

        {/* Action buttons */}
        {!checkedIn && (
          <button
            onClick={() => checkinMutation.mutate()}
            disabled={isActioning}
            className="w-full flex items-center justify-center gap-2 py-3 rounded-xl text-white font-semibold text-sm bg-gradient-to-r from-green-500 to-emerald-600 hover:from-green-600 hover:to-emerald-700 shadow-sm hover:shadow-md transition-all duration-200 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <ArrowRightOnRectangleIcon className="w-5 h-5" />
            {checkinMutation.isPending ? 'Checking in...' : 'Check In'}
          </button>
        )}

        {checkedIn && !checkedOut && (
          <button
            onClick={() => checkoutMutation.mutate()}
            disabled={isActioning}
            className="w-full flex items-center justify-center gap-2 py-3 rounded-xl text-white font-semibold text-sm bg-gradient-to-r from-rose-500 to-red-600 hover:from-rose-600 hover:to-red-700 shadow-sm hover:shadow-md transition-all duration-200 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <ArrowLeftOnRectangleIcon className="w-5 h-5" />
            {checkoutMutation.isPending ? 'Checking out...' : 'Check Out'}
          </button>
        )}
      </div>
    </div>
  );
}
