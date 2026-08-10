import { useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { salaryStructureApi, employeeApi } from '../../api/endpoints';
import {
  BanknotesIcon, PlusIcon, XMarkIcon, PencilSquareIcon, TrashIcon,
  ClockIcon, CheckBadgeIcon, ArrowTrendingUpIcon, UserCircleIcon,
} from '@heroicons/react/24/outline';
import { useAuth } from '../../context/AuthContext';
import { fmtDate } from '../../utils/format';
import { calculateProfessionalTax } from '../../utils/professionalTax';
import SearchSelect from '../../components/SearchSelect';
import Modal, { ModalBody, ModalFooter } from '../../components/Modal';
import EmployeeAvatar from '../../components/Avatar';
import toast from 'react-hot-toast';

const inr = (n) => '₹' + (Number(n) || 0).toLocaleString('en-IN');
const EARNINGS = [
  ['basic', 'Basic Salary', true], ['hra', 'House Rent Allowance (HRA)'], ['special', 'Special Allowance'],
  ['medical', 'Medical Allowance'], ['conveyance', 'Conveyance Allowance'], ['otherAllowance', 'Other Allowance'],
];
// Professional Tax is auto-calculated (slab) and read-only — NOT in this list.
const DEDUCTIONS = [
  ['incomeTax', 'Income Tax (TDS)'], ['otherDeductions', 'Other Deductions'],
];
const STATUS_BADGE = {
  active: 'bg-emerald-50 text-emerald-700 ring-emerald-600/20',
  superseded: 'bg-gray-100 text-gray-500 ring-gray-500/10',
  draft: 'bg-amber-50 text-amber-700 ring-amber-600/20',
};

// ── Avatar — delegates to the shared component (resolver + broken-image → initials) ──
function Avatar({ name, photo, size = 'md' }) {
  const box = size === 'sm' ? 'w-9 h-9' : 'w-11 h-11';
  const txt = size === 'sm' ? 'text-xs' : 'text-sm';
  return <EmployeeAvatar name={name} photo={photo} className={`${box} rounded-full bg-indigo-100 ring-2 ring-white shadow`} initialsClassName={`${txt} text-indigo-700 font-bold`} />;
}

// ── Create / Edit modal ──
function SalaryFormModal({ record, employees, onClose }) {
  const qc = useQueryClient();
  const isEdit = !!record;
  const { register, handleSubmit, watch, setValue, formState: { errors } } = useForm({
    defaultValues: {
      employeeId: record?.employeeId || '',
      effectiveFrom: record?.effectiveFrom || new Date().toISOString().slice(0, 10),
      basic: record?.basic ?? '', hra: record?.hra ?? 0, special: record?.special ?? 0,
      medical: record?.medical ?? 0, conveyance: record?.conveyance ?? 0, otherAllowance: record?.otherAllowance ?? 0,
      pfApplicable: record ? record.pfApplicable : true, pfAmount: record?.pfAmount ?? 0,
      incomeTax: record?.incomeTax ?? 0, otherDeductions: record?.otherDeductions ?? 0,
      status: record?.status === 'draft' ? 'draft' : 'active', remarks: record?.remarks || '',
    },
  });

  const w = watch();
  const n = (v) => Number(v) || 0;
  const gross = EARNINGS.reduce((s, [k]) => s + n(w[k]), 0);
  const pfApplicable = !!w.pfApplicable;
  // Professional Tax is auto-derived from the slab — read-only, recalculated live.
  const professionalTax = calculateProfessionalTax(gross);
  const totalDeductions = (pfApplicable ? n(w.pfAmount) : 0) + professionalTax + n(w.incomeTax) + n(w.otherDeductions);
  const net = gross - totalDeductions;

  const mutation = useMutation({
    mutationFn: (values) => isEdit ? salaryStructureApi.update(record.id, values) : salaryStructureApi.create(values),
    onSuccess: () => {
      toast.success(isEdit ? 'Salary structure updated' : 'New salary revision created');
      qc.invalidateQueries({ queryKey: ['salary-structures'] });
      qc.invalidateQueries({ queryKey: ['salary-history'] });
      onClose();
    },
    onError: (err) => toast.error(err.response?.data?.error || 'Failed to save salary structure'),
  });

  // pfApplicable is driven by the toggle (setValue), so read it from the form
  // state at submit time — never rely on it being a registered <input>.
  const onSubmit = (values) => mutation.mutate({ ...values, pfApplicable: !!watch('pfApplicable'), professionalTax });

  // Inline render fn (NOT a nested component) so uncontrolled inputs keep focus
  // across re-renders triggered by watch().
  const field = (name, label, required, disabled) => (
    <div key={name} className="space-y-1">
      <label className="block text-xs font-semibold text-gray-600">{label}{required && <span className="text-red-500 ml-0.5">*</span>}</label>
      <div className="relative">
        <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-gray-400 pointer-events-none">₹</span>
        <input type="number" min="0" step="1" disabled={disabled}
          className={`w-full h-10 pl-7 pr-3 bg-gray-50 border ${errors[name] ? 'border-red-300 ring-2 ring-red-100' : 'border-gray-200'} rounded-lg text-sm text-right focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-400 focus:bg-white transition-all disabled:opacity-50 disabled:bg-gray-100`}
          {...register(name, required ? { required: true, min: { value: 1, message: 'Required' } } : {})} />
      </div>
    </div>
  );

  return (
    <Modal
      title={isEdit ? 'Edit Salary Structure' : 'New Salary Structure'}
      subtitle={isEdit ? `${record.employeeName} · revision effective ${fmtDate(record.effectiveFrom)}` : 'Creates a new version — previous salary history is preserved.'}
      onClose={onClose} size="lg">
      <form onSubmit={handleSubmit(onSubmit)} className="flex flex-col min-h-0 flex-1">
        <ModalBody className="space-y-6">
          {/* Employee + effective date */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="space-y-1">
              <label className="block text-xs font-semibold text-gray-600">Employee<span className="text-red-500 ml-0.5">*</span></label>
              {isEdit ? (
                <div className="h-10 px-3 flex items-center bg-gray-100 border border-gray-200 rounded-lg text-sm text-gray-700">{record.employeeName || '—'}</div>
              ) : (
                <>
                  <SearchSelect
                    value={w.employeeId}
                    onChange={(v) => setValue('employeeId', v, { shouldDirty: true, shouldValidate: true })}
                    options={employees.map(e => ({ value: e.hr_hremployeeid, label: `${e.hr_hremployee1}${e.hr_employeeid ? ` (${e.hr_employeeid})` : ''}` }))}
                    placeholder="Select employee…" error={!!errors.employeeId} />
                  <input type="hidden" {...register('employeeId', { required: true })} />
                </>
              )}
            </div>
            <div className="space-y-1">
              <label className="block text-xs font-semibold text-gray-600">Effective From<span className="text-red-500 ml-0.5">*</span></label>
              <input type="date" className={`w-full h-10 px-3 bg-gray-50 border ${errors.effectiveFrom ? 'border-red-300' : 'border-gray-200'} rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-400`}
                {...register('effectiveFrom', { required: true })} />
            </div>
          </div>

          {/* Earnings */}
          <div>
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-xs font-bold uppercase tracking-wider text-gray-400">Earnings</h3>
              <div className="text-sm"><span className="text-gray-400">Gross</span> <span className="font-bold text-indigo-600">{inr(gross)}</span></div>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              {EARNINGS.map(([k, label, req]) => field(k, label, req))}
            </div>
          </div>

          {/* Deductions */}
          <div>
            <h3 className="text-xs font-bold uppercase tracking-wider text-gray-400 mb-3">Deductions</h3>
            <div className="flex items-center gap-3 mb-3 p-3 bg-gray-50 rounded-lg">
              <button type="button" onClick={() => setValue('pfApplicable', !pfApplicable, { shouldDirty: true })}
                className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${pfApplicable ? 'bg-indigo-600' : 'bg-gray-300'}`}>
                <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${pfApplicable ? 'translate-x-6' : 'translate-x-1'}`} />
              </button>
              <span className="text-sm font-medium text-gray-700">PF Applicable</span>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              {field('pfAmount', 'PF Amount', false, !pfApplicable)}
              {/* Professional Tax — auto-calculated from the slab, read-only */}
              <div className="space-y-1">
                <label className="block text-xs font-semibold text-gray-600">Professional Tax <span className="text-[10px] font-medium text-indigo-500">(auto)</span></label>
                <div className="relative">
                  <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-gray-400 pointer-events-none">₹</span>
                  <input type="text" readOnly tabIndex={-1} value={professionalTax.toLocaleString('en-IN')} title="Auto-calculated from Gross Salary (slab)"
                    className="w-full h-10 pl-7 pr-3 bg-gray-100 border border-gray-200 rounded-lg text-sm text-right text-gray-700 cursor-not-allowed" />
                </div>
              </div>
              {DEDUCTIONS.map(([k, label]) => field(k, label))}
            </div>
            <p className="text-[11px] text-gray-400 mt-1.5">Professional Tax is set automatically: ₹0 up to ₹15,000 · ₹150 for ₹15,001–₹20,000 · ₹200 above ₹20,000.</p>
          </div>

          {/* Live totals */}
          <div className="grid grid-cols-3 gap-3">
            <div className="bg-gray-50 rounded-xl p-3 text-center"><p className="text-[11px] uppercase tracking-wide text-gray-400">Gross</p><p className="text-lg font-bold text-gray-900">{inr(gross)}</p></div>
            <div className="bg-gray-50 rounded-xl p-3 text-center"><p className="text-[11px] uppercase tracking-wide text-gray-400">Deductions</p><p className="text-lg font-bold text-red-600">−{inr(totalDeductions)}</p></div>
            <div className="bg-indigo-50 rounded-xl p-3 text-center"><p className="text-[11px] uppercase tracking-wide text-indigo-400">Net Salary</p><p className="text-lg font-bold text-indigo-700">{inr(net)}</p></div>
          </div>

          {/* Status + remarks */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="space-y-1">
              <label className="block text-xs font-semibold text-gray-600">Status</label>
              <SearchSelect
                value={w.status}
                onChange={(v) => setValue('status', v, { shouldDirty: true })}
                options={[{ value: 'active', label: 'Active' }, { value: 'draft', label: 'Draft' }]}
                searchable={false} />
              <input type="hidden" {...register('status')} />
            </div>
            <div className="space-y-1">
              <label className="block text-xs font-semibold text-gray-600">Remarks</label>
              <input className="w-full h-10 px-3 bg-gray-50 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-400" placeholder="e.g. Annual revision, promotion…" {...register('remarks')} />
            </div>
          </div>

        </ModalBody>
        <ModalFooter>
          <button type="button" onClick={onClose} className="px-4 py-2 text-sm font-medium text-gray-600 hover:text-gray-800">Cancel</button>
          <button type="submit" disabled={mutation.isPending}
            className="px-5 py-2.5 bg-gradient-to-r from-indigo-600 to-indigo-700 text-white text-sm font-medium rounded-xl hover:from-indigo-700 hover:to-indigo-800 disabled:opacity-50 shadow-lg shadow-indigo-500/25">
            {mutation.isPending ? 'Saving…' : isEdit ? 'Save Changes' : 'Create Revision'}
          </button>
        </ModalFooter>
      </form>
    </Modal>
  );
}

// ── Salary History timeline ──
function HistoryModal({ employeeId, employeeName, onClose }) {
  const { data, isLoading } = useQuery({ queryKey: ['salary-history', employeeId], queryFn: () => salaryStructureApi.history(employeeId) });
  const rows = data?.data?.data || [];
  return (
    <Modal title="Salary History" subtitle={employeeName} onClose={onClose} size="md">
      <ModalBody>
          {isLoading ? <p className="text-center text-gray-400 py-8">Loading…</p> : rows.length === 0 ? (
            <p className="text-center text-gray-400 py-8">No salary history yet.</p>
          ) : (
            <ol className="relative border-l-2 border-gray-100 ml-3 space-y-6">
              {rows.map((r) => (
                <li key={r.id} className="ml-6">
                  <span className={`absolute -left-[9px] w-4 h-4 rounded-full ring-4 ring-white ${r.status === 'active' ? 'bg-emerald-500' : 'bg-gray-300'}`} />
                  <div className="bg-gray-50 rounded-xl p-4">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-bold text-gray-900">Effective {fmtDate(r.effectiveFrom)}</span>
                        <span className={`px-2 py-0.5 rounded-full text-[10px] font-semibold uppercase ring-1 ${STATUS_BADGE[r.status] || STATUS_BADGE.superseded}`}>{r.status}</span>
                      </div>
                      <span className="text-sm font-bold text-indigo-600">{inr(r.gross)}</span>
                    </div>
                    <div className="grid grid-cols-3 gap-2 mt-3 text-xs">
                      <div><p className="text-gray-400">Gross</p><p className="font-semibold text-gray-800">{inr(r.gross)}</p></div>
                      <div><p className="text-gray-400">Deductions</p><p className="font-semibold text-red-600">−{inr(r.totalDeductions)}</p></div>
                      <div><p className="text-gray-400">Net</p><p className="font-semibold text-emerald-600">{inr(r.netSalary)}</p></div>
                    </div>
                    {r.remarks && <p className="text-xs text-gray-500 mt-2 italic">{r.remarks}</p>}
                  </div>
                </li>
              ))}
            </ol>
          )}
      </ModalBody>
    </Modal>
  );
}

// ── Salary card ──
function SalaryCard({ record, canEdit, canDelete, onEdit, onDelete, onHistory }) {
  const e = record._employee || {};
  return (
    <div className="bg-white rounded-2xl border border-gray-100 shadow-sm hover:shadow-md transition-shadow overflow-hidden">
      <div className="p-5">
        <div className="flex items-start justify-between">
          <div className="flex items-center gap-3 min-w-0">
            <Avatar name={e.name || record.employeeName} photo={e.photo} />
            <div className="min-w-0">
              <p className="font-semibold text-gray-900 truncate">{e.name || record.employeeName || '—'}</p>
              <p className="text-xs text-gray-400 truncate">
                {e.employeeId && <span className="font-medium text-gray-500">{e.employeeId}</span>}
                {e.designation && <span> · {e.designation}</span>}
                {e.department && <span> · {e.department}</span>}
              </p>
            </div>
          </div>
          <span className={`px-2 py-0.5 rounded-full text-[10px] font-semibold uppercase ring-1 shrink-0 ${STATUS_BADGE[record.status] || STATUS_BADGE.superseded}`}>{record.status}</span>
        </div>

        <div className="mt-4 flex items-end justify-between">
          <div>
            <p className="text-[11px] uppercase tracking-wide text-gray-400">Net Salary / month</p>
            <p className="text-2xl font-bold text-gray-900">{inr(record.netSalary)}</p>
          </div>
          <div className="text-right text-xs text-gray-400">
            <p>Effective</p><p className="font-medium text-gray-600">{fmtDate(record.effectiveFrom)}</p>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-2 mt-4 text-xs">
          <div className="bg-gray-50 rounded-lg px-3 py-2"><p className="text-gray-400">Gross</p><p className="font-semibold text-gray-800">{inr(record.gross)}</p></div>
          <div className="bg-gray-50 rounded-lg px-3 py-2"><p className="text-gray-400">Deductions</p><p className="font-semibold text-red-600">−{inr(record.totalDeductions)}</p></div>
        </div>
      </div>

      <div className="flex items-center border-t border-gray-50 divide-x divide-gray-50">
        <button onClick={() => onHistory(record)} className="flex-1 py-2.5 text-xs font-medium text-gray-500 hover:text-indigo-600 hover:bg-indigo-50/40 flex items-center justify-center gap-1.5"><ClockIcon className="w-4 h-4" /> History</button>
        {canEdit && <button onClick={() => onEdit(record)} className="flex-1 py-2.5 text-xs font-medium text-gray-500 hover:text-indigo-600 hover:bg-indigo-50/40 flex items-center justify-center gap-1.5"><PencilSquareIcon className="w-4 h-4" /> Edit</button>}
        {canDelete && <button onClick={() => onDelete(record)} className="flex-1 py-2.5 text-xs font-medium text-gray-500 hover:text-red-600 hover:bg-red-50/40 flex items-center justify-center gap-1.5"><TrashIcon className="w-4 h-4" /> Delete</button>}
      </div>
    </div>
  );
}

export default function SalaryStructurePage() {
  const { user } = useAuth();
  const qc = useQueryClient();
  const isHR = ['super_admin', 'hr_manager'].includes(user?.role);
  const isSuperAdmin = user?.role === 'super_admin';

  const [showForm, setShowForm] = useState(false);
  const [editRecord, setEditRecord] = useState(null);
  const [historyFor, setHistoryFor] = useState(null);
  const [empFilter, setEmpFilter] = useState('');

  const { data, isLoading } = useQuery({ queryKey: ['salary-structures'], queryFn: () => salaryStructureApi.list() });
  const allRows = data?.data?.data || [];

  const { data: empRes } = useQuery({ queryKey: ['employees-lite'], queryFn: () => employeeApi.list({ limit: 500 }), enabled: isHR });
  const employees = empRes?.data?.data || empRes?.data || [];

  // Main grid = the active revision per employee.
  const active = useMemo(() => {
    let rows = allRows.filter(r => r.status === 'active');
    if (empFilter) rows = rows.filter(r => r.employeeId === empFilter);
    return rows;
  }, [allRows, empFilter]);

  const summary = useMemo(() => ({
    count: active.length,
    gross: active.reduce((s, r) => s + r.gross, 0),
    net: active.reduce((s, r) => s + r.netSalary, 0),
  }), [active]);

  const deleteMutation = useMutation({
    mutationFn: (id) => salaryStructureApi.delete(id),
    onSuccess: () => { toast.success('Salary revision deleted'); qc.invalidateQueries({ queryKey: ['salary-structures'] }); },
    onError: (err) => toast.error(err.response?.data?.error || 'Failed to delete'),
  });
  const handleDelete = (r) => { if (window.confirm(`Delete the salary revision for ${r.employeeName} effective ${r.effectiveFrom}? History for other revisions is kept.`)) deleteMutation.mutate(r.id); };

  const openCreate = () => { setEditRecord(null); setShowForm(true); };
  const openEdit = (r) => { setEditRecord(r); setShowForm(true); };

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 bg-gradient-to-br from-indigo-500 to-indigo-700 rounded-xl flex items-center justify-center shadow-lg shadow-indigo-500/20">
            <BanknotesIcon className="w-5 h-5 text-white" />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-gray-900 tracking-tight">Salary Structure</h1>
            <p className="text-sm text-gray-400">{isHR ? 'Manage employee salary components. Every revision is versioned — history is never overwritten.' : 'Your current salary structure and revision history.'}</p>
          </div>
        </div>
        {isHR && (
          <button onClick={openCreate} className="inline-flex items-center gap-2 px-4 py-2.5 bg-gradient-to-r from-indigo-600 to-indigo-700 text-white text-sm font-medium rounded-xl hover:from-indigo-700 hover:to-indigo-800 shadow-lg shadow-indigo-500/25 self-start">
            <PlusIcon className="w-4.5 h-4.5" /> New Salary Structure
          </button>
        )}
      </div>

      {/* Summary (HR) */}
      {isHR && (
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          {[
            { label: 'Employees on Payroll', value: summary.count, icon: UserCircleIcon, color: 'text-indigo-600' },
            { label: 'Monthly Gross', value: inr(summary.gross), icon: ArrowTrendingUpIcon, color: 'text-emerald-600' },
            { label: 'Monthly Net Payout', value: inr(summary.net), icon: CheckBadgeIcon, color: 'text-blue-600' },
          ].map(s => (
            <div key={s.label} className="bg-white rounded-xl border border-gray-100 shadow-sm p-4 flex items-center gap-3">
              <div className="w-10 h-10 rounded-lg bg-gray-50 flex items-center justify-center"><s.icon className={`w-5 h-5 ${s.color}`} /></div>
              <div><p className="text-[11px] uppercase tracking-wide text-gray-400">{s.label}</p><p className="text-xl font-bold text-gray-900">{s.value}</p></div>
            </div>
          ))}
        </div>
      )}

      {/* Filter (HR) */}
      {isHR && employees.length > 0 && (
        <div className="flex items-center gap-3">
          <select value={empFilter} onChange={e => setEmpFilter(e.target.value)}
            className="h-10 px-3 bg-white border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-400">
            <option value="">All Employees</option>
            {employees.map(e => <option key={e.hr_hremployeeid} value={e.hr_hremployeeid}>{e.hr_hremployee1}</option>)}
          </select>
        </div>
      )}

      {/* Grid */}
      {isLoading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 items-start">
          {[...Array(6)].map((_, i) => <div key={i} className="h-64 bg-white rounded-2xl border border-gray-100 animate-pulse" />)}
        </div>
      ) : active.length === 0 ? (
        <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-16 text-center">
          <div className="w-16 h-16 bg-gray-100 rounded-2xl flex items-center justify-center mx-auto mb-4"><BanknotesIcon className="w-8 h-8 text-gray-300" /></div>
          <h3 className="text-lg font-semibold text-gray-700 mb-1">No salary structures yet</h3>
          <p className="text-sm text-gray-400">{isHR ? 'Click "New Salary Structure" to define an employee\'s salary.' : 'Your salary structure has not been set up yet. Please contact HR.'}</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 items-start">
          {active.map(r => (
            <SalaryCard key={r.id} record={r}
              canEdit={isHR} canDelete={isSuperAdmin}
              onEdit={openEdit} onDelete={handleDelete} onHistory={setHistoryFor} />
          ))}
        </div>
      )}

      {showForm && <SalaryFormModal record={editRecord} employees={employees} onClose={() => setShowForm(false)} />}
      {historyFor && <HistoryModal employeeId={historyFor.employeeId} employeeName={historyFor._employee?.name || historyFor.employeeName} onClose={() => setHistoryFor(null)} />}
    </div>
  );
}
