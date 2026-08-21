import { useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { performanceApi, employeeApi } from '../../api/endpoints';
import {
  PlusIcon, XMarkIcon, StarIcon, MagnifyingGlassIcon, PencilSquareIcon,
  ClipboardDocumentListIcon, DocumentTextIcon, ClockIcon, CheckCircleIcon,
} from '@heroicons/react/24/outline';
import { StarIcon as StarSolid } from '@heroicons/react/24/solid';
import { useAuth } from '../../context/AuthContext';
import toast from 'react-hot-toast';

const CYCLES = ['Q1 2026', 'Q2 2026', 'Q3 2026', 'Q4 2026', 'Annual 2025'];

// Professional, subtle status badges (Draft → gray, In Review → amber, Completed → green).
const STATUS = {
  draft: { label: 'Draft', badge: 'bg-gray-100 text-gray-600 ring-gray-200', dot: 'bg-gray-400' },
  'in-review': { label: 'In Review', badge: 'bg-amber-50 text-amber-700 ring-amber-200', dot: 'bg-amber-400' },
  completed: { label: 'Completed', badge: 'bg-emerald-50 text-emerald-700 ring-emerald-200', dot: 'bg-emerald-500' },
};
const statusOf = (s) => STATUS[s] || { label: s || '—', badge: 'bg-gray-100 text-gray-600 ring-gray-200', dot: 'bg-gray-300' };
const STATUS_OPTIONS = [['', 'All Statuses'], ['draft', 'Draft'], ['in-review', 'In Review'], ['completed', 'Completed']];

const initials = (name) =>
  String(name || '').trim().split(/\s+/).slice(0, 2).map(w => w[0]?.toUpperCase() || '').join('') || 'E';
const empName = (r) => r['_hr_employee_value@OData.Community.Display.V1.FormattedValue'] || 'Employee';

function StarRating({ value, onChange, readOnly, size = 'md' }) {
  const sizeClasses = size === 'lg' ? 'w-7 h-7' : size === 'md' ? 'w-5 h-5' : 'w-4 h-4';
  return (
    <div className="flex gap-0.5" role={readOnly ? 'img' : undefined} aria-label={readOnly ? `Rating ${value} out of 5` : undefined}>
      {[1, 2, 3, 4, 5].map(star => (
        <button key={star} type="button" onClick={() => !readOnly && onChange?.(star)}
          aria-label={readOnly ? undefined : `Set rating to ${star}`} tabIndex={readOnly ? -1 : 0}
          className={`${readOnly ? 'cursor-default' : 'cursor-pointer hover:scale-125'} transition-all duration-150`}>
          {star <= value
            ? <StarSolid className={`${sizeClasses} text-amber-400 drop-shadow-sm`} />
            : <StarIcon className={`${sizeClasses} text-gray-200 hover:text-amber-300 transition-colors`} />}
        </button>
      ))}
    </div>
  );
}

/**
 * Create OR edit a review. CREATE preserves the existing contract exactly (no employeeId
 * in the body — the backend attaches the hr_hremployee lookup). EDIT uses the existing
 * performanceApi.update endpoint (patch the editable fields + status → supports the
 * Draft → In Review → Completed workflow). No new backend behaviour is introduced.
 */
function ReviewModal({ review, onClose }) {
  const isEdit = !!review;
  const qc = useQueryClient();
  const [form, setForm] = useState(isEdit
    ? { employeeId: '', cycle: review.hr_cycle || CYCLES[0], rating: review.hr_rating || 3, goals: review.hr_goals || '', kpis: review.hr_kpis || '', notes: review.hr_reviewernotes || '', status: review.hr_status || 'draft' }
    : { employeeId: '', cycle: CYCLES[0], rating: 3, goals: '', kpis: '', notes: '' });
  const [empSearch, setEmpSearch] = useState('');

  const { data: empData } = useQuery({
    enabled: !isEdit,
    queryKey: ['employees-all'],
    queryFn: () => employeeApi.list({ limit: 500, status: 'active' }),
  });
  const employees = empData?.data?.data || [];
  const filteredEmployees = empSearch
    ? employees.filter(e => e.hr_hremployee1?.toLowerCase().includes(empSearch.toLowerCase()))
    : employees;

  const mutation = useMutation({
    mutationFn: () => isEdit
      ? performanceApi.update(review.hr_hrperformanceid, {
          hr_cycle: form.cycle, hr_rating: form.rating, hr_goals: form.goals, hr_kpis: form.kpis,
          hr_reviewernotes: form.notes, hr_status: form.status,
        })
      // CREATE — identical body to the original: the backend attaches the hr_hremployee lookup.
      : performanceApi.create({
          hr_cycle: form.cycle, hr_rating: form.rating,
          hr_goals: form.goals, hr_kpis: form.kpis, hr_reviewernotes: form.notes,
          hr_status: 'draft',
        }),
    onSuccess: () => { toast.success(isEdit ? 'Review updated!' : 'Review created!'); qc.invalidateQueries({ queryKey: ['performance'] }); onClose(); },
    onError: () => toast.error(isEdit ? 'Failed to update review' : 'Failed to create review'),
  });

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4" role="dialog" aria-modal="true" aria-label={isEdit ? 'Edit performance review' : 'New performance review'}>
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg max-h-[calc(100dvh-2rem)] overflow-x-hidden overflow-y-auto animate-in fade-in duration-200">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-5 border-b border-gray-100">
          <div>
            <h2 className="text-lg font-semibold text-gray-900 tracking-tight">{isEdit ? 'Edit Performance Review' : 'New Performance Review'}</h2>
            <p className="text-sm text-gray-400 mt-0.5">{isEdit ? empName(review) : 'Evaluate employee performance'}</p>
          </div>
          <button onClick={onClose} aria-label="Close" className="p-2 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded-xl transition-all">
            <XMarkIcon className="w-5 h-5" />
          </button>
        </div>

        {/* Body */}
        <div className="px-6 py-5 space-y-5 max-h-[60vh] overflow-y-auto">
          {!isEdit ? (
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5" htmlFor="rv-emp">Employee</label>
              <div className="relative">
                <input id="rv-emp" type="text" className="input mb-1" placeholder="Search employees..." value={empSearch} onChange={e => setEmpSearch(e.target.value)} />
                <select className="input" aria-label="Select employee" value={form.employeeId} onChange={e => setForm(p => ({ ...p, employeeId: e.target.value }))}
                  size={empSearch ? Math.min(filteredEmployees.length + 1, 5) : 1}>
                  <option value="">Select employee</option>
                  {filteredEmployees.map(e => (<option key={e.hr_hremployeeid} value={e.hr_hremployeeid}>{e.hr_hremployee1}</option>))}
                </select>
              </div>
            </div>
          ) : (
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">Status</label>
              <select className="input" aria-label="Review status" value={form.status} onChange={e => setForm(p => ({ ...p, status: e.target.value }))}>
                <option value="draft">Draft</option>
                <option value="in-review">In Review</option>
                <option value="completed">Completed</option>
              </select>
            </div>
          )}

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">Review Cycle</label>
            <select className="input" aria-label="Review cycle" value={form.cycle} onChange={e => setForm(p => ({ ...p, cycle: e.target.value }))}>
              {[...new Set([...CYCLES, form.cycle].filter(Boolean))].map(c => <option key={c}>{c}</option>)}
            </select>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">Overall Rating</label>
            <div className="flex items-center gap-4 bg-amber-50/60 rounded-xl px-4 py-3 border border-amber-200/50">
              <StarRating value={form.rating} onChange={v => setForm(p => ({ ...p, rating: v }))} size="lg" />
              <div className="h-6 w-px bg-amber-200/60" />
              <span className="text-lg font-bold text-amber-600">{form.rating}<span className="text-sm font-normal text-amber-400">/5</span></span>
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">Goals Achieved</label>
            <textarea className="input h-24 resize-none" placeholder="List goals accomplished during this period..." value={form.goals} onChange={e => setForm(p => ({ ...p, goals: e.target.value }))} />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">Key Performance Indicators</label>
            <textarea className="input h-24 resize-none" placeholder="Measurable performance metrics..." value={form.kpis} onChange={e => setForm(p => ({ ...p, kpis: e.target.value }))} />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">Reviewer Notes</label>
            <textarea className="input h-24 resize-none" placeholder="Additional observations and feedback..." value={form.notes} onChange={e => setForm(p => ({ ...p, notes: e.target.value }))} />
          </div>
        </div>

        {/* Footer */}
        <div className="flex gap-3 px-6 py-4 bg-gray-50/80 border-t border-gray-100">
          <button onClick={onClose} className="btn-secondary flex-1">Cancel</button>
          <button onClick={() => mutation.mutate()} disabled={(!isEdit && !form.employeeId) || mutation.isPending}
            className="btn-primary flex-1 flex items-center justify-center gap-2">
            {mutation.isPending && <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />}
            {isEdit ? 'Save Changes' : 'Create Review'}
          </button>
        </div>
      </div>
    </div>
  );
}

