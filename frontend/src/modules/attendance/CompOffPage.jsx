import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { compOffApi, employeeApi, leaveApi, documentApi } from '../../api/endpoints';
import { useAuth } from '../../context/AuthContext';
import Button from '../../components/Button';
import {
  PlusIcon, XMarkIcon, CheckIcon, ArrowPathIcon, MagnifyingGlassIcon,
  GiftIcon, ClockIcon, NoSymbolIcon, TrashIcon, PencilSquareIcon, EyeIcon,
  CalendarDaysIcon, CheckCircleIcon, ExclamationTriangleIcon,
} from '@heroicons/react/24/outline';
import { format } from 'date-fns';
import toast from 'react-hot-toast';

const STATUS = {
  pending: 'bg-amber-50 text-amber-700 border-amber-200',
  approved: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  rejected: 'bg-red-50 text-red-700 border-red-200',
  expired: 'bg-gray-100 text-gray-500 border-gray-200',
  cancelled: 'bg-gray-100 text-gray-500 border-gray-200',
  used: 'bg-indigo-50 text-indigo-700 border-indigo-200',
};
const fmt = (d) => { try { return d ? format(new Date(d), 'dd-MM-yyyy') : '—'; } catch { return d || '—'; } };
const inp = 'w-full h-10 px-3 bg-gray-50 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-400';

