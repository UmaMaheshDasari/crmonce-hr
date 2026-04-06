import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { performanceApi, employeeApi } from '../../api/endpoints';
import { PlusIcon, XMarkIcon, StarIcon, FunnelIcon } from '@heroicons/react/24/outline';
import { StarIcon as StarSolid } from '@heroicons/react/24/solid';
import { useAuth } from '../../context/AuthContext';
import toast from 'react-hot-toast';

const CYCLES = ['Q1 2026', 'Q2 2026', 'Q3 2026', 'Q4 2026', 'Annual 2025'];
const STATUS_BADGE = { draft: 'badge-gray', 'in-review': 'badge-yellow', completed: 'badge-green' };
const STATUS_DOT = { draft: 'bg-gray-400', 'in-review': 'bg-amber-400', completed: 'bg-emerald-400' };

function StarRating({ value, onChange, readOnly, size = 'md' }) {
  const sizeClasses = size === 'lg' ? 'w-7 h-7' : size === 'md' ? 'w-5 h-5' : 'w-4 h-4';
  return (
    <div className="flex gap-0.5">
      {[1, 2, 3, 4, 5].map(star => (
        <button key={star} type="button" onClick={() => !readOnly && onChange?.(star)}
          className={`${readOnly ? 'cursor-default' : 'cursor-pointer hover:scale-125'} transition-all duration-150`}>
          {star <= value
            ? <StarSolid className={`${sizeClasses} text-amber-400 drop-shadow-sm`} />
            : <StarIcon className={`${sizeClasses} text-gray-200 hover:text-amber-300 transition-colors`} />}
        </button>
      ))}
    </div>
  );
}

