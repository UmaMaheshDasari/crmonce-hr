import { useState, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { lateLoginApi, employeeApi, requestLifecycleApi } from '../../api/endpoints';
import { useAuth } from '../../context/AuthContext';
import Button from '../../components/Button';
import { PlusIcon, XMarkIcon, ArrowDownTrayIcon } from '@heroicons/react/24/outline';
import RequestLifecycleActions from '../../components/RequestLifecycleActions';
import { format, subDays } from 'date-fns';
import toast from 'react-hot-toast';

// This page serves BOTH Late Login and Early Logout — same design/behaviour (an
// INFORMATION record, no approval, no attendance punch). `requestType` + CFG swap the
// wording, the shift reference (shift START for late login / shift END for early logout)
// and the time direction (late-by vs early-by).
const CFG = {
  late_login: {
    title: 'Late Login',
    lead: 'Record a late login — informational only (no approval). Attendance stays Present; no leave/salary deducted.',
    raise: 'Raise Late Login', request: 'Request Late Login', modalNew: 'Late Login Request', modalEdit: 'Edit Late Login',
    shiftLabel: 'Shift Start Time', timeLabel: 'Late Login Time', diffLabel: 'Late By',
    colShift: 'Shift Start', colTime: 'Late Login',
    timePlaceholder: 'Why were you / will you be late?',
    key: 'late-login', file: 'late-logins',
  },
  early_logout: {
    title: 'Early Logout',
    lead: 'Record an early logout — informational only (no approval). Attendance is unchanged; no leave/salary deducted.',
    raise: 'Raise Early Logout', request: 'Request Early Logout', modalNew: 'Early Logout Request', modalEdit: 'Edit Early Logout',
    shiftLabel: 'Shift End Time', timeLabel: 'Logout Time', diffLabel: 'Early By',
    colShift: 'Shift End', colTime: 'Logout',
    timePlaceholder: 'Why do you need to leave early?',
    key: 'early-logout', file: 'early-logouts',
  },
};
// Permission is allowed only up to 2 hours (spec §2); beyond that the employee applies for leave.
const MAX_MIN = 120;
const LIMIT_MSG = 'Permission is allowed only up to 2 hours. Please apply for leave for a longer duration.';

const inp = 'w-full h-10 px-3 bg-gray-50 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-400';
const STATUS = {
  submitted: 'bg-blue-50 text-blue-700 border-blue-200',
  completed: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  absent_leave_required: 'bg-red-50 text-red-700 border-red-200',
  cancelled: 'bg-gray-100 text-gray-500 border-gray-200',
  pending: 'bg-blue-50 text-blue-700 border-blue-200',
  approved: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  rejected: 'bg-gray-100 text-gray-500 border-gray-200',
  auto_approved: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  manager_pending: 'bg-amber-50 text-amber-700 border-amber-200',
  manager_approved: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  manager_rejected: 'bg-red-50 text-red-700 border-red-200',
  cl_deducted: 'bg-violet-50 text-violet-700 border-violet-200',
  hr_review: 'bg-orange-50 text-orange-700 border-orange-200',
};
const STATUS_LABEL = {
  submitted: 'Submitted', completed: 'Completed', absent_leave_required: 'Leave Required',
  cancelled: 'Cancelled', pending: 'Submitted', approved: 'Completed', rejected: 'Cancelled',
  auto_approved: 'Auto-approved', manager_pending: 'Pending Approval', manager_approved: 'Approved',
  manager_rejected: 'Rejected', cl_deducted: 'CL Deducted (0.5)', hr_review: 'HR Review',
};
const fmt = (d) => { try { return d ? format(new Date(d), 'dd-MM-yyyy') : '—'; } catch { return d || '—'; } };
const toMin = (t) => { const m = String(t || '').match(/(\d{1,2}):(\d{2})/); return m ? (+m[1]) * 60 + (+m[2]) : null; };
const to12h = (t) => { const m = String(t || '').match(/(\d{1,2}):(\d{2})/); if (!m) return ''; let h = +m[1]; const ap = h >= 12 ? 'PM' : 'AM'; h = h % 12 || 12; return `${h}:${m[2]} ${ap}`; };
// Forward minutes on a 24h clock (overnight-safe). late-by = START→login; early-by = logout→END.
const fwd = (from, to) => { const f = toMin(from), t = toMin(to); return (f == null || t == null) ? null : (((t - f) % 1440) + 1440) % 1440; };
const permMin = (rt, shiftTime, time) => (rt === 'early_logout' ? fwd(time, shiftTime) : fwd(shiftTime, time));
const compact = (n) => { if (n == null) return '—'; const h = Math.floor(n / 60), m = n % 60; return [h ? `${h}h` : '', m ? `${m}m` : ''].filter(Boolean).join(' ') || '0m'; };
const longDur = (n) => { if (n == null) return ''; const h = Math.floor(n / 60), m = n % 60; return [h ? `${h} hour${h === 1 ? '' : 's'}` : '', m ? `${m} minute${m === 1 ? '' : 's'}` : ''].filter(Boolean).join(' ') || '0 minutes'; };
const canon = (r) => {
  if (r.status === 'cancelled') return 'cancelled';
  if (r.status === 'rejected') return 'rejected';
  if (r.status === 'approved') return 'approved';
  return 'pending';
};
const todayStr = new Date().toISOString().slice(0, 10);

function SubmitModal({ requestType, cfg, isHR, employees, policy, editRecord, onClose }) {
  const qc = useQueryClient();
  const isEdit = !!editRecord;
  const [f, setF] = useState(isEdit
    ? { employeeId: editRecord.employeeId || '', date: String(editRecord.date || '').slice(0, 10), actualTime: editRecord.actualTime || '', reason: editRecord.reason || '', remarks: editRecord.remarks || '' }
    : { employeeId: '', date: todayStr, actualTime: '', reason: '', remarks: '' });

  // Shift reference time is AUTO from the employee's shift (source of truth = Attendance
  // shift config), read-only. Late Login uses the shift START; Early Logout the shift END.
  const { data: empPolicy } = useQuery({
    queryKey: [`${cfg.key}-shift`, f.employeeId],
    queryFn: () => lateLoginApi.policy({ employeeId: f.employeeId, requestType }).then(r => r.data),
    enabled: !isEdit && isHR && !!f.employeeId,
  });
  const shiftOf = (p) => (requestType === 'early_logout' ? p?.shiftEnd : p?.shiftStart);
  const shiftTime = (isEdit ? (editRecord.expectedTime || shiftOf(policy))
    : ((isHR && f.employeeId) ? shiftOf(empPolicy) : shiftOf(policy))) || '';

  const backdatedDays = Number(policy?.backdatedDays) || 30;
  const minDate = format(subDays(new Date(), backdatedDays), 'yyyy-MM-dd');
  const maxDate = policy?.allowFuture ? undefined : todayStr;

  const diff = (shiftTime && f.actualTime) ? permMin(requestType, shiftTime, f.actualTime) : null;
  // 0 = on the shift boundary (not late / not early); > 2h = must apply for leave.
  const timeError = (diff === 0) ? (requestType === 'early_logout' ? 'Logout Time must be earlier than Shift End Time.' : 'Late Login Time must be later than Shift Start Time.')
    : (diff != null && diff > MAX_MIN) ? LIMIT_MSG : '';

  const mut = useMutation({
    mutationFn: () => (isEdit
      ? requestLifecycleApi.edit(requestType, editRecord.id, { date: f.date, actualTime: f.actualTime, reason: f.reason, remarks: f.remarks, expectedTime: shiftTime })
      : lateLoginApi.create({ ...f, expectedTime: shiftTime, requestType })),
    onSuccess: (res) => {
      const warning = res?.data?.warning;
      if (warning) toast(warning, { icon: '⚠️', duration: 6000 });
      else toast.success(isEdit ? `${cfg.title} updated` : `${cfg.title} submitted`);
      qc.invalidateQueries({ queryKey: [cfg.key] });
      onClose();
    },
    onError: (e) => toast.error(e.response?.data?.error || (isEdit ? 'Failed to update' : 'Failed to submit')),
  });
  const invalid = (isHR && !isEdit && !f.employeeId) || !f.date || !shiftTime || !f.actualTime || !f.reason.trim() || !!timeError;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4 overflow-y-auto">
      <div className="bg-white w-full max-w-md rounded-2xl shadow-2xl my-8">
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
          <h2 className="text-lg font-bold text-gray-900">{isEdit ? cfg.modalEdit : cfg.modalNew}</h2>
          <button onClick={onClose} className="p-2 text-gray-400 hover:bg-gray-100 rounded-lg"><XMarkIcon className="w-5 h-5" /></button>
        </div>
        <div className="p-6 space-y-4">
          <div className="text-xs text-gray-500 space-y-1">
            <p>Max <b>2 hours</b> per request; for longer, please apply for Leave.</p>
            <p>Monthly policy (per type): first <b>2 auto-approved</b> · <b>3rd</b> needs manager approval · <b>4th+</b> deducts <b>0.5 day CL</b> (HR review if CL is insufficient; salary deduction deferred).</p>
            {policy?.usage && <p className="font-semibold text-gray-700">This month: {policy.usage.used} used · {policy.usage.autoRemaining} automatic {policy.usage.autoRemaining === 1 ? 'permission' : 'permissions'} remaining.</p>}
          </div>
          {isHR && !isEdit && (
            <div><label className="block text-xs font-semibold text-gray-600 mb-1">Employee</label>
              <select className={inp} value={f.employeeId} onChange={e => setF(p => ({ ...p, employeeId: e.target.value }))}>
                <option value="">Select employee…</option>
                {employees.map(e => <option key={e.hr_hremployeeid} value={e.hr_hremployeeid}>{e.hr_hremployee1}</option>)}
              </select></div>
          )}
          <div><label className="block text-xs font-semibold text-gray-600 mb-1">Date</label>
            <input type="date" min={minDate} max={maxDate} className={inp} value={f.date} onChange={e => setF(p => ({ ...p, date: e.target.value }))} /></div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="flex items-center justify-between text-xs font-semibold text-gray-600 mb-1">
                <span>{cfg.shiftLabel}</span>
                <span className="text-[10px] font-medium text-indigo-500 bg-indigo-50 border border-indigo-100 rounded px-1.5 py-0.5">Auto</span>
              </label>
              <input readOnly value={to12h(shiftTime) || (isHR && !isEdit && !f.employeeId ? 'Select employee' : '—')}
                className={`${inp} bg-gray-100 text-gray-600 cursor-not-allowed`} />
            </div>
            <div>
              <label className="block text-xs font-semibold text-gray-600 mb-1">{cfg.timeLabel}</label>
              <input type="time" className={`${inp} ${timeError ? 'border-red-300 ring-2 ring-red-500/20' : ''}`} value={f.actualTime} onChange={e => setF(p => ({ ...p, actualTime: e.target.value }))} />
            </div>
          </div>
          {timeError ? (
            <p className="text-xs font-semibold text-red-600">{timeError}</p>
          ) : (shiftTime && f.actualTime && diff > 0 && (
            <p className="text-xs font-semibold text-amber-700">{cfg.diffLabel}: {longDur(diff)}</p>
          ))}
          <div><label className="block text-xs font-semibold text-gray-600 mb-1">Reason</label>
            <input className={inp} value={f.reason} onChange={e => setF(p => ({ ...p, reason: e.target.value }))} placeholder={cfg.timePlaceholder} /></div>
          <div><label className="block text-xs font-semibold text-gray-600 mb-1">Remarks (optional)</label>
            <input className={inp} value={f.remarks} onChange={e => setF(p => ({ ...p, remarks: e.target.value }))} /></div>
        </div>
        <div className="flex justify-end gap-3 px-6 py-4 border-t border-gray-100">
          <button onClick={onClose} className="px-4 py-2 text-sm text-gray-600">Cancel</button>
          <Button onClick={() => mut.mutate()} loading={mut.isPending} disabled={invalid}>{isEdit ? 'Save' : 'Submit'}</Button>
        </div>
      </div>
    </div>
  );
}

