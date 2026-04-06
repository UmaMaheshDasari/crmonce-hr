import { useState, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { taxDeclarationApi } from '../../api/endpoints';
import { useAuth } from '../../context/AuthContext';
import {
  DocumentTextIcon, PlusIcon, XMarkIcon, PencilSquareIcon,
  EyeIcon, PaperAirplaneIcon, TrashIcon, CheckCircleIcon,
  XCircleIcon, BanknotesIcon, ShieldCheckIcon,
  CalculatorIcon, HomeModernIcon, AcademicCapIcon,
  HeartIcon, GlobeAltIcon, BuildingLibraryIcon,
} from '@heroicons/react/24/outline';
import toast from 'react-hot-toast';

// ── Constants ────────────────────────────────────────────────────
const STATUS_TABS = ['all', 'draft', 'submitted', 'verified', 'rejected'];

const STATUS_COLORS = {
  draft:     { bg: 'bg-gray-100',    text: 'text-gray-700',    border: 'border-l-gray-400',   dot: 'bg-gray-400' },
  submitted: { bg: 'bg-amber-100',   text: 'text-amber-700',   border: 'border-l-amber-400',  dot: 'bg-amber-400' },
  verified:  { bg: 'bg-emerald-100', text: 'text-emerald-700', border: 'border-l-emerald-500', dot: 'bg-emerald-500' },
  rejected:  { bg: 'bg-red-100',     text: 'text-red-700',     border: 'border-l-red-400',    dot: 'bg-red-400' },
};

const REGIME_COLORS = {
  old: { bg: 'bg-violet-100', text: 'text-violet-700' },
  new: { bg: 'bg-sky-100',    text: 'text-sky-700' },
};

const SECTION_CONFIG = [
  { key: 'hr_section80c',   label: 'Section 80C',        sub: 'LIC, PPF, ELSS, Tuition Fees', limit: 150000, icon: ShieldCheckIcon },
  { key: 'hr_section80d',   label: 'Section 80D',        sub: 'Medical Insurance',             limit: 50000,  icon: HeartIcon },
  { key: 'hr_section24b',   label: 'Section 24(b)',      sub: 'Home Loan Interest',            limit: 200000, icon: HomeModernIcon },
  { key: 'hr_hra',          label: 'HRA Exemption',      sub: 'House Rent Allowance',          limit: null,   icon: BuildingLibraryIcon },
  { key: 'hr_lta',          label: 'LTA',                sub: 'Leave Travel Allowance',        limit: null,   icon: GlobeAltIcon },
  { key: 'hr_section80e',   label: 'Section 80E',        sub: 'Education Loan Interest',       limit: null,   icon: AcademicCapIcon },
  { key: 'hr_section80g',   label: 'Section 80G',        sub: 'Donations to Charitable Orgs',  limit: null,   icon: HeartIcon },
  { key: 'hr_section80tta', label: 'Section 80TTA',      sub: 'Savings Account Interest',      limit: 10000,  icon: BanknotesIcon },
  { key: 'hr_nps',          label: 'NPS 80CCD(1B)',      sub: 'National Pension System',       limit: 50000,  icon: ShieldCheckIcon },
];

const fmt = (v) => {
  if (v == null || isNaN(v)) return '0';
  return Number(v).toLocaleString('en-IN');
};

// ── Skeleton loader ──────────────────────────────────────────────
function CardSkeleton() {
  return (
    <div className="bg-white rounded-xl border border-gray-200 p-5 animate-pulse">
      <div className="flex items-center justify-between mb-4">
        <div className="h-5 w-24 bg-gray-200 rounded" />
        <div className="h-5 w-16 bg-gray-200 rounded-full" />
      </div>
      <div className="h-8 w-32 bg-gray-200 rounded mb-3" />
      <div className="space-y-2">
        <div className="h-3 w-full bg-gray-100 rounded" />
        <div className="h-3 w-3/4 bg-gray-100 rounded" />
        <div className="h-3 w-1/2 bg-gray-100 rounded" />
      </div>
    </div>
  );
}

// ── Declaration Card ─────────────────────────────────────────────
function DeclarationCard({ dec, onEdit, onView, onSubmit, onDelete, isHR }) {
  const sc = STATUS_COLORS[dec.hr_status] || STATUS_COLORS.draft;
  const rc = REGIME_COLORS[dec.hr_regime] || REGIME_COLORS.old;
  const isDraft = dec.hr_status === 'draft';

  const sections = SECTION_CONFIG.filter(s => dec[s.key] > 0);

  return (
    <div className={`bg-white rounded-xl border border-gray-200 overflow-hidden shadow-sm hover:shadow-md transition-all duration-200 border-l-4 ${sc.border}`}>
      <div className="p-5">
        {/* Header row */}
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <span className="text-sm font-bold text-gray-900">FY {dec.hr_financialyear}</span>
            <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold uppercase ${rc.bg} ${rc.text}`}>
              {dec.hr_regime === 'new' ? 'New Regime' : 'Old Regime'}
            </span>
          </div>
          <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold ${sc.bg} ${sc.text}`}>
            <span className={`w-1.5 h-1.5 rounded-full ${sc.dot}`} />
            {dec.hr_status}
          </span>
        </div>

        {/* Total */}
        <div className="mb-4">
          <p className="text-[10px] uppercase tracking-wider text-gray-400 font-semibold mb-0.5">Total Deductions</p>
          <p className="text-2xl font-bold text-gray-900">
            <span className="text-base font-medium text-gray-500 mr-0.5">&#8377;</span>
            {fmt(dec.hr_totaldeductions)}
          </p>
        </div>

        {/* Section breakdown */}
        {sections.length > 0 && (
          <div className="space-y-1.5 mb-4">
            {sections.slice(0, 4).map(s => (
              <div key={s.key} className="flex items-center justify-between text-xs">
                <span className="text-gray-500">{s.label}</span>
                <span className="font-medium text-gray-700">&#8377;{fmt(dec[s.key])}</span>
              </div>
            ))}
            {sections.length > 4 && (
              <p className="text-[10px] text-gray-400 italic">+{sections.length - 4} more sections</p>
            )}
          </div>
        )}

        {/* Actions */}
        <div className="flex items-center gap-2 pt-3 border-t border-gray-100">
          <button onClick={() => onView(dec)} className="inline-flex items-center gap-1 text-xs font-medium text-indigo-600 hover:text-indigo-800 transition-colors">
            <EyeIcon className="w-3.5 h-3.5" /> View
          </button>
          {isDraft && !isHR && (
            <>
              <button onClick={() => onEdit(dec)} className="inline-flex items-center gap-1 text-xs font-medium text-gray-600 hover:text-gray-800 transition-colors">
                <PencilSquareIcon className="w-3.5 h-3.5" /> Edit
              </button>
              <button onClick={() => onSubmit(dec)} className="inline-flex items-center gap-1 text-xs font-medium text-amber-600 hover:text-amber-800 transition-colors">
                <PaperAirplaneIcon className="w-3.5 h-3.5" /> Submit
              </button>
              <button onClick={() => onDelete(dec)} className="inline-flex items-center gap-1 text-xs font-medium text-red-500 hover:text-red-700 transition-colors ml-auto">
                <TrashIcon className="w-3.5 h-3.5" />
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Form Modal ───────────────────────────────────────────────────
function DeclarationFormModal({ declaration, onClose, onSaved }) {
  const isEdit = !!declaration;
  const qc = useQueryClient();

  const [form, setForm] = useState({
    hr_financialyear: declaration?.hr_financialyear || '2025-26',
    hr_regime:        declaration?.hr_regime || 'old',
    hr_section80c:    declaration?.hr_section80c || 0,
    hr_section80d:    declaration?.hr_section80d || 0,
    hr_section80g:    declaration?.hr_section80g || 0,
    hr_hra:           declaration?.hr_hra || 0,
    hr_lta:           declaration?.hr_lta || 0,
    hr_section24b:    declaration?.hr_section24b || 0,
    hr_section80e:    declaration?.hr_section80e || 0,
    hr_section80tta:  declaration?.hr_section80tta || 0,
    hr_nps:           declaration?.hr_nps || 0,
    hr_othersection:  declaration?.hr_othersection || '',
    hr_otheramount:   declaration?.hr_otheramount || 0,
    hr_remarks:       declaration?.hr_remarks || '',
  });

  const total = useMemo(() => {
    return (Number(form.hr_section80c) || 0) + (Number(form.hr_section80d) || 0)
      + (Number(form.hr_section80g) || 0) + (Number(form.hr_hra) || 0)
      + (Number(form.hr_lta) || 0) + (Number(form.hr_section24b) || 0)
      + (Number(form.hr_section80e) || 0) + (Number(form.hr_section80tta) || 0)
      + (Number(form.hr_nps) || 0) + (Number(form.hr_otheramount) || 0);
  }, [form]);

  const createMut = useMutation({
    mutationFn: (data) => taxDeclarationApi.create(data),
    onSuccess: () => { toast.success('Declaration saved as draft'); qc.invalidateQueries(['tax-declarations']); onClose(); },
    onError: () => toast.error('Failed to save declaration'),
  });

  const updateMut = useMutation({
    mutationFn: (data) => taxDeclarationApi.update(declaration.hr_hrtaxdeclarationid, data),
    onSuccess: () => { toast.success('Declaration updated'); qc.invalidateQueries(['tax-declarations']); onClose(); },
    onError: () => toast.error('Failed to update declaration'),
  });

  const handleSave = (asSubmitted = false) => {
    const payload = {
      ...form,
      hr_section80c:   Number(form.hr_section80c) || 0,
      hr_section80d:   Number(form.hr_section80d) || 0,
      hr_section80g:   Number(form.hr_section80g) || 0,
      hr_hra:          Number(form.hr_hra) || 0,
      hr_lta:          Number(form.hr_lta) || 0,
      hr_section24b:   Number(form.hr_section24b) || 0,
      hr_section80e:   Number(form.hr_section80e) || 0,
      hr_section80tta: Number(form.hr_section80tta) || 0,
      hr_nps:          Number(form.hr_nps) || 0,
      hr_otheramount:  Number(form.hr_otheramount) || 0,
      hr_status: asSubmitted ? 'submitted' : 'draft',
    };
    if (isEdit) updateMut.mutate(payload);
    else createMut.mutate(payload);
  };

  const setField = (key, value) => setForm(prev => ({ ...prev, [key]: value }));
  const isLoading = createMut.isLoading || updateMut.isLoading;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 backdrop-blur-sm p-4 overflow-y-auto">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl my-8 overflow-hidden">
        {/* Header */}
        <div className="px-6 py-5 border-b border-gray-100 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-indigo-100 rounded-xl flex items-center justify-center">
              <CalculatorIcon className="w-5 h-5 text-indigo-600" />
            </div>
            <div>
              <h2 className="text-lg font-bold text-gray-900">{isEdit ? 'Edit' : 'New'} Tax Declaration</h2>
              <p className="text-xs text-gray-500 mt-0.5">Income tax investment declaration</p>
            </div>
          </div>
          <button onClick={onClose} className="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-gray-100 text-gray-400 hover:text-gray-600 transition-colors">
            <XMarkIcon className="w-5 h-5" />
          </button>
        </div>

        <div className="p-6 space-y-6 max-h-[70vh] overflow-y-auto">
          {/* Financial Year + Regime */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-semibold text-gray-700 mb-1.5">Financial Year</label>
              <input
                type="text" placeholder="e.g. 2025-26"
                className="w-full px-3 py-2.5 bg-gray-50 border border-gray-200 rounded-xl text-sm text-gray-700 focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-400 outline-none transition-all"
                value={form.hr_financialyear}
                onChange={e => setField('hr_financialyear', e.target.value)}
              />
            </div>
            <div>
              <label className="block text-sm font-semibold text-gray-700 mb-1.5">Tax Regime</label>
              <div className="grid grid-cols-2 gap-2">
                {[{ value: 'old', label: 'Old Regime' }, { value: 'new', label: 'New Regime' }].map(opt => (
                  <button
                    key={opt.value}
                    type="button"
                    onClick={() => setField('hr_regime', opt.value)}
                    className={`px-3 py-2.5 rounded-xl text-sm font-medium border-2 transition-all ${
                      form.hr_regime === opt.value
                        ? 'border-indigo-500 bg-indigo-50 text-indigo-700'
                        : 'border-gray-200 bg-gray-50 text-gray-500 hover:border-gray-300'
                    }`}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* Section-wise inputs */}
          <div>
            <h3 className="text-sm font-bold text-gray-800 mb-3">Deduction Sections</h3>
            <div className="space-y-3">
              {SECTION_CONFIG.map(sec => {
                const Icon = sec.icon;
                return (
                  <div key={sec.key} className="flex items-start gap-3 p-3 bg-gray-50 rounded-xl border border-gray-100">
                    <div className="w-8 h-8 rounded-lg bg-white border border-gray-200 flex items-center justify-center flex-shrink-0 mt-0.5">
                      <Icon className="w-4 h-4 text-gray-500" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center justify-between mb-0.5">
                        <label className="text-sm font-semibold text-gray-700">{sec.label}</label>
                        {sec.limit && (
                          <span className="text-[10px] text-gray-400 font-medium">Max: &#8377;{fmt(sec.limit)}</span>
                        )}
                      </div>
                      <p className="text-[11px] text-gray-400 mb-1.5">{sec.sub}</p>
                      <div className="relative">
                        <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 text-sm">&#8377;</span>
                        <input
                          type="number" min="0" max={sec.limit || undefined}
                          className="w-full pl-7 pr-3 py-2 bg-white border border-gray-200 rounded-lg text-sm text-gray-700 focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-400 outline-none transition-all"
                          value={form[sec.key] || ''}
                          onChange={e => setField(sec.key, e.target.value)}
                          placeholder="0"
                        />
                      </div>
                    </div>
                  </div>
                );
              })}

              {/* Other section */}
              <div className="p-3 bg-gray-50 rounded-xl border border-gray-100">
                <label className="text-sm font-semibold text-gray-700 block mb-1.5">Other Section</label>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  <input
                    type="text" placeholder="Section name"
                    className="w-full px-3 py-2 bg-white border border-gray-200 rounded-lg text-sm text-gray-700 focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-400 outline-none transition-all"
                    value={form.hr_othersection}
                    onChange={e => setField('hr_othersection', e.target.value)}
                  />
                  <div className="relative">
                    <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 text-sm">&#8377;</span>
                    <input
                      type="number" min="0" placeholder="0"
                      className="w-full pl-7 pr-3 py-2 bg-white border border-gray-200 rounded-lg text-sm text-gray-700 focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-400 outline-none transition-all"
                      value={form.hr_otheramount || ''}
                      onChange={e => setField('hr_otheramount', e.target.value)}
                    />
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* Total */}
          <div className="bg-gradient-to-r from-indigo-50 to-violet-50 border border-indigo-100 rounded-2xl p-4 flex items-center justify-between">
            <div>
              <p className="text-xs font-semibold text-indigo-600 uppercase tracking-wider">Total Deductions</p>
              <p className="text-2xl font-bold text-indigo-900 mt-0.5">
                <span className="text-lg font-medium text-indigo-500 mr-0.5">&#8377;</span>
                {fmt(total)}
              </p>
            </div>
            <CalculatorIcon className="w-10 h-10 text-indigo-300" />
          </div>

          {/* Remarks */}
          <div>
            <label className="block text-sm font-semibold text-gray-700 mb-1.5">Remarks</label>
            <textarea
              rows={3} placeholder="Any additional notes..."
              className="w-full px-3 py-2.5 bg-gray-50 border border-gray-200 rounded-xl text-sm text-gray-700 focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-400 outline-none transition-all resize-none"
              value={form.hr_remarks}
              onChange={e => setField('hr_remarks', e.target.value)}
            />
          </div>
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-gray-100 bg-gray-50/50 flex gap-3">
          <button onClick={onClose} className="flex-1 px-4 py-2.5 text-sm font-semibold text-gray-700 bg-white border border-gray-200 rounded-xl hover:bg-gray-50 transition-colors">
            Cancel
          </button>
          <button
            onClick={() => handleSave(false)}
            disabled={isLoading}
            className="flex-1 px-4 py-2.5 text-sm font-semibold text-gray-700 bg-white border border-gray-200 rounded-xl hover:bg-gray-50 transition-colors disabled:opacity-50"
          >
            {isLoading ? 'Saving...' : 'Save as Draft'}
          </button>
          <button
            onClick={() => handleSave(true)}
            disabled={isLoading}
            className="flex-1 px-4 py-2.5 text-sm font-semibold text-white bg-gradient-to-r from-indigo-600 to-indigo-700 rounded-xl hover:from-indigo-700 hover:to-indigo-800 shadow-sm shadow-indigo-200 transition-all disabled:opacity-50"
          >
            {isLoading ? 'Submitting...' : 'Submit'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── View Details Modal ───────────────────────────────────────────
function ViewDetailsModal({ declaration, onClose, isHR }) {
  const qc = useQueryClient();
  const sc = STATUS_COLORS[declaration.hr_status] || STATUS_COLORS.draft;

  const verifyMut = useMutation({
    mutationFn: () => taxDeclarationApi.update(declaration.hr_hrtaxdeclarationid, { hr_status: 'verified' }),
    onSuccess: () => { toast.success('Declaration verified'); qc.invalidateQueries(['tax-declarations']); onClose(); },
    onError: () => toast.error('Failed to verify'),
  });

  const rejectMut = useMutation({
    mutationFn: () => taxDeclarationApi.update(declaration.hr_hrtaxdeclarationid, { hr_status: 'rejected' }),
    onSuccess: () => { toast.success('Declaration rejected'); qc.invalidateQueries(['tax-declarations']); onClose(); },
    onError: () => toast.error('Failed to reject'),
  });

  const canVerify = isHR && declaration.hr_status === 'submitted';

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 backdrop-blur-sm p-4 overflow-y-auto">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg my-8 overflow-hidden">
        {/* Header */}
        <div className="px-6 py-5 border-b border-gray-100 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-indigo-100 rounded-xl flex items-center justify-center">
              <DocumentTextIcon className="w-5 h-5 text-indigo-600" />
            </div>
            <div>
              <h2 className="text-lg font-bold text-gray-900">FY {declaration.hr_financialyear}</h2>
              <div className="flex items-center gap-2 mt-0.5">
                <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold ${sc.bg} ${sc.text}`}>
                  <span className={`w-1.5 h-1.5 rounded-full ${sc.dot}`} />
                  {declaration.hr_status}
                </span>
                <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold ${REGIME_COLORS[declaration.hr_regime]?.bg} ${REGIME_COLORS[declaration.hr_regime]?.text}`}>
                  {declaration.hr_regime === 'new' ? 'New Regime' : 'Old Regime'}
                </span>
              </div>
            </div>
          </div>
          <button onClick={onClose} className="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-gray-100 text-gray-400 hover:text-gray-600 transition-colors">
            <XMarkIcon className="w-5 h-5" />
          </button>
        </div>

        <div className="p-6 space-y-4 max-h-[60vh] overflow-y-auto">
          {/* Total */}
          <div className="bg-gradient-to-r from-indigo-50 to-violet-50 border border-indigo-100 rounded-2xl p-4 text-center">
            <p className="text-xs font-semibold text-indigo-600 uppercase tracking-wider">Total Deductions</p>
            <p className="text-3xl font-bold text-indigo-900 mt-1">
              <span className="text-xl font-medium text-indigo-500 mr-0.5">&#8377;</span>
              {fmt(declaration.hr_totaldeductions)}
            </p>
          </div>

          {/* Section breakdown */}
          <div className="space-y-2">
            {SECTION_CONFIG.map(sec => {
              const val = declaration[sec.key];
              if (!val && val !== 0) return null;
              const Icon = sec.icon;
              return (
                <div key={sec.key} className="flex items-center justify-between py-2.5 px-3 rounded-lg bg-gray-50">
                  <div className="flex items-center gap-2.5">
                    <Icon className="w-4 h-4 text-gray-400" />
                    <div>
                      <p className="text-sm font-medium text-gray-700">{sec.label}</p>
                      <p className="text-[10px] text-gray-400">{sec.sub}</p>
                    </div>
                  </div>
                  <span className="text-sm font-semibold text-gray-900">&#8377;{fmt(val)}</span>
                </div>
              );
            })}

            {declaration.hr_othersection && (
              <div className="flex items-center justify-between py-2.5 px-3 rounded-lg bg-gray-50">
                <div>
                  <p className="text-sm font-medium text-gray-700">{declaration.hr_othersection}</p>
                  <p className="text-[10px] text-gray-400">Other Section</p>
                </div>
                <span className="text-sm font-semibold text-gray-900">&#8377;{fmt(declaration.hr_otheramount)}</span>
              </div>
            )}
          </div>

          {/* Remarks */}
          {declaration.hr_remarks && (
            <div className="bg-gray-50 rounded-xl p-3">
              <p className="text-xs font-semibold text-gray-500 mb-1">Remarks</p>
              <p className="text-sm text-gray-700">{declaration.hr_remarks}</p>
            </div>
          )}
        </div>

        {/* Footer — HR actions */}
        <div className="px-6 py-4 border-t border-gray-100 bg-gray-50/50 flex gap-3">
          <button onClick={onClose} className="flex-1 px-4 py-2.5 text-sm font-semibold text-gray-700 bg-white border border-gray-200 rounded-xl hover:bg-gray-50 transition-colors">
            Close
          </button>
          {canVerify && (
            <>
              <button
                onClick={() => rejectMut.mutate()}
                disabled={rejectMut.isLoading || verifyMut.isLoading}
                className="flex-1 inline-flex items-center justify-center gap-1.5 px-4 py-2.5 text-sm font-semibold text-red-700 bg-red-50 border border-red-200 rounded-xl hover:bg-red-100 transition-colors disabled:opacity-50"
              >
                <XCircleIcon className="w-4 h-4" /> Reject
              </button>
              <button
                onClick={() => verifyMut.mutate()}
                disabled={verifyMut.isLoading || rejectMut.isLoading}
                className="flex-1 inline-flex items-center justify-center gap-1.5 px-4 py-2.5 text-sm font-semibold text-white bg-gradient-to-r from-emerald-500 to-emerald-600 rounded-xl hover:from-emerald-600 hover:to-emerald-700 shadow-sm transition-all disabled:opacity-50"
              >
                <CheckCircleIcon className="w-4 h-4" /> Verify
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Main Page ────────────────────────────────────────────────────
export default function TaxDeclarationPage() {
  const { user, hasRole } = useAuth();
  const qc = useQueryClient();
  const isHRUser = hasRole('super_admin', 'hr_manager');

  const [statusFilter, setStatusFilter] = useState('all');
  const [yearFilter, setYearFilter] = useState('');
  const [showForm, setShowForm] = useState(false);
  const [editDeclaration, setEditDeclaration] = useState(null);
  const [viewDeclaration, setViewDeclaration] = useState(null);

  const queryParams = useMemo(() => {
    const p = {};
    if (statusFilter !== 'all') p.status = statusFilter;
    if (yearFilter) p.year = yearFilter;
    return p;
  }, [statusFilter, yearFilter]);

  const { data, isLoading } = useQuery({
    queryKey: ['tax-declarations', queryParams],
    queryFn: () => taxDeclarationApi.list(queryParams).then(r => r.data),
  });

  const declarations = data?.data || [];
  const totalCount = data?.count || 0;

  const deleteMut = useMutation({
    mutationFn: (id) => taxDeclarationApi.delete(id),
    onSuccess: () => { toast.success('Declaration deleted'); qc.invalidateQueries(['tax-declarations']); },
    onError: () => toast.error('Failed to delete'),
  });

  const submitMut = useMutation({
    mutationFn: (dec) => taxDeclarationApi.update(dec.hr_hrtaxdeclarationid, { hr_status: 'submitted' }),
    onSuccess: () => { toast.success('Declaration submitted for verification'); qc.invalidateQueries(['tax-declarations']); },
    onError: () => toast.error('Failed to submit'),
  });

  const handleDelete = (dec) => {
    if (window.confirm('Delete this draft declaration?')) {
      deleteMut.mutate(dec.hr_hrtaxdeclarationid);
    }
  };

  const handleSubmit = (dec) => {
    if (window.confirm('Submit this declaration for verification? You will not be able to edit it after submission.')) {
      submitMut.mutate(dec);
    }
  };

  // Generate year options
  const currentYear = new Date().getFullYear();
  const yearOptions = [];
  for (let y = currentYear + 1; y >= currentYear - 3; y--) {
    yearOptions.push(`${y - 1}-${String(y).slice(-2)}`);
  }

  return (
    <div className="space-y-6">
      {/* Page Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-gradient-to-br from-indigo-500 to-indigo-700 rounded-xl flex items-center justify-center shadow-lg shadow-indigo-500/20">
              <DocumentTextIcon className="w-5 h-5 text-white" />
            </div>
            <div>
              <h1 className="text-2xl font-bold text-gray-900 tracking-tight">Income Tax Declarations</h1>
              <p className="text-sm text-gray-500 mt-0.5">
                {totalCount} declaration{totalCount !== 1 ? 's' : ''}
              </p>
            </div>
          </div>
        </div>
        <button
          onClick={() => { setEditDeclaration(null); setShowForm(true); }}
          className="inline-flex items-center gap-2 px-5 py-2.5 bg-gradient-to-r from-indigo-600 to-indigo-700 text-white text-sm font-semibold rounded-xl hover:from-indigo-700 hover:to-indigo-800 shadow-sm shadow-indigo-200 transition-all"
        >
          <PlusIcon className="w-4 h-4" />
          New Declaration
        </button>
      </div>

      {/* Filters */}
      <div className="flex flex-col sm:flex-row sm:items-center gap-4">
        {/* Year filter */}
        <select
          className="px-3 py-2 bg-white border border-gray-200 rounded-xl text-sm text-gray-700 focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-400 outline-none transition-all appearance-none w-full sm:w-44"
          value={yearFilter}
          onChange={e => setYearFilter(e.target.value)}
        >
          <option value="">All Years</option>
          {yearOptions.map(y => <option key={y} value={y}>FY {y}</option>)}
        </select>

        {/* Status tabs */}
        <div className="flex items-center gap-1 bg-gray-100 rounded-xl p-1 overflow-x-auto">
          {STATUS_TABS.map(tab => (
            <button
              key={tab}
              onClick={() => setStatusFilter(tab)}
              className={`px-3 py-1.5 rounded-lg text-xs font-semibold capitalize whitespace-nowrap transition-all ${
                statusFilter === tab
                  ? 'bg-white text-gray-900 shadow-sm'
                  : 'text-gray-500 hover:text-gray-700'
              }`}
            >
              {tab}
            </button>
          ))}
        </div>
      </div>

      {/* Content */}
      {isLoading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {[1, 2, 3].map(i => <CardSkeleton key={i} />)}
        </div>
      ) : declarations.length === 0 ? (
        <div className="text-center py-16">
          <DocumentTextIcon className="w-12 h-12 text-gray-300 mx-auto mb-3" />
          <p className="text-gray-500 font-medium">No declarations found</p>
          <p className="text-gray-400 text-sm mt-1">Create a new tax declaration to get started</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {declarations.map(dec => (
            <DeclarationCard
              key={dec.hr_hrtaxdeclarationid}
              dec={dec}
              isHR={isHRUser}
              onView={setViewDeclaration}
              onEdit={(d) => { setEditDeclaration(d); setShowForm(true); }}
              onSubmit={handleSubmit}
              onDelete={handleDelete}
            />
          ))}
        </div>
      )}

      {/* Modals */}
      {showForm && (
        <DeclarationFormModal
          declaration={editDeclaration}
          onClose={() => { setShowForm(false); setEditDeclaration(null); }}
        />
      )}

      {viewDeclaration && (
        <ViewDetailsModal
          declaration={viewDeclaration}
          onClose={() => setViewDeclaration(null)}
          isHR={isHRUser}
        />
      )}
    </div>
  );
}
