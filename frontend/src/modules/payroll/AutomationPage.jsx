import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { automationApi } from '../../api/endpoints';
import {
  BoltIcon, PlayIcon, ArrowPathIcon, CheckCircleIcon, XCircleIcon, ClockIcon,
  ChevronRightIcon, XMarkIcon,
} from '@heroicons/react/24/outline';
import toast from 'react-hot-toast';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const now = new Date();

// The visible pipeline (matches the automation flow).
const FLOW = ['Attendance', 'Leave Approval', 'Comp Off', 'LOP', 'Salary Calculation', 'Payroll', 'Payslip PDF', 'Employee Email', 'Activity Log', 'Notification'];

const JOB_BADGE = {
  running: 'bg-amber-50 text-amber-700 ring-amber-600/20',
  completed: 'bg-emerald-50 text-emerald-700 ring-emerald-600/20',
  partial: 'bg-orange-50 text-orange-700 ring-orange-600/20',
  failed: 'bg-red-50 text-red-700 ring-red-600/20',
};
const stageIcon = (status) =>
  status === 'success' ? <CheckCircleIcon className="w-5 h-5 text-emerald-500" />
    : status === 'failed' ? <XCircleIcon className="w-5 h-5 text-red-500" />
      : status === 'running' ? <ArrowPathIcon className="w-5 h-5 text-amber-500 animate-spin" />
        : <ClockIcon className="w-5 h-5 text-gray-300" />;

const fmt = (iso) => { if (!iso) return '—'; const d = new Date(iso); return isNaN(d) ? '—' : d.toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }); };

function RunModal({ onClose }) {
  const qc = useQueryClient();
  const [month, setMonth] = useState(now.getMonth() + 1);
  const [year, setYear] = useState(now.getFullYear());
  const mut = useMutation({
    mutationFn: () => automationApi.run({ month, year }),
    onSuccess: () => { toast.success('Automation started'); qc.invalidateQueries({ queryKey: ['automation-jobs'] }); onClose(); },
    onError: (e) => toast.error(e.response?.data?.error || 'Failed to start'),
  });
  const sel = 'w-full h-10 px-3 bg-gray-50 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-400';
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4">
      <div className="bg-white w-full max-w-sm rounded-2xl shadow-2xl">
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
          <h2 className="text-lg font-bold text-gray-900">Run Payroll Automation</h2>
          <button onClick={onClose} className="p-2 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded-lg"><XMarkIcon className="w-5 h-5" /></button>
        </div>
        <div className="p-6 space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1"><label className="block text-xs font-semibold text-gray-600">Month</label>
              <select value={month} onChange={e => setMonth(Number(e.target.value))} className={sel}>{MONTHS.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}</select></div>
            <div className="space-y-1"><label className="block text-xs font-semibold text-gray-600">Year</label>
              <select value={year} onChange={e => setYear(Number(e.target.value))} className={sel}>{[now.getFullYear(), now.getFullYear() - 1].map(y => <option key={y} value={y}>{y}</option>)}</select></div>
          </div>
          <p className="text-xs text-gray-500 bg-gray-50 rounded-lg px-3 py-2">Generates payroll, emails payslips and notifies employees. Locked months are skipped; approved rows are not regenerated.</p>
          <div className="flex justify-end gap-3">
            <button onClick={onClose} className="px-4 py-2 text-sm text-gray-600">Cancel</button>
            <button onClick={() => mut.mutate()} disabled={mut.isPending} className="px-5 py-2.5 bg-indigo-600 text-white text-sm font-medium rounded-xl hover:bg-indigo-700 disabled:opacity-50">{mut.isPending ? 'Starting…' : 'Run Now'}</button>
          </div>
        </div>
      </div>
    </div>
  );
}