export default function LateLoginPage({ requestType = 'late_login' } = {}) {
  const cfg = CFG[requestType] || CFG.late_login;
  const qc = useQueryClient();
  const { user, isHR } = useAuth();
  const hr = isHR();   // HR scope (see-all vs own); HR also decides 3rd-event (manager_pending) requests
  const [show, setShow] = useState(false);
  const [editRec, setEditRec] = useState(null);   // the record being edited (employee, own)
  const [period, setPeriod] = useState('this_month');
  const [statusF, setStatusF] = useState('');
  const [deptF, setDeptF] = useState('');

  const { data: policyRes } = useQuery({ queryKey: [`${cfg.key}-policy`], queryFn: () => lateLoginApi.policy({ requestType }).then(r => r.data) });
  const policy = policyRes || {};
  const { data: empRes } = useQuery({ queryKey: ['employees-all'], queryFn: () => employeeApi.list({ limit: 500, status: 'active' }), enabled: hr });
  const employees = empRes?.data?.data || empRes?.data || [];
  const { data: deptRes } = useQuery({ queryKey: ['departments-list'], queryFn: () => employeeApi.departments(), enabled: hr });
  const departments = (deptRes?.data?.data || deptRes?.data || []).map(d => (typeof d === 'string' ? d : (d?.name || d?.hr_name || d?.department))).filter(Boolean);

  const monthParam = (() => {
    const now = new Date();
    if (period === 'this_month') return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    if (period === 'last_month') { const d = new Date(now.getFullYear(), now.getMonth() - 1, 1); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; }
    return undefined;
  })();
  const params = { month: monthParam, status: statusF || undefined, department: deptF || undefined, requestType };
  const { data: listRes, isLoading } = useQuery({ queryKey: [cfg.key, period, statusF, deptF], queryFn: () => lateLoginApi.list(params).then(r => r.data) });
  const rows = useMemo(() => listRes?.data || [], [listRes]);

  // HR/Admin decision on a 3rd (manager_pending) permission.
  const decide = useMutation({
    mutationFn: ({ id, action }) => (action === 'approve' ? lateLoginApi.approve(id) : lateLoginApi.reject(id)),
    onSuccess: (_r, v) => { toast.success(`Request ${v.action === 'approve' ? 'approved' : 'rejected'}`); qc.invalidateQueries({ queryKey: [cfg.key] }); },
    onError: (e) => toast.error(e.response?.data?.error || 'Action failed'),
  });

  const counts = useMemo(() => ({
    total: rows.length,
    submitted: rows.filter(r => r.status === 'submitted').length,
    completed: rows.filter(r => r.status === 'completed').length,
  }), [rows]);

  const doExport = async (fmtType) => {
    try {
      const res = await lateLoginApi.export({ ...params, format: fmtType });
      const url = URL.createObjectURL(new Blob([res.data]));
      const a = document.createElement('a'); a.href = url; a.download = `${cfg.file}.${fmtType === 'csv' ? 'csv' : 'xlsx'}`; a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch { toast.error('Export failed'); }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 tracking-tight">{cfg.title}</h1>
          <p className="text-sm text-gray-500 mt-1">{cfg.lead}</p>
        </div>
        <Button icon={PlusIcon} onClick={() => setShow(true)}>{hr ? cfg.raise : cfg.request}</Button>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-3 gap-3 max-w-lg">
        {[{ label: 'Total', v: counts.total, a: 'text-gray-900' }, { label: 'Submitted', v: counts.submitted, a: 'text-blue-600' }, { label: 'Completed', v: counts.completed, a: 'text-emerald-600' }].map(c => (
          <div key={c.label} className="bg-white rounded-xl border border-gray-100 shadow-sm p-4">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-gray-400">{c.label}</p>
            <p className={`text-2xl font-bold mt-1 ${c.a}`}>{c.v}</p>
          </div>
        ))}
      </div>

      {/* Filters + export */}
      <div className="flex flex-wrap items-center gap-2">
        <select value={period} onChange={e => setPeriod(e.target.value)} className="h-10 px-3 bg-white border border-gray-200 rounded-lg text-sm">
          <option value="this_month">Current Month</option>
          <option value="last_month">Previous Month</option>
          <option value="all">All Time</option>
        </select>
        <select value={statusF} onChange={e => setStatusF(e.target.value)} className="h-10 px-3 bg-white border border-gray-200 rounded-lg text-sm">
          <option value="">All Status</option>
          <option value="auto_approved">Auto-approved</option><option value="manager_pending">Pending Approval</option><option value="manager_approved">Approved</option>
          <option value="cl_deducted">CL Deducted</option><option value="hr_review">HR Review</option><option value="manager_rejected">Rejected</option>
          <option value="submitted">Submitted</option><option value="completed">Completed</option><option value="absent_leave_required">Absent - Leave Required</option><option value="cancelled">Cancelled</option>
        </select>
        {hr && (
          <select value={deptF} onChange={e => setDeptF(e.target.value)} className="h-10 px-3 bg-white border border-gray-200 rounded-lg text-sm">
            <option value="">All Departments</option>
            {departments.map(d => <option key={d} value={d}>{d}</option>)}
          </select>
        )}
        <div className="ml-auto flex gap-2">
          <button onClick={() => doExport('xlsx')} className="inline-flex items-center gap-1.5 h-10 px-3 bg-white border border-gray-200 rounded-lg text-sm font-semibold text-emerald-700 hover:bg-emerald-50"><ArrowDownTrayIcon className="w-4 h-4" /> Excel</button>
          <button onClick={() => doExport('csv')} className="inline-flex items-center gap-1.5 h-10 px-3 bg-white border border-gray-200 rounded-lg text-sm font-semibold text-gray-700 hover:bg-gray-50"><ArrowDownTrayIcon className="w-4 h-4" /> CSV</button>
        </div>
      </div>

      <div className="bg-white rounded-xl border border-gray-100 shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-gray-500">
              <tr className="text-left">
                {hr && <th className="px-4 py-3 font-semibold">Employee</th>}
                <th className="px-4 py-3 font-semibold">Date</th>
                <th className="px-4 py-3 font-semibold">{cfg.colShift}</th>
                <th className="px-4 py-3 font-semibold">{cfg.colTime}</th>
                <th className="px-4 py-3 font-semibold">{cfg.diffLabel}</th>
                <th className="px-4 py-3 font-semibold">Reason</th>
                <th className="px-4 py-3 font-semibold">Status</th>
                <th className="px-4 py-3 font-semibold text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {isLoading ? (
                <tr><td colSpan={hr ? 8 : 7} className="px-4 py-10 text-center text-gray-400">Loading…</td></tr>
              ) : rows.length === 0 ? (
                <tr><td colSpan={hr ? 8 : 7} className="px-4 py-10 text-center text-gray-400">No {cfg.title.toLowerCase()} records.</td></tr>
              ) : rows.map(r => {
                const d = permMin(requestType, r.expectedTime, r.actualTime);
                return (
                <tr key={r.id} className="hover:bg-gray-50/50">
                  {hr && <td className="px-4 py-3 font-medium text-gray-800">{r.employeeName || '—'}</td>}
                  <td className="px-4 py-3 text-gray-600">{fmt(r.date)}</td>
                  <td className="px-4 py-3 font-mono text-gray-600">{to12h(r.expectedTime) || '—'}</td>
                  <td className="px-4 py-3 font-mono text-gray-600">{to12h(r.actualTime) || '—'}</td>
                  <td className="px-4 py-3 font-mono text-gray-600">{d > 0 ? compact(d) : '—'}</td>
                  <td className="px-4 py-3 text-gray-500 max-w-[14rem] truncate" title={r.reason}>{r.reason || '—'}</td>
                  <td className="px-4 py-3">
                    <span className={`inline-flex text-[11px] font-semibold border px-2 py-0.5 rounded-full ${STATUS[r.status] || STATUS.submitted}`}>{STATUS_LABEL[r.status] || r.status}</span>
                    {String(r.createdBy || '').includes('(auto)') && <span className="ml-1 inline-flex text-[10px] font-medium text-gray-500 bg-gray-100 border border-gray-200 px-1.5 py-0.5 rounded-full" title="Detected from the attendance punch — no permission request was submitted">Punch-only</span>}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-1.5 justify-end">
                      {hr && r.status === 'manager_pending' ? (
                        <>
                          <button onClick={() => decide.mutate({ id: r.id, action: 'approve' })} disabled={decide.isPending}
                            className="px-2 py-1 text-xs font-semibold rounded-lg bg-emerald-50 text-emerald-700 hover:bg-emerald-100 disabled:opacity-50">Approve</button>
                          <button onClick={() => decide.mutate({ id: r.id, action: 'reject' })} disabled={decide.isPending}
                            className="px-2 py-1 text-xs font-semibold rounded-lg bg-red-50 text-red-700 hover:bg-red-100 disabled:opacity-50">Reject</button>
                        </>
                      ) : r.employeeId === user?.id ? (
                        <RequestLifecycleActions
                          type={requestType} id={r.id} status={canon(r)}
                          caps={{
                            canEdit: ['submitted', 'pending'].includes(r.status),
                            canDelete: ['submitted', 'pending'].includes(r.status),
                            canResubmit: false, canCancel: false,
                          }}
                          onEdit={() => setEditRec(r)}
                          invalidateKeys={[[cfg.key]]}
                        />
                      ) : (
                        <span className="text-xs text-gray-300">—</span>
                      )}
                    </div>
                  </td>
                </tr>
              ); })}
            </tbody>
          </table>
        </div>
      </div>

      {(show || editRec) && <SubmitModal requestType={requestType} cfg={cfg} isHR={hr} employees={employees} policy={policy} editRecord={editRec} onClose={() => { setShow(false); setEditRec(null); }} />}
    </div>
  );
}
