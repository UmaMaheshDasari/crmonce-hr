import { useState, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { leaveOpeningApi, employeeApi } from '../../api/endpoints';
import Button from '../../components/Button';
import {
  ArrowUpTrayIcon, ClockIcon, XMarkIcon, InformationCircleIcon,
} from '@heroicons/react/24/outline';
import { format } from 'date-fns';
import toast from 'react-hot-toast';

const inp = 'w-full h-10 px-3 bg-gray-50 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-400';
const nowYear = new Date().getFullYear();
const fmtDT = (d) => { try { return d ? format(new Date(d), 'dd MMM yyyy, HH:mm') : '—'; } catch { return d || '—'; } };

// Edit-history drawer for one employee/year.
function AuditModal({ employeeId, year, employeeName, onClose }) {
  const { data } = useQuery({ queryKey: ['opening-audit', employeeId, year], queryFn: () => leaveOpeningApi.audit({ employeeId, year }).then(r => r.data) });
  const rows = data?.data || [];
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4 overflow-y-auto">
      <div className="bg-white w-full max-w-lg rounded-2xl shadow-2xl my-8">
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
          <div><h2 className="text-lg font-bold text-gray-900">Edit History</h2><p className="text-xs text-gray-400">{employeeName} · {year}</p></div>
          <button onClick={onClose} className="p-2 text-gray-400 hover:bg-gray-100 rounded-lg"><XMarkIcon className="w-5 h-5" /></button>
        </div>
        <div className="p-6 max-h-[60vh] overflow-y-auto">
          {rows.length === 0 ? <p className="text-sm text-gray-400 text-center py-8">No history yet.</p> : (
            <ol className="space-y-3">
              {rows.map(r => (
                <li key={r.id} className="border-l-2 border-indigo-200 pl-3">
                  <p className="text-sm text-gray-800"><span className="font-semibold">{r.field}</span>: <span className="text-gray-400 line-through">{r.oldValue || '—'}</span> → <span className="text-gray-900 font-medium">{r.newValue || '—'}</span></p>
                  <p className="text-xs text-gray-400">{r.action} by {r.updatedBy || '—'} · {fmtDT(r.updatedOn)}{r.reason ? ` · ${r.reason}` : ''}</p>
                </li>
              ))}
            </ol>
          )}
        </div>
      </div>
    </div>
  );
}

