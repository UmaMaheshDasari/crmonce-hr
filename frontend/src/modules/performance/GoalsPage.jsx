import { useState, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { goalsApi, employeeApi } from '../../api/endpoints';
import {
  PlusIcon, XMarkIcon, StarIcon, FlagIcon,
  CalendarDaysIcon, TrashIcon, PencilSquareIcon,
  ArrowTrendingUpIcon, ClipboardDocumentCheckIcon,
} from '@heroicons/react/24/outline';
import { StarIcon as StarSolid } from '@heroicons/react/24/solid';
import { useAuth } from '../../context/AuthContext';
import toast from 'react-hot-toast';

// ── Constants ───────────────────────────────────────────────────
const QUARTERS = ['Q1', 'Q2', 'Q3', 'Q4'];
const YEARS = ['2024-25', '2025-26', '2026-27', '2027-28'];
const STATUSES = ['not_started', 'in_progress', 'completed', 'exceeded', 'missed'];
const PRIORITIES = ['low', 'medium', 'high', 'critical'];

const STATUS_CONFIG = {
  not_started: { label: 'Not Started', dot: 'bg-gray-400', bg: 'bg-gray-50', text: 'text-gray-700', ring: 'ring-gray-200' },
  in_progress: { label: 'In Progress', dot: 'bg-amber-400', bg: 'bg-amber-50', text: 'text-amber-700', ring: 'ring-amber-200' },
  completed:   { label: 'Completed',   dot: 'bg-emerald-400', bg: 'bg-emerald-50', text: 'text-emerald-700', ring: 'ring-emerald-200' },
  exceeded:    { label: 'Exceeded',    dot: 'bg-blue-400', bg: 'bg-blue-50', text: 'text-blue-700', ring: 'ring-blue-200' },
  missed:      { label: 'Missed',      dot: 'bg-red-400', bg: 'bg-red-50', text: 'text-red-700', ring: 'ring-red-200' },
};

const PRIORITY_CONFIG = {
  low:      { label: 'Low',      color: 'text-gray-600',  bg: 'bg-gray-100',  border: 'border-l-gray-300' },
  medium:   { label: 'Medium',   color: 'text-blue-600',  bg: 'bg-blue-100',  border: 'border-l-blue-400' },
  high:     { label: 'High',     color: 'text-amber-600', bg: 'bg-amber-100', border: 'border-l-amber-400' },
  critical: { label: 'Critical', color: 'text-red-600',   bg: 'bg-red-100',   border: 'border-l-red-500' },
};

// ── Star Rating ─────────────────────────────────────────────────
function StarRating({ value, onChange, readOnly, size = 'md' }) {
  const sizeClasses = size === 'lg' ? 'w-7 h-7' : size === 'md' ? 'w-5 h-5' : 'w-4 h-4';
  return (
    <div className="flex gap-0.5">
      {[1, 2, 3, 4, 5].map(star => (
        <button key={star} type="button" onClick={() => !readOnly && onChange?.(star)}
          className={`${readOnly ? 'cursor-default' : 'cursor-pointer hover:scale-125'} transition-all duration-150`}>
          {star <= (value || 0)
            ? <StarSolid className={`${sizeClasses} text-amber-400 drop-shadow-sm`} />
            : <StarIcon className={`${sizeClasses} text-gray-200 ${readOnly ? '' : 'hover:text-amber-300'} transition-colors`} />}
        </button>
      ))}
    </div>
  );
}

// ── Progress Bar ────────────────────────────────────────────────
function ProgressBar({ value = 0, showLabel = true }) {
  const pct = Math.min(100, Math.max(0, value));
  const gradientColor = pct < 30 ? 'from-red-400 to-red-500'
    : pct < 70 ? 'from-amber-400 to-amber-500'
    : 'from-emerald-400 to-emerald-500';
  return (
    <div className="flex items-center gap-2">
      <div className="flex-1 h-2 bg-gray-100 rounded-full overflow-hidden">
        <div className={`h-full rounded-full bg-gradient-to-r ${gradientColor} transition-all duration-500`}
          style={{ width: `${pct}%` }} />
      </div>
      {showLabel && <span className="text-xs font-semibold text-gray-500 w-10 text-right">{pct}%</span>}
    </div>
  );
}

// ── Loading Skeleton ────────────────────────────────────────────
function GoalCardSkeleton() {
  return (
    <div className="bg-white rounded-xl border border-gray-100 p-5 animate-pulse">
      <div className="flex items-start justify-between mb-3">
        <div className="h-5 bg-gray-200 rounded w-2/3" />
        <div className="h-5 bg-gray-200 rounded w-16" />
      </div>
      <div className="h-3 bg-gray-100 rounded w-full mb-2" />
      <div className="h-3 bg-gray-100 rounded w-3/4 mb-4" />
      <div className="h-2 bg-gray-100 rounded-full w-full mb-3" />
      <div className="flex gap-2">
        <div className="h-6 bg-gray-100 rounded-full w-16" />
        <div className="h-6 bg-gray-100 rounded-full w-20" />
      </div>
    </div>
  );
}

// ── Circular Progress ───────────────────────────────────────────
function CircularProgress({ value = 0, size = 48, stroke = 4 }) {
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference - (value / 100) * circumference;
  return (
    <svg width={size} height={size} className="transform -rotate-90">
      <circle cx={size/2} cy={size/2} r={radius} fill="none" stroke="#e5e7eb" strokeWidth={stroke} />
      <circle cx={size/2} cy={size/2} r={radius} fill="none" stroke="url(#progressGrad)"
        strokeWidth={stroke} strokeDasharray={circumference} strokeDashoffset={offset}
        strokeLinecap="round" className="transition-all duration-700" />
      <defs>
        <linearGradient id="progressGrad" x1="0%" y1="0%" x2="100%" y2="0%">
          <stop offset="0%" stopColor="#818cf8" />
          <stop offset="100%" stopColor="#a78bfa" />
        </linearGradient>
      </defs>
    </svg>
  );
}

// ── Assign Goal Modal ───────────────────────────────────────────
function AssignGoalModal({ onClose }) {
  const qc = useQueryClient();
  const [form, setForm] = useState({
    employeeId: '', hr_hrgoal1: '', hr_description: '', hr_quarter: 'Q1',
    hr_financialyear: YEARS[1], hr_priority: 'medium', hr_weightage: 25,
    hr_duedate: '', hr_keyresults: '',
  });
  const [empSearch, setEmpSearch] = useState('');

  const { data: empData } = useQuery({
    queryKey: ['employees-all'],
    queryFn: () => employeeApi.list({ limit: 200, status: 'active' }),
  });

  const employees = empData?.data?.data || [];
  const filteredEmployees = empSearch
    ? employees.filter(e => e.hr_hremployee1?.toLowerCase().includes(empSearch.toLowerCase()))
    : employees;

  const mutation = useMutation({
    mutationFn: () => goalsApi.create(form),
    onSuccess: () => { toast.success('Goal assigned successfully!'); qc.invalidateQueries(['goals']); onClose(); },
    onError: () => toast.error('Failed to assign goal'),
  });

  const set = (k, v) => setForm(p => ({ ...p, [k]: v }));

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg overflow-hidden animate-in fade-in duration-200">
        <div className="flex items-center justify-between px-6 py-5 border-b border-gray-100">
          <div>
            <h2 className="text-lg font-semibold text-gray-900 tracking-tight">Assign New Goal</h2>
            <p className="text-sm text-gray-400 mt-0.5">Set a quarterly objective for an employee</p>
          </div>
          <button onClick={onClose} className="p-2 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded-xl transition-all">
            <XMarkIcon className="w-5 h-5" />
          </button>
        </div>

        <div className="px-6 py-5 space-y-5 max-h-[65vh] overflow-y-auto">
          {/* Employee selector */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">Employee</label>
            <input type="text" className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:ring-2 focus:ring-indigo-500 focus:border-transparent outline-none mb-1"
              placeholder="Search employees..." value={empSearch} onChange={e => setEmpSearch(e.target.value)} />
            {empSearch && (
              <div className="max-h-32 overflow-y-auto border border-gray-100 rounded-lg">
                {filteredEmployees.slice(0, 8).map(e => (
                  <button key={e.hr_hremployeeid} type="button"
                    className={`w-full text-left px-3 py-2 text-sm hover:bg-indigo-50 transition-colors ${form.employeeId === e.hr_hremployeeid ? 'bg-indigo-50 text-indigo-700' : ''}`}
                    onClick={() => { set('employeeId', e.hr_hremployeeid); setEmpSearch(e.hr_hremployee1); }}>
                    {e.hr_hremployee1}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Goal Title */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">Goal Title</label>
            <input type="text" className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:ring-2 focus:ring-indigo-500 focus:border-transparent outline-none"
              placeholder="e.g., Improve customer satisfaction score" value={form.hr_hrgoal1} onChange={e => set('hr_hrgoal1', e.target.value)} />
          </div>

          {/* Description */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">Description</label>
            <textarea rows={3} className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:ring-2 focus:ring-indigo-500 focus:border-transparent outline-none resize-none"
              placeholder="Describe the goal in detail..." value={form.hr_description} onChange={e => set('hr_description', e.target.value)} />
          </div>

          {/* Quarter selector cards */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">Quarter</label>
            <div className="grid grid-cols-4 gap-2">
              {QUARTERS.map(q => (
                <button key={q} type="button"
                  className={`px-3 py-2 rounded-lg text-sm font-medium border transition-all ${form.hr_quarter === q
                    ? 'bg-indigo-50 border-indigo-300 text-indigo-700 ring-2 ring-indigo-100'
                    : 'border-gray-200 text-gray-600 hover:border-gray-300 hover:bg-gray-50'}`}
                  onClick={() => set('hr_quarter', q)}>
                  {q}
                </button>
              ))}
            </div>
          </div>

          {/* Financial Year */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">Financial Year</label>
            <select className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:ring-2 focus:ring-indigo-500 focus:border-transparent outline-none"
              value={form.hr_financialyear} onChange={e => set('hr_financialyear', e.target.value)}>
              {YEARS.map(y => <option key={y} value={y}>{y}</option>)}
            </select>
          </div>

          {/* Priority selector cards */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">Priority</label>
            <div className="grid grid-cols-4 gap-2">
              {PRIORITIES.map(p => {
                const cfg = PRIORITY_CONFIG[p];
                return (
                  <button key={p} type="button"
                    className={`px-3 py-2 rounded-lg text-sm font-medium border transition-all ${form.hr_priority === p
                      ? `${cfg.bg} ${cfg.color} ring-2 ring-opacity-40`
                      : 'border-gray-200 text-gray-600 hover:border-gray-300 hover:bg-gray-50'}`}
                    onClick={() => set('hr_priority', p)}>
                    {cfg.label}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Weightage */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">Weightage (%)</label>
            <input type="number" min={0} max={100}
              className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:ring-2 focus:ring-indigo-500 focus:border-transparent outline-none"
              value={form.hr_weightage} onChange={e => set('hr_weightage', parseInt(e.target.value) || 0)} />
          </div>

          {/* Due Date */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">Due Date</label>
            <input type="date"
              className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:ring-2 focus:ring-indigo-500 focus:border-transparent outline-none"
              value={form.hr_duedate} onChange={e => set('hr_duedate', e.target.value)} />
          </div>

          {/* Key Results */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">Key Results / Milestones</label>
            <textarea rows={3} className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:ring-2 focus:ring-indigo-500 focus:border-transparent outline-none resize-none"
              placeholder="List key results or milestones..." value={form.hr_keyresults} onChange={e => set('hr_keyresults', e.target.value)} />
          </div>
        </div>

        <div className="px-6 py-4 border-t border-gray-100 flex justify-end gap-3">
          <button onClick={onClose} className="px-4 py-2 text-sm font-medium text-gray-600 hover:text-gray-800 transition-colors">Cancel</button>
          <button onClick={() => mutation.mutate()} disabled={mutation.isPending || !form.hr_hrgoal1 || !form.employeeId}
            className="px-5 py-2.5 bg-gradient-to-r from-indigo-600 to-indigo-700 text-white text-sm font-medium rounded-xl hover:from-indigo-700 hover:to-indigo-800 disabled:opacity-50 disabled:cursor-not-allowed shadow-lg shadow-indigo-500/25 transition-all duration-200">
            {mutation.isPending ? 'Assigning...' : 'Assign Goal'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Update Progress Modal ───────────────────────────────────────
function UpdateProgressModal({ goal, onClose }) {
  const qc = useQueryClient();
  const [form, setForm] = useState({
    hr_progress: goal.hr_progress || 0,
    hr_status: goal.hr_status || 'not_started',
    hr_selfrating: goal.hr_selfrating || 0,
    hr_selfcomments: goal.hr_selfcomments || '',
  });

  const mutation = useMutation({
    mutationFn: () => goalsApi.update(goal.hr_hrgoalid, form),
    onSuccess: () => { toast.success('Progress updated!'); qc.invalidateQueries(['goals']); onClose(); },
    onError: () => toast.error('Failed to update progress'),
  });

  const set = (k, v) => setForm(p => ({ ...p, [k]: v }));

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md overflow-hidden">
        <div className="flex items-center justify-between px-6 py-5 border-b border-gray-100">
          <div>
            <h2 className="text-lg font-semibold text-gray-900 tracking-tight">Update Progress</h2>
            <p className="text-sm text-gray-400 mt-0.5 line-clamp-1">{goal.hr_hrgoal1}</p>
          </div>
          <button onClick={onClose} className="p-2 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded-xl transition-all">
            <XMarkIcon className="w-5 h-5" />
          </button>
        </div>

        <div className="px-6 py-5 space-y-5">
          {/* Progress slider */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="text-sm font-medium text-gray-700">Progress</label>
              <span className="text-sm font-bold text-indigo-600">{form.hr_progress}%</span>
            </div>
            <input type="range" min={0} max={100} value={form.hr_progress}
              onChange={e => set('hr_progress', parseInt(e.target.value))}
              className="w-full h-2 bg-gray-200 rounded-full appearance-none cursor-pointer accent-indigo-600" />
            <ProgressBar value={form.hr_progress} showLabel={false} />
          </div>

          {/* Status */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">Status</label>
            <select className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:ring-2 focus:ring-indigo-500 focus:border-transparent outline-none"
              value={form.hr_status} onChange={e => set('hr_status', e.target.value)}>
              {STATUSES.map(s => <option key={s} value={s}>{STATUS_CONFIG[s].label}</option>)}
            </select>
          </div>

          {/* Self Rating */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">Self Rating</label>
            <StarRating value={form.hr_selfrating} onChange={v => set('hr_selfrating', v)} size="lg" />
          </div>

          {/* Self Comments */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">Self Comments</label>
            <textarea rows={3} className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:ring-2 focus:ring-indigo-500 focus:border-transparent outline-none resize-none"
              placeholder="Describe your progress and achievements..." value={form.hr_selfcomments} onChange={e => set('hr_selfcomments', e.target.value)} />
          </div>
        </div>

        <div className="px-6 py-4 border-t border-gray-100 flex justify-end gap-3">
          <button onClick={onClose} className="px-4 py-2 text-sm font-medium text-gray-600 hover:text-gray-800 transition-colors">Cancel</button>
          <button onClick={() => mutation.mutate()} disabled={mutation.isPending}
            className="px-5 py-2.5 bg-gradient-to-r from-indigo-600 to-indigo-700 text-white text-sm font-medium rounded-xl hover:from-indigo-700 hover:to-indigo-800 disabled:opacity-50 shadow-lg shadow-indigo-500/25 transition-all">
            {mutation.isPending ? 'Saving...' : 'Save Progress'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Manager Review Modal ────────────────────────────────────────
function ManagerReviewModal({ goal, onClose }) {
  const qc = useQueryClient();
  const [form, setForm] = useState({
    hr_managerrating: goal.hr_managerrating || 0,
    hr_managercomments: goal.hr_managercomments || '',
    hr_status: goal.hr_status || 'in_progress',
  });

  const mutation = useMutation({
    mutationFn: () => goalsApi.update(goal.hr_hrgoalid, form),
    onSuccess: () => { toast.success('Review submitted!'); qc.invalidateQueries(['goals']); onClose(); },
    onError: () => toast.error('Failed to submit review'),
  });

  const set = (k, v) => setForm(p => ({ ...p, [k]: v }));

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg overflow-hidden">
        <div className="flex items-center justify-between px-6 py-5 border-b border-gray-100">
          <div>
            <h2 className="text-lg font-semibold text-gray-900 tracking-tight">Manager Review</h2>
            <p className="text-sm text-gray-400 mt-0.5 line-clamp-1">{goal.hr_hrgoal1}</p>
          </div>
          <button onClick={onClose} className="p-2 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded-xl transition-all">
            <XMarkIcon className="w-5 h-5" />
          </button>
        </div>

        <div className="px-6 py-5 space-y-5 max-h-[60vh] overflow-y-auto">
          {/* Goal details read-only */}
          <div className="bg-gray-50 rounded-xl p-4 space-y-2">
            <p className="text-sm text-gray-500">Progress: <span className="font-semibold text-gray-700">{goal.hr_progress || 0}%</span></p>
            <ProgressBar value={goal.hr_progress || 0} />
            {goal.hr_selfrating > 0 && (
              <div className="flex items-center gap-2 pt-1">
                <span className="text-sm text-gray-500">Employee Self Rating:</span>
                <StarRating value={goal.hr_selfrating} readOnly size="sm" />
              </div>
            )}
            {goal.hr_selfcomments && (
              <div className="pt-1">
                <p className="text-xs text-gray-400 mb-1">Employee Comments:</p>
                <p className="text-sm text-gray-600 bg-white rounded-lg p-2 border border-gray-100">{goal.hr_selfcomments}</p>
              </div>
            )}
          </div>

          {/* Manager Rating */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">Manager Rating</label>
            <StarRating value={form.hr_managerrating} onChange={v => set('hr_managerrating', v)} size="lg" />
          </div>

          {/* Manager Comments */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">Manager Comments</label>
            <textarea rows={3} className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:ring-2 focus:ring-indigo-500 focus:border-transparent outline-none resize-none"
              placeholder="Provide your review comments..." value={form.hr_managercomments} onChange={e => set('hr_managercomments', e.target.value)} />
          </div>

          {/* Status */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">Update Status</label>
            <select className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:ring-2 focus:ring-indigo-500 focus:border-transparent outline-none"
              value={form.hr_status} onChange={e => set('hr_status', e.target.value)}>
              {STATUSES.map(s => <option key={s} value={s}>{STATUS_CONFIG[s].label}</option>)}
            </select>
          </div>
        </div>

        <div className="px-6 py-4 border-t border-gray-100 flex justify-end gap-3">
          <button onClick={onClose} className="px-4 py-2 text-sm font-medium text-gray-600 hover:text-gray-800 transition-colors">Cancel</button>
          <button onClick={() => mutation.mutate()} disabled={mutation.isPending}
            className="px-5 py-2.5 bg-gradient-to-r from-indigo-600 to-indigo-700 text-white text-sm font-medium rounded-xl hover:from-indigo-700 hover:to-indigo-800 disabled:opacity-50 shadow-lg shadow-indigo-500/25 transition-all">
            {mutation.isPending ? 'Submitting...' : 'Submit Review'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Goal Card ───────────────────────────────────────────────────
function GoalCard({ goal, isHR, onUpdateProgress, onReview, onDelete }) {
  const priority = PRIORITY_CONFIG[goal.hr_priority] || PRIORITY_CONFIG.medium;
  const status = STATUS_CONFIG[goal.hr_status] || STATUS_CONFIG.not_started;

  return (
    <div className={`bg-white rounded-xl border border-gray-100 border-l-4 ${priority.border} shadow-sm hover:shadow-md hover:-translate-y-0.5 transition-all duration-200`}>
      <div className="p-5">
        {/* Header row */}
        <div className="flex items-start justify-between gap-3 mb-2">
          <h3 className="text-base font-semibold text-gray-900 line-clamp-1 flex-1">{goal.hr_hrgoal1}</h3>
          <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium ring-1 ${status.bg} ${status.text} ${status.ring}`}>
            <span className={`w-1.5 h-1.5 rounded-full ${status.dot}`} />
            {status.label}
          </span>
        </div>

        {/* Description */}
        {goal.hr_description && (
          <p className="text-sm text-gray-500 line-clamp-2 mb-3">{goal.hr_description}</p>
        )}

        {/* Tags row */}
        <div className="flex flex-wrap items-center gap-2 mb-3">
          <span className="inline-flex items-center px-2 py-0.5 rounded-md text-xs font-medium bg-indigo-50 text-indigo-600">
            {goal.hr_quarter} {goal.hr_financialyear}
          </span>
          <span className={`inline-flex items-center px-2 py-0.5 rounded-md text-xs font-medium ${priority.bg} ${priority.color}`}>
            {priority.label}
          </span>
          {goal.hr_weightage > 0 && (
            <span className="inline-flex items-center px-2 py-0.5 rounded-md text-xs font-medium bg-purple-50 text-purple-600">
              Weight: {goal.hr_weightage}%
            </span>
          )}
        </div>

        {/* Progress bar */}
        <div className="mb-3">
          <ProgressBar value={goal.hr_progress || 0} />
        </div>

        {/* Due date & ratings row */}
        <div className="flex flex-wrap items-center gap-4 text-xs text-gray-500 mb-3">
          {goal.hr_duedate && (
            <span className="inline-flex items-center gap-1">
              <CalendarDaysIcon className="w-3.5 h-3.5" />
              {new Date(goal.hr_duedate).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}
            </span>
          )}
          {goal.hr_selfrating > 0 && (
            <span className="inline-flex items-center gap-1">
              Self: <StarRating value={goal.hr_selfrating} readOnly size="sm" />
            </span>
          )}
          {goal.hr_managerrating > 0 && (
            <span className="inline-flex items-center gap-1">
              Manager: <StarRating value={goal.hr_managerrating} readOnly size="sm" />
            </span>
          )}
        </div>

        {/* Key Results preview */}
        {goal.hr_keyresults && (
          <p className="text-xs text-gray-400 line-clamp-2 mb-3 border-t border-gray-50 pt-2">{goal.hr_keyresults}</p>
        )}

        {/* Actions */}
        <div className="flex items-center gap-2 pt-2 border-t border-gray-50">
          <button onClick={() => onUpdateProgress(goal)}
            className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-medium text-indigo-600 hover:bg-indigo-50 rounded-lg transition-colors">
            <ArrowTrendingUpIcon className="w-3.5 h-3.5" /> Update Progress
          </button>
          {isHR && (
            <>
              <button onClick={() => onReview(goal)}
                className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-medium text-purple-600 hover:bg-purple-50 rounded-lg transition-colors">
                <ClipboardDocumentCheckIcon className="w-3.5 h-3.5" /> Review
              </button>
              <button onClick={() => onDelete(goal)}
                className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-medium text-red-500 hover:bg-red-50 rounded-lg transition-colors ml-auto">
                <TrashIcon className="w-3.5 h-3.5" /> Delete
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Main Page ───────────────────────────────────────────────────
export default function GoalsPage() {
  const { user } = useAuth();
  const qc = useQueryClient();
  const isHR = ['super_admin', 'hr_manager'].includes(user?.role);

  const [filters, setFilters] = useState({ quarter: '', year: '', status: '', employeeId: '' });
  const [showAssign, setShowAssign] = useState(false);
  const [progressGoal, setProgressGoal] = useState(null);
  const [reviewGoal, setReviewGoal] = useState(null);

  const queryParams = {};
  if (filters.quarter) queryParams.quarter = filters.quarter;
  if (filters.year) queryParams.year = filters.year;
  if (filters.status) queryParams.status = filters.status;
  if (filters.employeeId) queryParams.employeeId = filters.employeeId;

  const { data, isLoading } = useQuery({
    queryKey: ['goals', queryParams],
    queryFn: () => goalsApi.list(queryParams),
  });

  const goals = data?.data?.data || [];
  const totalCount = data?.data?.count || goals.length;

  const deleteMutation = useMutation({
    mutationFn: (id) => goalsApi.delete(id),
    onSuccess: () => { toast.success('Goal deleted'); qc.invalidateQueries(['goals']); },
    onError: () => toast.error('Failed to delete goal'),
  });

  const handleDelete = (goal) => {
    if (window.confirm(`Delete goal "${goal.hr_hrgoal1}"?`)) {
      deleteMutation.mutate(goal.hr_hrgoalid);
    }
  };

  // Stats
  const stats = useMemo(() => {
    const completed = goals.filter(g => g.hr_status === 'completed' || g.hr_status === 'exceeded').length;
    const inProgress = goals.filter(g => g.hr_status === 'in_progress').length;
    const avgProgress = goals.length > 0
      ? Math.round(goals.reduce((sum, g) => sum + (g.hr_progress || 0), 0) / goals.length)
      : 0;
    return { total: goals.length, completed, inProgress, avgProgress };
  }, [goals]);

  // Employee list for HR filter
  const { data: empData } = useQuery({
    queryKey: ['employees-all'],
    queryFn: () => employeeApi.list({ limit: 200, status: 'active' }),
    enabled: isHR,
  });
  const employees = empData?.data?.data || [];

  return (
    <div className="space-y-6">
      {/* Page Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 bg-gradient-to-br from-indigo-500 to-indigo-700 rounded-xl flex items-center justify-center shadow-lg shadow-indigo-500/20">
            <FlagIcon className="w-5 h-5 text-white" />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-gray-900 tracking-tight">Employee Goals</h1>
            <p className="text-sm text-gray-400">{totalCount} total goals</p>
          </div>
        </div>
        {isHR && (
          <button onClick={() => setShowAssign(true)}
            className="inline-flex items-center gap-2 px-4 py-2.5 bg-gradient-to-r from-indigo-600 to-indigo-700 text-white text-sm font-medium rounded-xl hover:from-indigo-700 hover:to-indigo-800 shadow-lg shadow-indigo-500/25 transition-all duration-200">
            <PlusIcon className="w-4 h-4" /> Assign Goal
          </button>
        )}
      </div>

      {/* Filter Bar */}
      <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-4">
        <div className="flex flex-wrap items-center gap-4">
          {/* Quarter pills */}
          <div className="flex items-center gap-1 bg-gray-50 rounded-lg p-1">
            <button onClick={() => setFilters(p => ({ ...p, quarter: '' }))}
              className={`px-3 py-1.5 rounded-md text-xs font-medium transition-all ${!filters.quarter ? 'bg-white text-indigo-600 shadow-sm' : 'text-gray-500 hover:text-gray-700'}`}>
              All
            </button>
            {QUARTERS.map(q => (
              <button key={q} onClick={() => setFilters(p => ({ ...p, quarter: p.quarter === q ? '' : q }))}
                className={`px-3 py-1.5 rounded-md text-xs font-medium transition-all ${filters.quarter === q ? 'bg-white text-indigo-600 shadow-sm' : 'text-gray-500 hover:text-gray-700'}`}>
                {q}
              </button>
            ))}
          </div>

          {/* Year */}
          <select className="px-3 py-2 border border-gray-200 rounded-lg text-sm focus:ring-2 focus:ring-indigo-500 focus:border-transparent outline-none"
            value={filters.year} onChange={e => setFilters(p => ({ ...p, year: e.target.value }))}>
            <option value="">All Years</option>
            {YEARS.map(y => <option key={y} value={y}>{y}</option>)}
          </select>

          {/* Status */}
          <select className="px-3 py-2 border border-gray-200 rounded-lg text-sm focus:ring-2 focus:ring-indigo-500 focus:border-transparent outline-none"
            value={filters.status} onChange={e => setFilters(p => ({ ...p, status: e.target.value }))}>
            <option value="">All Statuses</option>
            {STATUSES.map(s => <option key={s} value={s}>{STATUS_CONFIG[s].label}</option>)}
          </select>

          {/* Employee filter (HR only) */}
          {isHR && (
            <select className="px-3 py-2 border border-gray-200 rounded-lg text-sm focus:ring-2 focus:ring-indigo-500 focus:border-transparent outline-none"
              value={filters.employeeId} onChange={e => setFilters(p => ({ ...p, employeeId: e.target.value }))}>
              <option value="">All Employees</option>
              {employees.map(emp => (
                <option key={emp.hr_hremployeeid} value={emp.hr_hremployeeid}>{emp.hr_hremployee1}</option>
              ))}
            </select>
          )}
        </div>
      </div>

      {/* Summary Stats */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-5 border-l-4 border-l-indigo-400">
          <p className="text-xs font-medium text-gray-400 uppercase tracking-wider mb-1">Total Goals</p>
          <p className="text-2xl font-bold text-gray-900">{stats.total}</p>
        </div>
        <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-5 border-l-4 border-l-emerald-400">
          <p className="text-xs font-medium text-gray-400 uppercase tracking-wider mb-1">Completed</p>
          <p className="text-2xl font-bold text-gray-900">{stats.completed}</p>
        </div>
        <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-5 border-l-4 border-l-amber-400">
          <p className="text-xs font-medium text-gray-400 uppercase tracking-wider mb-1">In Progress</p>
          <p className="text-2xl font-bold text-gray-900">{stats.inProgress}</p>
        </div>
        <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-5 border-l-4 border-l-purple-400">
          <p className="text-xs font-medium text-gray-400 uppercase tracking-wider mb-1">Avg Progress</p>
          <div className="flex items-center gap-3">
            <CircularProgress value={stats.avgProgress} />
            <span className="text-2xl font-bold text-gray-900">{stats.avgProgress}%</span>
          </div>
        </div>
      </div>

      {/* Goals Grid */}
      {isLoading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {[...Array(6)].map((_, i) => <GoalCardSkeleton key={i} />)}
        </div>
      ) : goals.length === 0 ? (
        <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-16 text-center">
          <div className="w-16 h-16 bg-gray-100 rounded-2xl flex items-center justify-center mx-auto mb-4">
            <FlagIcon className="w-8 h-8 text-gray-300" />
          </div>
          <h3 className="text-lg font-semibold text-gray-700 mb-1">No goals found</h3>
          <p className="text-sm text-gray-400">
            {isHR ? 'Click "Assign Goal" to create the first goal.' : 'No goals have been assigned yet.'}
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {goals.map(goal => (
            <GoalCard key={goal.hr_hrgoalid} goal={goal} isHR={isHR}
              onUpdateProgress={setProgressGoal}
              onReview={setReviewGoal}
              onDelete={handleDelete} />
          ))}
        </div>
      )}

      {/* Modals */}
      {showAssign && <AssignGoalModal onClose={() => setShowAssign(false)} />}
      {progressGoal && <UpdateProgressModal goal={progressGoal} onClose={() => setProgressGoal(null)} />}
      {reviewGoal && <ManagerReviewModal goal={reviewGoal} onClose={() => setReviewGoal(null)} />}
    </div>
  );
}
