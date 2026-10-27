import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { lateLoginApi } from '../../api/endpoints';
import { format, subDays } from 'date-fns';

// READ-ONLY HR/Admin integrity report. It never changes any balance, permission, or attendance —
// every finding requires human HR review. Backed by GET /attendance/late-login/integrity-report
// (dry-run reconciliation + read-only balance scan), gated on reports.view.

const CATEGORY_LABEL = {
  negative_cl_balance: 'Negative CL balance',
  legacy_penalty_requires_review: 'Legacy CL penalty — needs approved remediation',
};
const CATEGORY_STYLE = (needsAction) => (needsAction ? 'bg-red-50 text-red-700 border-red-200' : 'bg-gray-100 text-gray-500 border-gray-200');
const fmt = (d) => { try { return d ? format(new Date(d), 'dd-MM-yyyy') : '—'; } catch { return d || '—'; } };
const todayStr = new Date().toISOString().slice(0, 10);
const inp = 'h-10 px-3 bg-white border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20';

export default function LateLoginIntegrityPage() {
  const [from, setFrom] = useState(format(subDays(new Date(), 34), 'yyyy-MM-dd'));
  const [to, setTo] = useState(todayStr);
  const [eventType, setEventType] = useState('');
  const [category, setCategory] = useState('');
  const [page, setPage] = useState(1);
  const pageSize = 50;

  const params = { from, to, eventType: eventType || undefined, category: category || undefined, page, pageSize };
  const { data, isLoading, isError, error, isFetching } = useQuery({
    queryKey: ['late-login-integrity', from, to, eventType, category, page],
    queryFn: () => lateLoginApi.integrityReport(params).then(r => r.data),
    keepPreviousData: true,
  });

  const rep = data || {};
  const findings = rep.findings || [];
  const totalPages = Math.max(1, Math.ceil((rep.totalFindings || 0) / pageSize));

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900 tracking-tight">Late Login Integrity Report</h1>
        <p className="text-sm text-gray-500 mt-1">Read-only. These are current recomputed findings for HR review — nothing here changes any CL balance, permission, or attendance automatically.</p>
      </div>

      {/* Run-history availability banner */}
      {rep.runHistory && !rep.runHistory.available && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          <b>Daily run history: not tracked.</b> {rep.runHistory.note}
        </div>
      )}

      {/* Summary */}
      {rep.summary && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 max-w-3xl">
          {[
            { label: 'Total findings', v: rep.summary.total, a: 'text-gray-900' },
            { label: 'Need HR action', v: rep.summary.needsAction, a: 'text-red-600' },
            { label: 'Discovery truncated', v: rep.summary.truncated ? 'Yes' : 'No', a: rep.summary.truncated ? 'text-amber-600' : 'text-emerald-600' },
            { label: 'Partial run', v: rep.summary.partial ? 'Yes' : 'No', a: rep.summary.partial ? 'text-red-600' : 'text-emerald-600' },
          ].map(c => (
            <div key={c.label} className="bg-white rounded-xl border border-gray-100 shadow-sm p-4">
              <p className="text-[11px] font-semibold uppercase tracking-wider text-gray-400">{c.label}</p>
              <p className={`text-2xl font-bold mt-1 ${c.a}`}>{c.v}</p>
            </div>
          ))}
        </div>
      )}

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-2">
        <label className="text-sm text-gray-500">From</label>
        <input type="date" max={to} className={inp} value={from} onChange={e => { setFrom(e.target.value); setPage(1); }} />
        <label className="text-sm text-gray-500">To</label>
        <input type="date" max={todayStr} className={inp} value={to} onChange={e => { setTo(e.target.value); setPage(1); }} />
        <select className={inp} value={eventType} onChange={e => { setEventType(e.target.value); setPage(1); }}>
          <option value="">All types</option>
          <option value="late_login">Late Login</option>
          <option value="early_logout">Early Logout</option>
        </select>
        <select className={inp} value={category} onChange={e => { setCategory(e.target.value); setPage(1); }}>
          <option value="">All categories</option>
          {Object.keys(CATEGORY_LABEL).map(k => <option key={k} value={k}>{CATEGORY_LABEL[k]}</option>)}
        </select>
        {isFetching && <span className="text-xs text-indigo-500">Refreshing…</span>}
      </div>

      {/* Results */}
      <div className="bg-white rounded-xl border border-gray-100 shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-gray-500">
              <tr className="text-left">
                <th className="px-4 py-3 font-semibold">Category</th>
                <th className="px-4 py-3 font-semibold">Employee</th>
                <th className="px-4 py-3 font-semibold">Date</th>
                <th className="px-4 py-3 font-semibold">Type</th>
                <th className="px-4 py-3 font-semibold">Current net</th>
                <th className="px-4 py-3 font-semibold">Expected</th>
                <th className="px-4 py-3 font-semibold">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {isLoading ? (
                <tr><td colSpan={7} className="px-4 py-10 text-center text-gray-400">Loading…</td></tr>
              ) : isError ? (
                <tr><td colSpan={7} className="px-4 py-10 text-center text-red-500">{error?.response?.data?.error || 'Failed to load the report.'}</td></tr>
              ) : findings.length === 0 ? (
                <tr><td colSpan={7} className="px-4 py-10 text-center text-gray-400">No findings for this range — nothing needs review.</td></tr>
              ) : findings.map((f, i) => (
                <tr key={`${f.category}-${f.employeeId}-${f.date}-${i}`} className="hover:bg-gray-50/50">
                  <td className="px-4 py-3"><span className={`inline-flex text-[11px] font-semibold border px-2 py-0.5 rounded-full ${CATEGORY_STYLE(f.needsAction)}`}>{CATEGORY_LABEL[f.category] || f.category}</span></td>
                  <td className="px-4 py-3 text-gray-800">{f.employeeName || f.employeeId || '—'}</td>
                  <td className="px-4 py-3 text-gray-600">{f.category === 'negative_cl_balance' ? '—' : fmt(f.date)}</td>
                  <td className="px-4 py-3 text-gray-600">{f.eventType || '—'}</td>
                  <td className="px-4 py-3 font-mono text-gray-600">{f.category === 'negative_cl_balance' ? `${f.currentBalance} CL` : (f.currentNet ?? '—')}</td>
                  <td className="px-4 py-3 font-mono text-gray-600" title={f.expectedNetNote || ''}>{f.expectedNet != null ? f.expectedNet : (f.expectedNetNote ? '?' : '—')}</td>
                  <td className="px-4 py-3">{f.needsAction ? <span className="text-xs font-semibold text-red-600">Review</span> : <span className="text-xs text-gray-400">Auto</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {totalPages > 1 && (
          <div className="px-4 py-3 border-t border-gray-100 flex items-center justify-between">
            <span className="text-sm text-gray-400">Page {page} of {totalPages} · {rep.totalFindings} finding{rep.totalFindings === 1 ? '' : 's'}</span>
            <div className="flex gap-2">
              <button onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page === 1} className="px-3 py-1.5 text-sm border border-gray-200 rounded-lg disabled:opacity-40">Previous</button>
              <button onClick={() => setPage(p => Math.min(totalPages, p + 1))} disabled={page >= totalPages} className="px-3 py-1.5 text-sm border border-gray-200 rounded-lg disabled:opacity-40">Next</button>
            </div>
          </div>
        )}
      </div>

      {rep.balances && !rep.balances.available && (
        <p className="text-xs text-gray-400">Negative-balance scan: {rep.balances.note}</p>
      )}
      {rep.generatedAt && <p className="text-xs text-gray-300">Generated {new Date(rep.generatedAt).toLocaleString()} · {rep.dataSources?.discrepanciesAndFlags}</p>}
    </div>
  );
}