function StatCard({ icon: Icon, label, value, accent }) {
  return (
    <div className="bg-white rounded-2xl border border-gray-200/70 p-4 sm:p-5 shadow-sm">
      <div className="flex items-center justify-between">
        <div className="min-w-0">
          <p className="text-2xl font-bold text-[#17223B] tabular-nums leading-none">{value}</p>
          <p className="text-xs font-medium text-gray-500 mt-2">{label}</p>
        </div>
        <div className={`w-10 h-10 rounded-xl grid place-items-center flex-shrink-0 ${accent}`}>
          <Icon className="w-5 h-5" />
        </div>
      </div>
    </div>
  );
}

const RATINGS = [['', 'Any rating'], ['5', '5 ★'], ['4', '4 ★ & up'], ['3', '3 ★ & up'], ['2', '2 ★ & up'], ['1', '1 ★ & up']];

export default function PerformancePage() {
  const { isHR } = useAuth();
  const [showModal, setShowModal] = useState(false);
  const [editReview, setEditReview] = useState(null);
  const [search, setSearch] = useState('');
  const [cycle, setCycle] = useState('');
  const [status, setStatus] = useState('');
  const [rating, setRating] = useState('');

  // Fetch all reviews once; summary + filters are computed client-side from real data.
  const { data, isLoading } = useQuery({
    queryKey: ['performance'],
    queryFn: () => performanceApi.list(),
  });
  const reviews = data?.data?.data || [];

  const counts = useMemo(() => ({
    total: reviews.length,
    draft: reviews.filter(r => r.hr_status === 'draft').length,
    'in-review': reviews.filter(r => r.hr_status === 'in-review').length,
    completed: reviews.filter(r => r.hr_status === 'completed').length,
  }), [reviews]);

  const dataCycles = useMemo(() => [...new Set(reviews.map(r => r.hr_cycle).filter(Boolean))].sort(), [reviews]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const minR = rating ? Number(rating) : 0;
    return reviews.filter(r => {
      if (cycle && r.hr_cycle !== cycle) return false;
      if (status && r.hr_status !== status) return false;
      if (minR && (Number(r.hr_rating) || 0) < minR) return false;
      if (q) {
        const hay = `${empName(r)} ${r.hr_cycle || ''} ${r.hr_goals || ''} ${r.hr_kpis || ''} ${r.hr_reviewernotes || ''}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [reviews, search, cycle, status, rating]);

  const hasFilters = !!(search || cycle || status || rating);
  const clearFilters = () => { setSearch(''); setCycle(''); setStatus(''); setRating(''); };

  return (
    <div className="space-y-6">
      {/* 1. Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-[#17223B] tracking-tight">Performance</h1>
          <p className="text-gray-500 text-sm mt-1">Manage employee performance reviews, evaluations and feedback.</p>
        </div>
        {isHR() && (
          <button onClick={() => setShowModal(true)} aria-label="Create a new performance review"
            className="btn-primary flex items-center justify-center gap-2 shadow-lg shadow-indigo-500/20 hover:shadow-xl hover:shadow-indigo-500/30 transition-all duration-200 whitespace-nowrap">
            <PlusIcon className="w-4 h-4" /> New Review
          </button>
        )}
      </div>

      {/* 2. Summary */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
        {isLoading ? (
          Array(4).fill(0).map((_, i) => (
            <div key={i} className="bg-white rounded-2xl border border-gray-200/70 p-5 shadow-sm animate-pulse">
              <div className="flex items-center justify-between">
                <div className="space-y-2"><div className="w-10 h-6 bg-gray-100 rounded" /><div className="w-16 h-3 bg-gray-100 rounded" /></div>
                <div className="w-10 h-10 bg-gray-100 rounded-xl" />
              </div>
            </div>
          ))
        ) : (
          <>
            <StatCard icon={ClipboardDocumentListIcon} label="Total Reviews" value={counts.total} accent="bg-indigo-50 text-indigo-500" />
            <StatCard icon={DocumentTextIcon} label="Draft" value={counts.draft} accent="bg-gray-100 text-gray-500" />
            <StatCard icon={ClockIcon} label="In Review" value={counts['in-review']} accent="bg-amber-50 text-amber-500" />
            <StatCard icon={CheckCircleIcon} label="Completed" value={counts.completed} accent="bg-emerald-50 text-emerald-500" />
          </>
        )}
      </div>

      {/* 3. Filter / search toolbar */}
      {isLoading ? (
        <div className="bg-white rounded-2xl border border-gray-200/70 p-4 shadow-sm animate-pulse h-16" />
      ) : (
        <div className="bg-white rounded-2xl border border-gray-200/70 p-3 sm:p-4 shadow-sm">
          <div className="flex flex-col lg:flex-row gap-3 lg:items-center">
            <div className="relative flex-1 min-w-0">
              <MagnifyingGlassIcon className="w-4 h-4 text-gray-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
              <input aria-label="Search reviews" className="input !pl-9" placeholder="Search employee, cycle or feedback…"
                value={search} onChange={e => setSearch(e.target.value)} />
            </div>
            <div className="flex flex-wrap gap-2">
              <select aria-label="Filter by review cycle" className="input w-auto min-w-[9rem]" value={cycle} onChange={e => setCycle(e.target.value)}>
                <option value="">All Cycles</option>
                {dataCycles.map(c => <option key={c}>{c}</option>)}
              </select>
              <select aria-label="Filter by status" className="input w-auto min-w-[9rem]" value={status} onChange={e => setStatus(e.target.value)}>
                {STATUS_OPTIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
              <select aria-label="Filter by rating" className="input w-auto min-w-[8rem]" value={rating} onChange={e => setRating(e.target.value)}>
                {RATINGS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
              {hasFilters && (
                <button onClick={clearFilters} className="px-3 py-2 text-sm font-medium text-gray-500 hover:text-[#EC4899] hover:bg-gray-50 rounded-lg transition-colors">
                  Clear filters
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* 4. Reviews grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4 sm:gap-5">
        {isLoading ? (
          Array(6).fill(0).map((_, i) => (
            <div key={i} className="bg-white rounded-2xl border border-gray-200/70 shadow-sm animate-pulse">
              <div className="p-5 space-y-4">
                <div className="flex items-center gap-3">
                  <div className="w-11 h-11 bg-gray-100 rounded-xl" />
                  <div className="space-y-2 flex-1"><div className="w-28 h-4 bg-gray-100 rounded" /><div className="w-16 h-3 bg-gray-100 rounded" /></div>
                  <div className="w-16 h-5 bg-gray-100 rounded-full" />
                </div>
                <div className="flex gap-1">{Array(5).fill(0).map((_, j) => <div key={j} className="w-4 h-4 bg-gray-100 rounded" />)}</div>
                <div className="w-full h-10 bg-gray-100 rounded-lg" />
              </div>
              <div className="h-11 border-t border-gray-100" />
            </div>
          ))
        ) : filtered.length === 0 ? (
          <div className="col-span-full bg-white rounded-2xl border border-gray-200/70 shadow-sm px-6 py-16 text-center">
            <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-pink-50 to-violet-50 grid place-items-center mx-auto mb-5 ring-1 ring-pink-100">
              <StarIcon className="w-8 h-8 text-[#EC4899]" />
            </div>
            <h3 className="text-lg font-semibold text-[#17223B]">{reviews.length ? 'No reviews match your filters' : 'No performance reviews yet'}</h3>
            <p className="text-gray-500 text-sm mt-1.5 max-w-sm mx-auto">
              {reviews.length ? 'Try adjusting or clearing the filters to see more reviews.' : 'Create your first performance review to start tracking employee progress.'}
            </p>
            {reviews.length ? (
              <button onClick={clearFilters} className="btn-secondary mt-5">Clear filters</button>
            ) : (isHR() && (
              <button onClick={() => setShowModal(true)} className="btn-primary mt-5 inline-flex items-center gap-2">
                <PlusIcon className="w-4 h-4" /> New Review
              </button>
            ))}
          </div>
        ) : (
          filtered.map(r => {
            const st = statusOf(r.hr_status);
            const name = empName(r);
            return (
              <div key={r.hr_hrperformanceid}
                className="group bg-white rounded-2xl border border-gray-200/70 shadow-sm hover:shadow-md hover:border-gray-300/70 transition-all duration-200 flex flex-col">
                <div className="p-5 flex-1">
                  {/* Employee + cycle + status */}
                  <div className="flex items-start gap-3">
                    <div className="w-11 h-11 rounded-xl grid place-items-center text-white font-semibold text-sm flex-shrink-0 bg-gradient-to-br from-[#EC4899] to-[#8b5cf6]" aria-hidden="true">
                      {initials(name)}
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="font-semibold text-[#17223B] truncate leading-tight">{name}</p>
                      {r.hr_cycle && <p className="text-xs text-gray-500 mt-0.5">{r.hr_cycle}</p>}
                    </div>
                    <span className={`flex-shrink-0 inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-semibold ring-1 ring-inset ${st.badge}`}>
                      <span className={`w-1.5 h-1.5 rounded-full ${st.dot}`} />{st.label}
                    </span>
                  </div>

                  {/* Rating */}
                  <div className="flex items-center gap-2 mt-4">
                    <StarRating value={r.hr_rating || 0} readOnly size="sm" />
                    {r.hr_rating != null && r.hr_rating !== '' && (
                      <span className="text-sm font-semibold text-[#17223B]">{Number(r.hr_rating).toFixed(1)}<span className="text-gray-400 font-normal"> / 5</span></span>
                    )}
                  </div>

                  {/* Goals (hidden when empty — never invented) */}
                  {r.hr_goals && (
                    <div className="mt-4">
                      <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-400 mb-1">Goals</p>
                      <p className="text-sm text-gray-600 line-clamp-2 leading-relaxed">{r.hr_goals}</p>
                    </div>
                  )}

                  {/* Feedback / reviewer notes */}
                  {r.hr_reviewernotes && (
                    <div className="mt-3 rounded-xl bg-gray-50 px-3 py-2">
                      <p className="text-xs text-gray-500 italic line-clamp-2">&ldquo;{r.hr_reviewernotes}&rdquo;</p>
                    </div>
                  )}
                </div>

                {/* 5. Footer action (HR only — uses the existing update endpoint) */}
                {isHR() && (
                  <div className="px-5 py-3 border-t border-gray-100 flex justify-end">
                    <button onClick={() => setEditReview(r)} aria-label={`Edit performance review for ${name}`}
                      className="inline-flex items-center gap-1.5 text-sm font-medium text-[#EC4899] hover:text-[#D81B60] px-2.5 py-1 rounded-lg hover:bg-pink-50 transition-colors">
                      <PencilSquareIcon className="w-4 h-4" />
                      {r.hr_status === 'completed' ? 'View / Edit' : r.hr_status === 'in-review' ? 'Continue Review' : 'Edit'}
                    </button>
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>

      {showModal && <ReviewModal onClose={() => setShowModal(false)} />}
      {editReview && <ReviewModal review={editReview} onClose={() => setEditReview(null)} />}
    </div>
  );
}