function JobDrawer({ jobId, onClose }) {
  const qc = useQueryClient();
  const { data } = useQuery({
    queryKey: ['automation-job', jobId], queryFn: () => automationApi.job(jobId),
    refetchInterval: (q) => (q.state.data?.data?.status === 'running' ? 2500 : false),
  });
  const job = data?.data;
  const retry = useMutation({
    mutationFn: () => automationApi.retry(jobId),
    onSuccess: () => { toast.success('Retry started'); qc.invalidateQueries({ queryKey: ['automation-job', jobId] }); qc.invalidateQueries({ queryKey: ['automation-jobs'] }); },
    onError: (e) => toast.error(e.response?.data?.error || 'Retry failed'),
  });
  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/40 backdrop-blur-sm">
      <div className="bg-gray-50 w-full max-w-lg h-full overflow-y-auto shadow-2xl">
        <div className="flex items-center justify-between px-6 py-4 bg-white border-b border-gray-100 sticky top-0 z-10">
          <div><h2 className="text-lg font-bold text-gray-900">{job?.name || 'Job'}</h2>
            {job && <span className={`inline-flex px-2 py-0.5 rounded-full text-[10px] font-semibold uppercase ring-1 ${JOB_BADGE[job.status] || JOB_BADGE.running}`}>{job.status}</span>}</div>
          <div className="flex items-center gap-2">
            {job && (job.status === 'failed' || job.status === 'partial') && (
              <button onClick={() => retry.mutate()} disabled={retry.isPending} className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-semibold text-indigo-600 bg-indigo-50 rounded-lg hover:bg-indigo-100 disabled:opacity-50"><ArrowPathIcon className="w-4 h-4" /> Retry failed</button>
            )}
            <button onClick={onClose} className="p-2 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded-lg"><XMarkIcon className="w-5 h-5" /></button>
          </div>
        </div>

        {!job ? <div className="p-8 text-center text-gray-400">Loading…</div> : (
          <div className="p-6 space-y-5">
            {/* Stages */}
            <div className="space-y-2">
              {job.stages.map((s) => (
                <div key={s.key} className="bg-white rounded-xl border border-gray-100 p-3 flex items-start gap-3">
                  {stageIcon(s.status)}
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-semibold text-gray-900">{s.label}</p>
                    <p className="text-xs text-gray-500">{s.message || (s.status === 'pending' ? 'Waiting…' : s.status)}</p>
                  </div>
                  {s.critical && <span className="text-[10px] text-gray-300 font-semibold uppercase">critical</span>}
                </div>
              ))}
            </div>

            {/* Processing log */}
            <div>
              <p className="text-xs font-bold uppercase tracking-wider text-gray-400 mb-2">Processing Log</p>
              <div className="bg-gray-900 rounded-xl p-3 max-h-72 overflow-y-auto font-mono text-[11px] leading-relaxed">
                {(job.logs || []).map((l, i) => (
                  <div key={i} className={l.level === 'error' ? 'text-red-400' : l.level === 'warn' ? 'text-amber-300' : 'text-gray-300'}>
                    <span className="text-gray-500">{fmt(l.ts)}</span> {l.message}
                  </div>
                ))}
                {(!job.logs || !job.logs.length) && <div className="text-gray-500">No log entries.</div>}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export default function AutomationPage() {
  const [showRun, setShowRun] = useState(false);
  const [openJob, setOpenJob] = useState(null);
  const { data, isLoading } = useQuery({
    queryKey: ['automation-jobs'], queryFn: () => automationApi.jobs(),
    refetchInterval: (q) => ((q.state.data?.data?.data || []).some(j => j.status === 'running') ? 4000 : false),
  });
  const jobs = data?.data?.data || [];

  return (
    <div className="space-y-5">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 bg-gradient-to-br from-indigo-500 to-indigo-700 rounded-xl flex items-center justify-center shadow-lg shadow-indigo-500/20"><BoltIcon className="w-5 h-5 text-white" /></div>
          <div>
            <h1 className="text-2xl font-bold text-gray-900 tracking-tight">Payroll Automation</h1>
            <p className="text-sm text-gray-400">Run the full pipeline end-to-end, track every stage, and retry failed jobs.</p>
          </div>
        </div>
        <button onClick={() => setShowRun(true)} className="inline-flex items-center gap-2 px-4 py-2.5 bg-gradient-to-r from-indigo-600 to-indigo-700 text-white text-sm font-medium rounded-xl hover:from-indigo-700 hover:to-indigo-800 shadow-lg shadow-indigo-500/25 self-start"><PlayIcon className="w-4.5 h-4.5" /> Run Automation</button>
      </div>

      {/* Pipeline flow */}
      <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5">
        <p className="text-xs font-bold uppercase tracking-wider text-gray-400 mb-3">Pipeline</p>
        <div className="flex flex-wrap items-center gap-x-1 gap-y-2">
          {FLOW.map((step, i) => (
            <span key={step} className="inline-flex items-center">
              <span className="px-3 py-1.5 bg-indigo-50 text-indigo-700 rounded-lg text-xs font-medium whitespace-nowrap">{step}</span>
              {i < FLOW.length - 1 && <ChevronRightIcon className="w-4 h-4 text-gray-300 mx-0.5" />}
            </span>
          ))}
        </div>
      </div>

      {/* Job history */}
      <div className="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden">
        <div className="px-5 py-4 border-b border-gray-50"><h3 className="text-sm font-bold text-gray-900">Job History</h3></div>
        {isLoading ? (
          <div className="p-10 text-center text-gray-400">Loading…</div>
        ) : jobs.length === 0 ? (
          <div className="p-16 text-center">
            <BoltIcon className="w-12 h-12 text-gray-200 mx-auto mb-3" />
            <p className="text-sm text-gray-500">No automation runs yet. Click "Run Automation" to start.</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 text-xs text-gray-500">
                <tr>
                  <th className="px-5 py-3 text-left font-semibold">Run</th>
                  <th className="px-5 py-3 text-left font-semibold">Status</th>
                  <th className="px-5 py-3 text-left font-semibold">Stages</th>
                  <th className="px-5 py-3 text-left font-semibold">Trigger</th>
                  <th className="px-5 py-3 text-left font-semibold">Started</th>
                  <th className="px-5 py-3"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {jobs.map((j) => {
                  const done = (j.stages || []).filter(s => s.status === 'success').length;
                  const total = (j.stages || []).length || 5;
                  return (
                    <tr key={j.id} className="hover:bg-gray-50/50 cursor-pointer" onClick={() => setOpenJob(j.id)}>
                      <td className="px-5 py-3 font-medium text-gray-900">{j.name}</td>
                      <td className="px-5 py-3"><span className={`inline-flex px-2 py-0.5 rounded-full text-[10px] font-semibold uppercase ring-1 ${JOB_BADGE[j.status] || JOB_BADGE.running}`}>{j.status === 'running' && <ArrowPathIcon className="w-3 h-3 mr-1 animate-spin" />}{j.status}</span></td>
                      <td className="px-5 py-3 text-gray-500">{done}/{total}</td>
                      <td className="px-5 py-3 text-gray-500 capitalize">{j.trigger}</td>
                      <td className="px-5 py-3 text-gray-500">{fmt(j.startedOn)}</td>
                      <td className="px-5 py-3 text-right"><ChevronRightIcon className="w-4 h-4 text-gray-300" /></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {showRun && <RunModal onClose={() => setShowRun(false)} />}
      {openJob && <JobDrawer jobId={openJob} onClose={() => setOpenJob(null)} />}
    </div>
  );
}