export default function LeaveOpeningBalancePage() {
  const qc = useQueryClient();
  const [year, setYear] = useState(nowYear);
  const [form, setForm] = useState({ employeeId: '', casualUsed: 0, sickUsed: 0, earnedUsed: 0, lopUsed: 0, compOff: 0, remarks: '', reason: '' });
  const [auditFor, setAuditFor] = useState(null);

  const { data: empRes } = useQuery({ queryKey: ['employees-lite'], queryFn: () => employeeApi.list({ limit: 500 }) });
  const employees = empRes?.data?.data || empRes?.data || [];
  const empName = (id) => employees.find(e => e.hr_hremployeeid === id)?.hr_hremployee1 || '';

  const { data: listRes, isLoading } = useQuery({ queryKey: ['leave-opening', year], queryFn: () => leaveOpeningApi.list({ year }).then(r => r.data) });
  const rows = listRes?.data || [];

  const existing = useMemo(() => rows.find(r => r.employeeId === form.employeeId), [rows, form.employeeId]);
  const isEdit = !!existing;

  // Prefill when picking an employee who already has an opening balance for the year.
  const pickEmployee = (id) => {
    const ex = rows.find(r => r.employeeId === id);
    if (ex) setForm({ employeeId: id, casualUsed: ex.casualUsed, sickUsed: ex.sickUsed, earnedUsed: ex.earnedUsed || 0, lopUsed: ex.lopUsed, compOff: ex.compOff, remarks: ex.remarks, reason: '' });
    else setForm({ employeeId: id, casualUsed: 0, sickUsed: 0, earnedUsed: 0, lopUsed: 0, compOff: 0, remarks: '', reason: '' });
  };

  const save = useMutation({
    mutationFn: () => {
      const payload = { ...form, year };
      return isEdit ? leaveOpeningApi.update(payload) : leaveOpeningApi.create(payload);
    },
    onSuccess: () => {
      toast.success(isEdit ? 'Opening balance updated' : 'Opening balance created');
      qc.invalidateQueries({ queryKey: ['leave-opening'] });
      qc.invalidateQueries({ queryKey: ['leave-balance'] });
    },
    onError: (e) => toast.error(e.response?.data?.error || 'Failed to save'),
  });

  const del = useMutation({
    mutationFn: (id) => leaveOpeningApi.remove(id),
    onSuccess: () => { toast.success('Removed'); qc.invalidateQueries({ queryKey: ['leave-opening'] }); qc.invalidateQueries({ queryKey: ['leave-balance'] }); },
    onError: (e) => toast.error(e.response?.data?.error || 'Failed'),
  });

  const invalid = !form.employeeId || (isEdit && !form.reason.trim());

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 tracking-tight">Leave Opening Balance</h1>
          <p className="text-sm text-gray-500 mt-1">One-time historical migration. Current Used = Opening Used + leaves taken in the system.</p>
        </div>
        <div className="flex items-center gap-2">
          <select value={year} onChange={e => { setYear(Number(e.target.value)); setForm(p => ({ ...p, employeeId: '' })); }} className="h-10 px-3 bg-white border border-gray-200 rounded-lg text-sm">
            {[nowYear + 1, nowYear, nowYear - 1, nowYear - 2].map(y => <option key={y} value={y}>{y}</option>)}
          </select>
          <Link to="/import-export" className="inline-flex items-center gap-1.5 h-10 px-3 bg-white border border-gray-200 rounded-lg text-sm font-semibold text-indigo-600 hover:bg-indigo-50">
            <ArrowUpTrayIcon className="w-4 h-4" /> Excel Import
          </Link>
        </div>
      </div>

      {/* Entry form */}
      <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-5">
        <div className="flex items-center gap-2 mb-4">
          <h2 className="text-sm font-bold text-gray-900">{isEdit ? 'Edit' : 'Add'} Opening Balance · {year}</h2>
          {isEdit && <span className="text-[11px] font-semibold text-amber-700 bg-amber-50 border border-amber-200 rounded-full px-2 py-0.5">Editing existing — reason required</span>}
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          <div><label className="block text-xs font-semibold text-gray-600 mb-1">Employee</label>
            <select className={inp} value={form.employeeId} onChange={e => pickEmployee(e.target.value)}>
              <option value="">Select employee…</option>
              {employees.map(e => <option key={e.hr_hremployeeid} value={e.hr_hremployeeid}>{e.hr_hremployee1}</option>)}
            </select></div>
          <div><label className="block text-xs font-semibold text-gray-600 mb-1">Casual Leave Already Used</label>
            <input type="number" step="0.5" min="0" className={inp} value={form.casualUsed} onChange={e => setForm(p => ({ ...p, casualUsed: e.target.value }))} /></div>
          <div><label className="block text-xs font-semibold text-gray-600 mb-1">Sick Leave Already Used</label>
            <input type="number" step="0.5" min="0" className={inp} value={form.sickUsed} onChange={e => setForm(p => ({ ...p, sickUsed: e.target.value }))} /></div>
          <div><label className="block text-xs font-semibold text-gray-600 mb-1">Earned Leave Already Used</label>
            <input type="number" step="0.5" min="0" className={inp} value={form.earnedUsed} onChange={e => setForm(p => ({ ...p, earnedUsed: e.target.value }))} /></div>
          <div><label className="block text-xs font-semibold text-gray-600 mb-1">LOP Already Used</label>
            <input type="number" step="0.5" min="0" className={inp} value={form.lopUsed} onChange={e => setForm(p => ({ ...p, lopUsed: e.target.value }))} /></div>
          <div><label className="block text-xs font-semibold text-gray-600 mb-1">Comp Off Balance</label>
            <input type="number" step="0.5" min="0" className={inp} value={form.compOff} onChange={e => setForm(p => ({ ...p, compOff: e.target.value }))} /></div>
          <div><label className="block text-xs font-semibold text-gray-600 mb-1">Remarks</label>
            <input className={inp} value={form.remarks} onChange={e => setForm(p => ({ ...p, remarks: e.target.value }))} placeholder="e.g. Imported from Excel" /></div>
          {isEdit && (
            <div className="lg:col-span-3"><label className="block text-xs font-semibold text-gray-600 mb-1">Reason for change (audited)</label>
              <input className={inp} value={form.reason} onChange={e => setForm(p => ({ ...p, reason: e.target.value }))} placeholder="Why is this opening balance being changed?" /></div>
          )}
        </div>
        <div className="flex items-center justify-between mt-4">
          <p className="text-xs text-gray-400 flex items-center gap-1.5"><InformationCircleIcon className="w-4 h-4" /> Default allocation: 12 Casual + 6 Sick. Remaining = Allocated − (Opening Used + in-system leaves).</p>
          <Button onClick={() => save.mutate()} loading={save.isPending} disabled={invalid}>{isEdit ? 'Update' : 'Create'} Opening Balance</Button>
        </div>
      </div>

      {/* Existing rows */}
      <div className="bg-white rounded-xl border border-gray-100 shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-gray-500">
              <tr className="text-left">
                <th className="px-4 py-3 font-semibold">Employee</th>
                <th className="px-4 py-3 font-semibold">Casual Used</th>
                <th className="px-4 py-3 font-semibold">Sick Used</th>
                <th className="px-4 py-3 font-semibold">Earned Used</th>
                <th className="px-4 py-3 font-semibold">LOP Used</th>
                <th className="px-4 py-3 font-semibold">Comp Off</th>
                <th className="px-4 py-3 font-semibold">Remarks</th>
                <th className="px-4 py-3 font-semibold text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {isLoading ? (
                <tr><td colSpan={8} className="px-4 py-10 text-center text-gray-400">Loading…</td></tr>
              ) : rows.length === 0 ? (
                <tr><td colSpan={8} className="px-4 py-10 text-center text-gray-400">No opening balances for {year}.</td></tr>
              ) : rows.map(r => (
                <tr key={r.id} className="hover:bg-gray-50/50">
                  <td className="px-4 py-3 font-medium text-gray-800">{r.employeeName || empName(r.employeeId) || '—'}</td>
                  <td className="px-4 py-3 text-gray-600">{r.casualUsed}</td>
                  <td className="px-4 py-3 text-gray-600">{r.sickUsed}</td>
                  <td className="px-4 py-3 text-gray-600">{r.earnedUsed || 0}</td>
                  <td className="px-4 py-3 text-gray-600">{r.lopUsed}</td>
                  <td className="px-4 py-3 text-gray-600">{r.compOff}</td>
                  <td className="px-4 py-3 text-gray-500 max-w-[14rem] truncate">{r.remarks || '—'}</td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-1.5 justify-end">
                      <button onClick={() => pickEmployee(r.employeeId)} className="px-2 py-1 text-xs font-semibold text-indigo-600 bg-indigo-50 rounded-lg hover:bg-indigo-100">Edit</button>
                      <button onClick={() => setAuditFor({ employeeId: r.employeeId, name: r.employeeName })} className="inline-flex items-center gap-1 px-2 py-1 text-xs font-semibold text-gray-600 bg-gray-100 rounded-lg hover:bg-gray-200"><ClockIcon className="w-3.5 h-3.5" /> History</button>
                      <button onClick={() => del.mutate(r.id)} className="px-2 py-1 text-xs font-semibold text-red-600 bg-red-50 rounded-lg hover:bg-red-100">Delete</button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {auditFor && <AuditModal employeeId={auditFor.employeeId} year={year} employeeName={auditFor.name} onClose={() => setAuditFor(null)} />}
    </div>
  );
}