function NewReviewModal({ onClose }) {
  const qc = useQueryClient();
  const { user } = useAuth();
  const [form, setForm] = useState({ employeeId: '', cycle: CYCLES[0], rating: 3, goals: '', kpis: '', notes: '' });
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
    mutationFn: () => performanceApi.create({
      'hr_employee@odata.bind': `/hr_employees(${form.employeeId})`,
      hr_cycle: form.cycle, hr_rating: form.rating,
      hr_goals: form.goals, hr_kpis: form.kpis, hr_reviewernotes: form.notes,
      hr_status: 'draft',
    }),
    onSuccess: () => { toast.success('Review created!'); qc.invalidateQueries(['performance']); onClose(); },
    onError: () => toast.error('Failed to create review'),
  });

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg overflow-hidden animate-in fade-in duration-200">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-5 border-b border-gray-100">
          <div>
            <h2 className="text-lg font-semibold text-gray-900 tracking-tight">New Performance Review</h2>
            <p className="text-sm text-gray-400 mt-0.5">Evaluate employee performance</p>
          </div>
          <button onClick={onClose} className="p-2 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded-xl transition-all">
            <XMarkIcon className="w-5 h-5" />
          </button>
        </div>

        {/* Body */}
        <div className="px-6 py-5 space-y-5 max-h-[60vh] overflow-y-auto">
          {/* Employee selector with search */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">Employee</label>
            <div className="relative">
              <input
                type="text"
                className="input mb-1"
                placeholder="Search employees..."
                value={empSearch}
                onChange={e => setEmpSearch(e.target.value)}
              />
              <select className="input" value={form.employeeId} onChange={e => setForm(p => ({ ...p, employeeId: e.target.value }))}
                size={empSearch ? Math.min(filteredEmployees.length + 1, 5) : 1}>
                <option value="">Select employee</option>
                {filteredEmployees.map(e => (
                  <option key={e.hr_hremployeeid} value={e.hr_hremployeeid}>{e.hr_hremployee1}</option>
                ))}
              </select>
            </div>
          </div>

          {/* Cycle */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">Review Cycle</label>
            <select className="input" value={form.cycle} onChange={e => setForm(p => ({ ...p, cycle: e.target.value }))}>
              {CYCLES.map(c => <option key={c}>{c}</option>)}
            </select>
          </div>

          {/* Rating */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">Overall Rating</label>
            <div className="flex items-center gap-4 bg-amber-50/60 rounded-xl px-4 py-3 border border-amber-200/50">
              <StarRating value={form.rating} onChange={v => setForm(p => ({ ...p, rating: v }))} size="lg" />
              <div className="h-6 w-px bg-amber-200/60" />
              <span className="text-lg font-bold text-amber-600">{form.rating}<span className="text-sm font-normal text-amber-400">/5</span></span>
            </div>
          </div>

          {/* Goals */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">Goals Achieved</label>
            <textarea className="input h-24 resize-none" placeholder="List goals accomplished during this period..."
              value={form.goals} onChange={e => setForm(p => ({ ...p, goals: e.target.value }))} />
          </div>

          {/* KPIs */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">Key Performance Indicators</label>
            <textarea className="input h-24 resize-none" placeholder="Measurable performance metrics..."
              value={form.kpis} onChange={e => setForm(p => ({ ...p, kpis: e.target.value }))} />
          </div>

          {/* Notes */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">Reviewer Notes</label>
            <textarea className="input h-24 resize-none" placeholder="Additional observations and feedback..."
              value={form.notes} onChange={e => setForm(p => ({ ...p, notes: e.target.value }))} />
          </div>
        </div>

        {/* Footer */}
        <div className="flex gap-3 px-6 py-4 bg-gray-50/80 border-t border-gray-100">
          <button onClick={onClose} className="btn-secondary flex-1">Cancel</button>
          <button onClick={() => mutation.mutate()} disabled={!form.employeeId || mutation.isLoading}
            className="btn-primary flex-1 flex items-center justify-center gap-2">
            {mutation.isLoading && <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />}
            Create Review
          </button>
        </div>
      </div>
    </div>
  );
}

export default function PerformancePage() {
  const { isHR } = useAuth();
  const [showModal, setShowModal] = useState(false);
  const [cycle, setCycle] = useState('');

  const { data, isLoading } = useQuery({
    queryKey: ['performance', cycle],
    queryFn: () => performanceApi.list({ cycle: cycle || undefined }),
  });

  const reviews = data?.data?.data || [];

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 tracking-tight">Performance</h1>
          <p className="text-gray-400 text-sm mt-1">{reviews.length} reviews</p>
        </div>
        {isHR() && (
          <button onClick={() => setShowModal(true)}
            className="btn-primary flex items-center gap-2 shadow-lg shadow-indigo-500/20 hover:shadow-xl hover:shadow-indigo-500/30 transition-all duration-200">
            <PlusIcon className="w-4 h-4" /> New Review
          </button>
        )}
      </div>

      {/* Filter Bar */}
      <div className="bg-white rounded-xl border border-gray-200/60 px-4 py-3 flex items-center gap-3">
        <FunnelIcon className="w-4 h-4 text-gray-400" />
        <select className="input w-auto !border-gray-200 !rounded-lg" value={cycle} onChange={e => setCycle(e.target.value)}>
          <option value="">All Cycles</option>
          {CYCLES.map(c => <option key={c}>{c}</option>)}
        </select>
        {cycle && (
          <button onClick={() => setCycle('')} className="text-xs text-gray-400 hover:text-gray-600 transition-colors">
            Clear
          </button>
        )}
      </div>

      {/* Reviews Grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4">
        {isLoading ? (
          Array(6).fill(0).map((_, i) => (
            <div key={i} className="bg-white rounded-2xl border border-gray-200/60 h-52 animate-pulse">
              <div className="p-5 space-y-3">
                <div className="flex justify-between">
                  <div className="w-32 h-5 bg-gray-100 rounded-lg" />
                  <div className="w-16 h-5 bg-gray-100 rounded-full" />
                </div>
                <div className="flex gap-1 mt-3">
                  {Array(5).fill(0).map((_, j) => <div key={j} className="w-5 h-5 bg-gray-100 rounded" />)}
                </div>
                <div className="w-full h-12 bg-gray-100 rounded-lg mt-3" />
              </div>
            </div>
          ))
        ) : reviews.length === 0 ? (
          <div className="col-span-3 bg-white rounded-2xl border border-gray-200/60 p-16 text-center">
            <div className="w-14 h-14 bg-amber-50 rounded-2xl flex items-center justify-center mx-auto mb-4">
              <StarIcon className="w-7 h-7 text-amber-300" />
            </div>
            <p className="text-gray-400 font-medium">No performance reviews found</p>
            <p className="text-gray-300 text-sm mt-1">Reviews will appear here once created</p>
          </div>
        ) : (
          reviews.map(r => (
            <div key={r.hr_hrperformanceid}
              className="group bg-white rounded-2xl border border-gray-200/60 p-5 hover:shadow-lg hover:shadow-gray-200/50 hover:-translate-y-0.5 transition-all duration-300">
              {/* Header */}
              <div className="flex items-start justify-between mb-3">
                <div className="flex-1 min-w-0">
                  <p className="font-semibold text-gray-900 text-base truncate">
                    {r['_hr_employee_value@OData.Community.Display.V1.FormattedValue'] || 'Employee'}
                  </p>
                  <span className="inline-flex items-center mt-1.5 px-2.5 py-0.5 rounded-lg text-xs font-medium bg-indigo-50 text-indigo-600 border border-indigo-100/60">
                    {r.hr_cycle}
                  </span>
                </div>
                <div className="flex items-center gap-1.5 flex-shrink-0">
                  <span className={`w-2 h-2 rounded-full ${STATUS_DOT[r.hr_status] || 'bg-gray-300'}`} />
                  <span className="text-xs font-medium text-gray-500 capitalize">{r.hr_status}</span>
                </div>
              </div>

              {/* Rating */}
              <div className="flex items-center gap-2 mb-3">
                <StarRating value={r.hr_rating || 0} readOnly />
                <span className="text-sm font-semibold text-amber-500">{r.hr_rating || 0}</span>
              </div>

              {/* Goals */}
              {r.hr_goals && (
                <div className="relative">
                  <p className="text-sm text-gray-600 line-clamp-2 leading-relaxed">{r.hr_goals}</p>
                  <div className="absolute bottom-0 left-0 right-0 h-6 bg-gradient-to-t from-white to-transparent pointer-events-none" />
                </div>
              )}

              {/* Reviewer notes */}
              {r.hr_reviewernotes && (
                <p className="text-xs text-gray-400 italic line-clamp-1 mt-2 pt-2 border-t border-gray-100">
                  &ldquo;{r.hr_reviewernotes}&rdquo;
                </p>
              )}
            </div>
          ))
        )}
      </div>

      {showModal && <NewReviewModal onClose={() => setShowModal(false)} />}
    </div>
  );
}