const fmtHrs = (h) => { const n = Number(h) || 0; const m = Math.round(n * 60); return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`; };

// Grant (HR) / Raise (employee) comp-off.
function RaiseModal({ isHR, employees, onClose }) {
  const qc = useQueryClient();
  const [f, setF] = useState({ employeeId: '', workedDate: new Date().toISOString().slice(0, 10), days: 1, workReport: '', holidayName: '', grant: isHR, evidenceUrl: '' });
  const [evidenceName, setEvidenceName] = useState('');
  const [uploading, setUploading] = useState(false);

  // Live eligibility hint (backend re-checks on submit). Employee → self; HR → selected emp.
  const empParam = isHR ? f.employeeId : undefined;
  const { data: elig, isFetching: eligLoading } = useQuery({
    queryKey: ['compoff-eligibility', empParam || 'self', f.workedDate],
    queryFn: () => compOffApi.eligibility({ date: f.workedDate, ...(empParam ? { employeeId: empParam } : {}) }).then(r => r.data),
    enabled: !!f.workedDate && (isHR ? !!f.employeeId : true),
  });

  const mut = useMutation({
    mutationFn: () => compOffApi.create(f),
    onSuccess: () => { toast.success(isHR ? 'Comp off saved' : 'Comp off requested'); qc.invalidateQueries({ queryKey: ['comp-off'] }); qc.invalidateQueries({ queryKey: ['leave-balance'] }); onClose(); },
    onError: (e) => toast.error(e.response?.data?.error || 'Failed'),
  });

  const uploadEvidence = async (file) => {
    if (!file) return;
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append('file', file);
      fd.append('documentType', 'Comp Off Evidence');
      fd.append('name', `Comp Off Evidence — ${f.workedDate}`);
      if (isHR && f.employeeId) fd.append('employeeId', f.employeeId);
      const r = await documentApi.upload(fd);
      const url = r.data?.fileUrl || r.data?.hr_fileurl || r.data?.url || '';
      setF(p => ({ ...p, evidenceUrl: url })); setEvidenceName(file.name);
      toast.success('Evidence attached');
    } catch (e) { toast.error(e.response?.data?.error || 'Upload failed'); }
    finally { setUploading(false); }
  };

  // Employees cannot submit unless eligible + a work report is written. HR keeps discretion.
  const notEligible = elig && !elig.eligible;
  const invalid = (isHR && !f.employeeId) || !f.workedDate
    || (!isHR && (!f.workReport.trim() || !elig || !elig.eligible))
    || uploading;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4 overflow-y-auto">
      <div className="bg-white w-full max-w-md rounded-2xl shadow-2xl my-8">
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
          <h2 className="text-lg font-bold text-gray-900">{isHR ? 'Grant Comp Off' : 'Raise Comp Off'}</h2>
          <button onClick={onClose} className="p-2 text-gray-400 hover:bg-gray-100 rounded-lg"><XMarkIcon className="w-5 h-5" /></button>
        </div>
        <div className="p-6 space-y-4">
          {isHR && (
            <div><label className="block text-xs font-semibold text-gray-600 mb-1">Employee</label>
              <select className={inp} value={f.employeeId} onChange={e => setF(p => ({ ...p, employeeId: e.target.value }))}>
                <option value="">Select employee…</option>
                {employees.map(e => <option key={e.hr_hremployeeid} value={e.hr_hremployeeid}>{e.hr_hremployee1}</option>)}
              </select></div>
          )}
          <div className={`grid ${isHR ? 'grid-cols-2' : 'grid-cols-1'} gap-3`}>
            <div><label className="block text-xs font-semibold text-gray-600 mb-1">Comp Off Date</label>
              <input type="date" className={inp} value={f.workedDate} onChange={e => setF(p => ({ ...p, workedDate: e.target.value }))} /></div>
            {isHR && (
              <div><label className="block text-xs font-semibold text-gray-600 mb-1">Comp Off Days (override)</label>
                <input type="number" step="0.5" min="0.5" className={inp} value={f.days} onChange={e => setF(p => ({ ...p, days: e.target.value }))} placeholder="auto" /></div>
            )}
          </div>

          {/* Eligibility panel — computed from the actual attendance for the date */}
          {f.workedDate && (isHR ? f.employeeId : true) && (
            <div className={`rounded-xl border p-3 text-sm ${notEligible ? 'bg-red-50 border-red-200' : elig?.eligible ? 'bg-emerald-50 border-emerald-200' : 'bg-gray-50 border-gray-200'}`}>
              {eligLoading ? <p className="text-gray-500">Checking attendance…</p> : elig ? (
                <div className="space-y-1">
                  <div className="flex justify-between"><span className="text-gray-500">Attendance Date</span><span className="font-semibold text-gray-800">{fmt(f.workedDate)}</span></div>
                  <div className="flex justify-between"><span className="text-gray-500">Shift</span><span className="font-semibold text-gray-800">{elig.shiftName || '—'}</span></div>
                  <div className="flex justify-between"><span className="text-gray-500">First / Last Punch</span><span className="font-semibold text-gray-800 tabular-nums">{elig.firstPunch || '—'} / {elig.lastPunch || '—'}</span></div>
                  <div className="flex justify-between"><span className="text-gray-500">Worked Hours</span><span className="font-bold text-gray-900 tabular-nums">{elig.hasAttendance ? fmtHrs(elig.effectiveHours) : '—'}</span></div>
                  <div className="flex justify-between items-center pt-1 border-t border-gray-200/70">
                    <span className="text-gray-500">Eligibility</span>
                    {elig.eligible
                      ? <span className="inline-flex items-center gap-1 font-bold text-emerald-700"><CheckCircleIcon className="w-4 h-4" /> Eligible</span>
                      : <span className="inline-flex items-center gap-1 font-bold text-red-600"><ExclamationTriangleIcon className="w-4 h-4" /> Not Eligible</span>}
                  </div>
                  {!elig.eligible && (
                    <p className="text-[11px] text-red-600 pt-0.5">
                      {elig.duplicate ? 'A Comp Off already exists for this date.'
                        : !elig.hasAttendance ? 'No valid attendance found for this date.'
                        : `Minimum required: ${elig.minHours}h.`}
                    </p>
                  )}
                </div>
              ) : <p className="text-gray-400">Select a date to check eligibility.</p>}
            </div>
          )}

          <div><label className="block text-xs font-semibold text-gray-600 mb-1">Work Performed / Work Report {!isHR && <span className="text-red-500">*</span>}</label>
            <textarea rows={3} className={`${inp} h-auto py-2 resize-y`} value={f.workReport} onChange={e => setF(p => ({ ...p, workReport: e.target.value }))} placeholder="Describe the work completed on this date." /></div>

          {isHR && (
            <div><label className="block text-xs font-semibold text-gray-600 mb-1">Holiday Name</label>
              <input className={inp} value={f.holidayName} onChange={e => setF(p => ({ ...p, holidayName: e.target.value }))} placeholder="optional" /></div>
          )}

          <div>
            <label className="block text-xs font-semibold text-gray-600 mb-1">Supporting Evidence <span className="text-gray-400 font-normal">(optional)</span></label>
            <input type="file" className="block w-full text-xs text-gray-600 file:mr-3 file:py-1.5 file:px-3 file:rounded-lg file:border-0 file:bg-indigo-50 file:text-indigo-700 file:font-semibold hover:file:bg-indigo-100" onChange={e => uploadEvidence(e.target.files?.[0])} />
            {uploading && <p className="text-[11px] text-gray-400 mt-1">Uploading…</p>}
            {evidenceName && !uploading && <p className="text-[11px] text-emerald-600 mt-1">Attached: {evidenceName}</p>}
          </div>

          {isHR && (
            <label className="flex items-center gap-2 text-sm text-gray-700">
              <input type="checkbox" checked={f.grant} onChange={e => setF(p => ({ ...p, grant: e.target.checked }))} />
              Approve immediately (credit the balance now)
            </label>
          )}
        </div>
        <div className="flex justify-end gap-3 px-6 py-4 border-t border-gray-100">
          <button onClick={onClose} className="px-4 py-2 text-sm text-gray-600">Cancel</button>
          <Button onClick={() => mut.mutate()} loading={mut.isPending} disabled={invalid}>{isHR ? 'Save' : 'Submit Request'}</Button>
        </div>
      </div>
    </div>
  );
}

// HR: scan attendance for holiday / weekly-off work → auto-raise comp-off.
function ScanModal({ onClose }) {
  const qc = useQueryClient();
  const [f, setF] = useState({ from: '', to: '' });
  const mut = useMutation({
    mutationFn: () => compOffApi.scan(f),
    onSuccess: (r) => { toast.success(`${r.data?.created || 0} comp-off request(s) raised`); qc.invalidateQueries({ queryKey: ['comp-off'] }); onClose(); },
    onError: (e) => toast.error(e.response?.data?.error || 'Scan failed'),
  });
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4">
      <div className="bg-white w-full max-w-sm rounded-2xl shadow-2xl">
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
          <h2 className="text-lg font-bold text-gray-900">Scan Attendance</h2>
          <button onClick={onClose} className="p-2 text-gray-400 hover:bg-gray-100 rounded-lg"><XMarkIcon className="w-5 h-5" /></button>
        </div>
        <div className="p-6 space-y-4">
          <p className="text-xs text-gray-500">Finds employees who worked on a holiday or weekly-off in this range and raises a pending comp-off for each.</p>
          <div className="grid grid-cols-2 gap-3">
            <div><label className="block text-xs font-semibold text-gray-600 mb-1">From</label>
              <input type="date" className={inp} value={f.from} onChange={e => setF(p => ({ ...p, from: e.target.value }))} /></div>
            <div><label className="block text-xs font-semibold text-gray-600 mb-1">To</label>
              <input type="date" className={inp} value={f.to} onChange={e => setF(p => ({ ...p, to: e.target.value }))} /></div>
          </div>
        </div>
        <div className="flex justify-end gap-3 px-6 py-4 border-t border-gray-100">
          <button onClick={onClose} className="px-4 py-2 text-sm text-gray-600">Cancel</button>
          <Button onClick={() => mut.mutate()} loading={mut.isPending} disabled={!f.from || !f.to}>Scan</Button>
        </div>
      </div>
    </div>
  );
}

// HR "Check Attendance" modal — shows the verified attendance for the comp-off's worked
// date + the backend-calculated eligibility. Approve/Reject use the verified eligible days.
function VerifyAttendanceModal({ id, onClose }) {
  const qc = useQueryClient();
  const { data: v, isLoading } = useQuery({ queryKey: ['comp-off-verify', id], queryFn: () => compOffApi.verify(id).then(r => r.data) });
  const refresh = () => { qc.invalidateQueries({ queryKey: ['comp-off'] }); qc.invalidateQueries({ queryKey: ['leave-balance'] }); };
  const approveMut = useMutation({ mutationFn: () => compOffApi.approve(id), onSuccess: () => { toast.success('Comp Off approved'); refresh(); onClose(); }, onError: (e) => toast.error(e.response?.data?.error || 'Failed to approve') });
  const rejectMut = useMutation({ mutationFn: () => compOffApi.reject(id), onSuccess: () => { toast.success('Comp Off rejected'); refresh(); onClose(); }, onError: (e) => toast.error(e.response?.data?.error || 'Failed to reject') });
  const a = v?.attendance;
  const YesNo = ({ on }) => <span className={`font-semibold ${on ? 'text-emerald-600' : 'text-gray-400'}`}>{on ? 'Yes' : 'No'}</span>;
  const Row = ({ label, children }) => <div className="flex justify-between text-sm py-1"><span className="text-gray-500">{label}</span><span className="font-medium text-gray-800 text-right">{children}</span></div>;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div className="bg-white rounded-2xl w-full max-w-lg shadow-xl max-h-[90vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
          <div className="flex items-center gap-2"><CalendarDaysIcon className="w-5 h-5 text-indigo-600" /><h3 className="text-base font-bold text-gray-900">Attendance Verification</h3></div>
          <button onClick={onClose} className="p-1 rounded-lg hover:bg-gray-100"><XMarkIcon className="w-5 h-5 text-gray-500" /></button>
        </div>

        {isLoading || !v ? (
          <div className="p-10 text-center text-sm text-gray-400">Loading attendance…</div>
        ) : (
          <div className="p-5 space-y-4">
            <div>
              <p className="text-sm font-bold text-gray-900">{v.employeeName || 'Employee'}</p>
              <p className="text-xs text-gray-500">{v.day ? `${v.day}, ` : ''}{v.workedDate} · <span className="capitalize">{v.type}</span>{v.reason ? ` · ${v.reason}` : ''}</p>
            </div>

            {/* Attendance details */}
            <div className="rounded-xl border border-gray-100 bg-gray-50/50 p-4">
              <p className="text-[11px] font-bold uppercase tracking-wider text-gray-400 mb-2">Attendance Details</p>
              {v.attendanceFound ? (
                <>
                  <Row label="Status"><span className="capitalize">{a.status || '—'}</span></Row>
                  <Row label="Shift">{v.shift?.name ? `${v.shift.name}${v.shift.start ? ` (${v.shift.start}–${v.shift.end})` : ''}` : '—'}</Row>
                  <Row label="First Punch">{v.firstPunch || a.inTime || '—'}</Row>
                  <Row label="Last Punch">{v.lastPunch || a.outTime || '—'}</Row>
                  <Row label="All Punches">{a.punches?.length ? a.punches.join(', ') : '—'}</Row>
                  <Row label="Source">{a.source || '—'}</Row>
                </>
              ) : (
                <div className="flex items-center gap-2 text-sm text-red-700"><ExclamationTriangleIcon className="w-4 h-4" /> No attendance record exists for this date.</div>
              )}
            </div>

            {/* Work report + supporting evidence (manual requests) */}
            {(v.workReport || v.evidenceUrl) && (
              <div className="rounded-xl border border-gray-100 bg-gray-50/50 p-4">
                <p className="text-[11px] font-bold uppercase tracking-wider text-gray-400 mb-2">Work Report</p>
                <p className="text-sm text-gray-800 whitespace-pre-wrap">{v.workReport || '—'}</p>
                {v.evidenceUrl && (
                  <a href={v.evidenceUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 mt-2 text-xs font-semibold text-indigo-600 hover:underline">
                    <EyeIcon className="w-4 h-4" /> View Supporting Evidence
                  </a>
                )}
              </div>
            )}

            {/* Working hours */}
            {v.attendanceFound && (
              <div className="rounded-xl border border-gray-100 bg-gray-50/50 p-4">
                <p className="text-[11px] font-bold uppercase tracking-wider text-gray-400 mb-2">Working Hours</p>
                <Row label="Effective Working Hours"><span className="text-indigo-700 font-bold">{a.effectiveHoursLabel}</span></Row>
                <Row label="Break Duration">{a.breakLabel}</Row>
              </div>
            )}

            {/* Eligibility */}
            <div className="rounded-xl border border-gray-100 bg-gray-50/50 p-4">
              <p className="text-[11px] font-bold uppercase tracking-wider text-gray-400 mb-2">Comp Off Eligibility</p>
              <Row label="Company Holiday"><YesNo on={v.holiday} /></Row>
              <Row label="Weekly Off"><YesNo on={v.weeklyOff} /></Row>
              <Row label="Effective Hours">{v.attendanceFound ? a.effectiveHoursLabel : '—'}</Row>
              <div className="mt-2 flex items-center gap-2">
                {v.eligible
                  ? <span className="inline-flex items-center gap-1.5 text-sm font-bold text-emerald-700 bg-emerald-50 border border-emerald-200 px-3 py-1.5 rounded-lg"><CheckCircleIcon className="w-4 h-4" /> {v.eligibilityLabel}</span>
                  : <span className="inline-flex items-center gap-1.5 text-sm font-bold text-red-700 bg-red-50 border border-red-200 px-3 py-1.5 rounded-lg"><ExclamationTriangleIcon className="w-4 h-4" /> {v.eligibilityLabel}</span>}
              </div>
              {!v.eligible && v.eligibilityReason && <p className="text-xs text-gray-500 mt-1.5">{v.eligibilityReason}</p>}
            </div>

            {/* Approval actions — only for a still-pending comp-off */}
            <div className="flex justify-end gap-2 pt-1">
              <button onClick={onClose} className="px-4 py-2 text-sm font-medium text-gray-600 bg-gray-100 rounded-xl hover:bg-gray-200">Close</button>
              {v.compOffStatus === 'pending' && (
                <>
                  <button onClick={() => rejectMut.mutate()} disabled={rejectMut.isPending} className="px-4 py-2 text-sm font-semibold text-red-700 bg-red-50 rounded-xl hover:bg-red-100 disabled:opacity-50">Reject</button>
                  <button onClick={() => approveMut.mutate()} disabled={!v.eligible || approveMut.isPending}
                    title={v.eligible ? '' : 'Not eligible — attendance does not qualify'}
                    className="px-5 py-2 text-sm font-semibold text-white bg-emerald-600 rounded-xl hover:bg-emerald-700 disabled:opacity-40 disabled:cursor-not-allowed">
                    {approveMut.isPending ? 'Approving…' : v.eligible ? `Approve ${v.eligibleDays} Day` : 'Not Eligible'}
                  </button>
                </>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export default function CompOffPage() {
  const { user, isHR } = useAuth();
  const hr = typeof isHR === 'function' ? isHR() : ['super_admin', 'hr_manager'].includes(user?.role);
  const qc = useQueryClient();
  const [selectedEmp, setSelectedEmp] = useState('');
  const [showRaise, setShowRaise] = useState(false);
  const [showScan, setShowScan] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(null);   // the comp-off row pending deletion
  const [verifyId, setVerifyId] = useState(null);             // comp-off id whose attendance HR is verifying

  const { data: policyRes } = useQuery({ queryKey: ['comp-off-policy'], queryFn: () => compOffApi.policy().then(r => r.data) });
  const policy = policyRes || {};
  const { data: empRes } = useQuery({ queryKey: ['employees-lite'], queryFn: () => employeeApi.list({ limit: 500 }), enabled: hr });
  const employees = empRes?.data?.data || empRes?.data || [];

  const targetId = hr ? (selectedEmp || undefined) : undefined;
  const { data: listRes, isLoading } = useQuery({
    queryKey: ['comp-off', targetId || 'self'],
    queryFn: () => compOffApi.list({ ...(targetId ? { employeeId: targetId } : {}) }).then(r => r.data),
  });
  const records = listRes?.data || [];

  const { data: balRes } = useQuery({ queryKey: ['leave-balance', targetId || 'self', new Date().getFullYear()], queryFn: () => leaveApi.balance({ ...(targetId ? { employeeId: targetId } : {}) }) });
  const compOff = balRes?.data?.compOff || {};

  const approveMut = useMutation({ mutationFn: (id) => compOffApi.approve(id), onSuccess: () => { toast.success('Approved'); qc.invalidateQueries({ queryKey: ['comp-off'] }); qc.invalidateQueries({ queryKey: ['leave-balance'] }); }, onError: (e) => toast.error(e.response?.data?.error || 'Failed') });
  const rejectMut = useMutation({ mutationFn: (id) => compOffApi.reject(id), onSuccess: () => { toast.success('Rejected'); qc.invalidateQueries({ queryKey: ['comp-off'] }); }, onError: (e) => toast.error(e.response?.data?.error || 'Failed') });
  const cancelMut = useMutation({ mutationFn: (id) => compOffApi.cancel(id), onSuccess: () => { toast.success('Cancelled'); qc.invalidateQueries({ queryKey: ['comp-off'] }); qc.invalidateQueries({ queryKey: ['leave-balance'] }); }, onError: (e) => toast.error(e.response?.data?.error || 'Failed') });
  const expireMut = useMutation({ mutationFn: (id) => compOffApi.expire(id), onSuccess: () => { toast.success('Expired'); qc.invalidateQueries({ queryKey: ['comp-off'] }); qc.invalidateQueries({ queryKey: ['leave-balance'] }); }, onError: (e) => toast.error(e.response?.data?.error || 'Failed') });
  const deleteMut = useMutation({
    mutationFn: (id) => compOffApi.remove(id),
    onSuccess: () => { toast.success('Comp Off deleted successfully.'); setConfirmDelete(null); qc.invalidateQueries({ queryKey: ['comp-off'] }); qc.invalidateQueries({ queryKey: ['leave-balance'] }); },
    onError: (e) => toast.error(e.response?.data?.error || 'Failed to delete'),
  });

  // Worked hours (decimal → "8h 20m") for the Reason cell of auto records.
  const hoursLabel = (h) => { const n = Number(h) || 0; if (!n) return ''; const hh = Math.floor(n); const mm = Math.round((n - hh) * 60); return `${hh}h${mm ? ` ${mm}m` : ''}`; };

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 tracking-tight">Comp Off</h1>
          <p className="text-sm text-gray-500 mt-1">Earn comp-off for holiday / weekly-off work. Comp Off is paid leave — never LOP.</p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {hr && (
            <select value={selectedEmp} onChange={e => setSelectedEmp(e.target.value)} className="h-10 px-3 bg-white border border-gray-200 rounded-lg text-sm">
              <option value="">All employees</option>
              {employees.map(e => <option key={e.hr_hremployeeid} value={e.hr_hremployeeid}>{e.hr_hremployee1}</option>)}
            </select>
          )}
          {hr && <Button variant="secondary" icon={MagnifyingGlassIcon} onClick={() => setShowScan(true)}>Scan Attendance</Button>}
          {(hr || policy.employeeRaise) && <Button icon={PlusIcon} onClick={() => setShowRaise(true)}>{hr ? 'Grant Comp Off' : 'Raise Comp Off'}</Button>}
        </div>
      </div>

      {/* Balance summary */}
      <div className="grid grid-cols-3 gap-3 max-w-lg">
        {[
          { label: 'Available', val: compOff.balance, accent: 'text-emerald-700', icon: GiftIcon },
          { label: 'Earned', val: compOff.earned, accent: 'text-gray-900', icon: CheckIcon },
          { label: 'Used', val: compOff.used, accent: 'text-indigo-700', icon: ClockIcon },
        ].map(c => (
          <div key={c.label} className="bg-white rounded-xl border border-gray-100 shadow-sm p-4">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-gray-400">{c.label}</p>
            <p className={`text-2xl font-bold mt-1 ${c.accent}`}>{Number(c.val || 0)}</p>
          </div>
        ))}
      </div>

      {/* Records */}
      <div className="bg-white rounded-xl border border-gray-100 shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-gray-500">
              <tr className="text-left">
                {hr && <th className="px-4 py-3 font-semibold">Employee</th>}
                <th className="px-4 py-3 font-semibold">Type</th>
                <th className="px-4 py-3 font-semibold">Worked Date</th>
                <th className="px-4 py-3 font-semibold">Days</th>
                <th className="px-4 py-3 font-semibold">Reason / Holiday</th>
                <th className="px-4 py-3 font-semibold">Expiry</th>
                <th className="px-4 py-3 font-semibold">Status</th>
                <th className="px-4 py-3 font-semibold text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {isLoading ? (
                <tr><td colSpan={hr ? 8 : 7} className="px-4 py-10 text-center text-gray-400">Loading…</td></tr>
              ) : records.length === 0 ? (
                <tr><td colSpan={hr ? 8 : 7} className="px-4 py-10 text-center text-gray-400">No comp-off records yet.</td></tr>
              ) : records.map(r => (
                <tr key={r.id} className="hover:bg-gray-50/50">
                  {hr && <td className="px-4 py-3 font-medium text-gray-800">{r.employeeName || '—'}</td>}
                  <td className="px-4 py-3 capitalize text-gray-600">{r.type}</td>
                  <td className="px-4 py-3 text-gray-600">{fmt(r.workedDate)}</td>
                  <td className="px-4 py-3 font-semibold text-gray-800">{r.days}</td>
                  <td className="px-4 py-3 text-gray-500 max-w-[16rem]">
                    <div className="truncate">{r.holidayName || r.reason || '—'}</div>
                    {r.type === 'auto' && Number(r.workedHours) > 0 && <div className="text-[11px] text-gray-400">Worked Hours: {hoursLabel(r.workedHours)}</div>}
                  </td>
                  <td className="px-4 py-3 text-gray-500">{fmt(r.expiryDate)}</td>
                  <td className="px-4 py-3"><span className={`inline-flex items-center text-[11px] font-semibold border px-2 py-0.5 rounded-full capitalize ${STATUS[r.status] || STATUS.pending}`}>{r.status}</span></td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-1.5 justify-end flex-wrap">
                      {/* HR verifies the employee's actual attendance for the worked date. */}
                      {hr && (
                        <button onClick={() => setVerifyId(r.id)} className="inline-flex items-center gap-1 px-2 py-1 text-xs font-semibold text-indigo-700 bg-indigo-50 rounded-lg hover:bg-indigo-100"><EyeIcon className="w-3.5 h-3.5" /> Attendance</button>
                      )}
                      {hr && r.status === 'pending' && (
                        <>
                          <button onClick={() => approveMut.mutate(r.id)} className="inline-flex items-center gap-1 px-2 py-1 text-xs font-semibold text-emerald-700 bg-emerald-50 rounded-lg hover:bg-emerald-100"><CheckIcon className="w-3.5 h-3.5" /> Approve</button>
                          <button onClick={() => rejectMut.mutate(r.id)} className="inline-flex items-center gap-1 px-2 py-1 text-xs font-semibold text-red-700 bg-red-50 rounded-lg hover:bg-red-100"><XMarkIcon className="w-3.5 h-3.5" /> Reject</button>
                        </>
                      )}
                      {hr && r.status === 'approved' && (
                        <>
                          <button onClick={() => cancelMut.mutate(r.id)} className="inline-flex items-center gap-1 px-2 py-1 text-xs font-semibold text-gray-700 bg-gray-100 rounded-lg hover:bg-gray-200"><NoSymbolIcon className="w-3.5 h-3.5" /> Cancel</button>
                          <button onClick={() => expireMut.mutate(r.id)} className="inline-flex items-center gap-1 px-2 py-1 text-xs font-semibold text-amber-700 bg-amber-50 rounded-lg hover:bg-amber-100"><ClockIcon className="w-3.5 h-3.5" /> Expire</button>
                        </>
                      )}
                      {/* Delete is an EMPLOYEE action on their OWN records — HR/Admin never see it
                          (and the backend 403s them). Pending/rejected always; approved only when
                          UNUSED (else shown disabled with a tooltip). */}
                      {!hr && ['pending', 'rejected'].includes(r.status) && (
                        <button onClick={() => setConfirmDelete(r)} className="inline-flex items-center gap-1 px-2 py-1 text-xs font-semibold text-red-700 bg-red-50 rounded-lg hover:bg-red-100"><TrashIcon className="w-3.5 h-3.5" /> Delete</button>
                      )}
                      {!hr && r.status === 'approved' && (r.deletable
                        ? <button onClick={() => setConfirmDelete(r)} className="inline-flex items-center gap-1 px-2 py-1 text-xs font-semibold text-red-700 bg-red-50 rounded-lg hover:bg-red-100"><TrashIcon className="w-3.5 h-3.5" /> Delete</button>
                        : <span title="Used Comp Off cannot be deleted." className="inline-flex items-center gap-1 px-2 py-1 text-xs font-semibold text-gray-300 bg-gray-50 rounded-lg cursor-not-allowed"><TrashIcon className="w-3.5 h-3.5" /> Delete</span>)}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {showRaise && <RaiseModal isHR={hr} employees={employees} onClose={() => setShowRaise(false)} />}
      {showScan && <ScanModal onClose={() => setShowScan(false)} />}
      {verifyId && <VerifyAttendanceModal id={verifyId} onClose={() => setVerifyId(null)} />}

      {confirmDelete && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => !deleteMut.isPending && setConfirmDelete(null)}>
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-md p-6" onClick={e => e.stopPropagation()}>
            <div className="flex items-center gap-3 mb-2">
              <div className="w-10 h-10 rounded-full bg-red-50 flex items-center justify-center"><TrashIcon className="w-5 h-5 text-red-600" /></div>
              <h2 className="text-lg font-bold text-gray-900">Delete this Comp Off?</h2>
            </div>
            <p className="text-sm text-gray-500 mb-1">Are you sure you want to permanently delete this Comp Off record?</p>
            <p className="text-xs text-gray-400 mb-5">{confirmDelete.employeeName ? `${confirmDelete.employeeName} · ` : ''}{fmt(confirmDelete.workedDate)} · {confirmDelete.days} day(s){confirmDelete.status === 'approved' ? ' · approved credit will be reversed' : ''}</p>
            <div className="flex justify-end gap-3">
              <button onClick={() => setConfirmDelete(null)} disabled={deleteMut.isPending} className="px-4 py-2 text-sm font-medium text-gray-600 bg-gray-100 rounded-xl hover:bg-gray-200 disabled:opacity-50">Cancel</button>
              <button onClick={() => deleteMut.mutate(confirmDelete.id)} disabled={deleteMut.isPending} className="px-5 py-2 text-sm font-medium text-white bg-red-600 rounded-xl hover:bg-red-700 disabled:opacity-50">{deleteMut.isPending ? 'Deleting…' : 'Delete'}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
