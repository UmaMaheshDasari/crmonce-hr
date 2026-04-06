import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { recruitmentApi } from '../../api/endpoints';
import { PlusIcon, XMarkIcon, BriefcaseIcon, ChevronRightIcon } from '@heroicons/react/24/outline';
import { useAuth } from '../../context/AuthContext';
import { format } from 'date-fns';
import toast from 'react-hot-toast';

const STAGES = ['applied', 'screening', 'interview', 'offer', 'hired', 'rejected'];
const STAGE_COLORS = {
  applied: 'badge-gray', screening: 'badge-blue', interview: 'badge-yellow',
  offer: 'badge-blue', hired: 'badge-green', rejected: 'badge-red',
};
const STAGE_BG = {
  applied: 'bg-slate-50', screening: 'bg-sky-50/60', interview: 'bg-amber-50/60',
  offer: 'bg-blue-50/60', hired: 'bg-emerald-50/60', rejected: 'bg-rose-50/60',
};
const STAGE_BORDER = {
  applied: 'border-slate-200', screening: 'border-sky-200', interview: 'border-amber-200',
  offer: 'border-blue-200', hired: 'border-emerald-200', rejected: 'border-rose-200',
};
const STATUS_DOT = {
  open: 'bg-emerald-400',
  closed: 'bg-gray-300',
  draft: 'bg-amber-400',
};

function NewJobModal({ onClose }) {
  const qc = useQueryClient();
  const [form, setForm] = useState({ hr_hrjob1: '', hr_department: '', hr_openings: 1, hr_closingdate: '', hr_description: '' });
  const mutation = useMutation({
    mutationFn: () => recruitmentApi.createJob(form),
    onSuccess: () => { toast.success('Job posted!'); qc.invalidateQueries(['jobs']); onClose(); },
    onError: () => toast.error('Failed to create job'),
  });
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg p-0 overflow-hidden animate-in fade-in duration-200">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-5 border-b border-gray-100">
          <div>
            <h2 className="text-lg font-semibold text-gray-900 tracking-tight">Post New Job</h2>
            <p className="text-sm text-gray-400 mt-0.5">Create a new open position</p>
          </div>
          <button onClick={onClose} className="p-2 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded-xl transition-all">
            <XMarkIcon className="w-5 h-5" />
          </button>
        </div>

        {/* Body */}
        <div className="px-6 py-5 space-y-5">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">Job Title</label>
            <input className="input" placeholder="e.g. Senior React Developer" value={form.hr_hrjob1}
              onChange={e => setForm(p => ({ ...p, hr_hrjob1: e.target.value }))} />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">Department</label>
            <input className="input" placeholder="e.g. Engineering" value={form.hr_department}
              onChange={e => setForm(p => ({ ...p, hr_department: e.target.value }))} />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">Openings</label>
              <input type="number" min={1} className="input" value={form.hr_openings}
                onChange={e => setForm(p => ({ ...p, hr_openings: Number(e.target.value) }))} />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">Closing Date</label>
              <input type="date" className="input" value={form.hr_closingdate}
                onChange={e => setForm(p => ({ ...p, hr_closingdate: e.target.value }))} />
            </div>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">Description</label>
            <textarea className="input h-28 resize-none" placeholder="Describe the role, responsibilities, and requirements..."
              value={form.hr_description} onChange={e => setForm(p => ({ ...p, hr_description: e.target.value }))} />
          </div>
        </div>

        {/* Footer */}
        <div className="flex gap-3 px-6 py-4 bg-gray-50/80 border-t border-gray-100">
          <button onClick={onClose} className="btn-secondary flex-1">Cancel</button>
          <button onClick={() => mutation.mutate()} disabled={!form.hr_hrjob1 || mutation.isLoading}
            className="btn-primary flex-1 flex items-center justify-center gap-2">
            {mutation.isLoading && <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />}
            Post Job
          </button>
        </div>
      </div>
    </div>
  );
}

export default function RecruitmentPage() {
  const { isHR } = useAuth();
  const qc = useQueryClient();
  const [showModal, setShowModal] = useState(false);
  const [selectedJob, setSelectedJob] = useState(null);
  const [view, setView] = useState('jobs'); // 'jobs' | 'pipeline'

  const { data: jobsData, isLoading: jobsLoading } = useQuery({
    queryKey: ['jobs'],
    queryFn: () => recruitmentApi.jobs(),
  });

  const { data: appsData, isLoading: appsLoading } = useQuery({
    queryKey: ['applications', selectedJob],
    queryFn: () => recruitmentApi.applications({ jobId: selectedJob || undefined }),
    enabled: view === 'pipeline',
  });

  const stageMutation = useMutation({
    mutationFn: ({ id, stage }) => recruitmentApi.updateStage(id, stage),
    onSuccess: () => { toast.success('Stage updated'); qc.invalidateQueries(['applications']); },
    onError: () => toast.error('Update failed'),
  });

  const jobs = jobsData?.data?.data || [];
  const applications = appsData?.data?.data || [];

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 tracking-tight">Recruitment</h1>
          <p className="text-gray-400 text-sm mt-1">{jobs.filter(j => j.hr_status === 'open').length} open positions</p>
        </div>
        <div className="flex items-center gap-3">
          {/* Segmented Control */}
          <div className="flex bg-gray-100/80 p-1 rounded-xl border border-gray-200/60">
            {[
              { key: 'jobs', label: 'Jobs' },
              { key: 'pipeline', label: 'Pipeline' },
            ].map(v => (
              <button key={v.key} onClick={() => setView(v.key)}
                className={`px-4 py-2 rounded-lg text-sm font-medium transition-all duration-200 ${
                  view === v.key
                    ? 'bg-white text-gray-900 shadow-sm ring-1 ring-gray-200/60'
                    : 'text-gray-500 hover:text-gray-700'
                }`}>
                {v.label}
              </button>
            ))}
          </div>
          {isHR() && (
            <button onClick={() => setShowModal(true)}
              className="btn-primary flex items-center gap-2 shadow-lg shadow-indigo-500/20 hover:shadow-xl hover:shadow-indigo-500/30 transition-all duration-200">
              <PlusIcon className="w-4 h-4" /> Post Job
            </button>
          )}
        </div>
      </div>

      {/* Jobs View */}
      {view === 'jobs' && (
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4">
          {jobsLoading ? (
            Array(6).fill(0).map((_, i) => (
              <div key={i} className="bg-white rounded-2xl border border-gray-200/60 h-44 animate-pulse">
                <div className="p-5 space-y-3">
                  <div className="flex justify-between">
                    <div className="w-10 h-10 bg-gray-100 rounded-xl" />
                    <div className="w-14 h-5 bg-gray-100 rounded-full" />
                  </div>
                  <div className="w-3/4 h-4 bg-gray-100 rounded-lg mt-4" />
                  <div className="w-1/2 h-3 bg-gray-100 rounded-lg" />
                </div>
              </div>
            ))
          ) : jobs.length === 0 ? (
            <div className="col-span-3 bg-white rounded-2xl border border-gray-200/60 p-16 text-center">
              <div className="w-14 h-14 bg-gray-100 rounded-2xl flex items-center justify-center mx-auto mb-4">
                <BriefcaseIcon className="w-7 h-7 text-gray-300" />
              </div>
              <p className="text-gray-400 font-medium">No jobs posted yet</p>
              <p className="text-gray-300 text-sm mt-1">Create your first job posting to get started</p>
            </div>
          ) : (
            jobs.map(job => (
              <div key={job.hr_hrjobid}
                className="group bg-white rounded-2xl border border-gray-200/60 p-5 hover:shadow-lg hover:shadow-gray-200/50 hover:-translate-y-0.5 transition-all duration-300 cursor-pointer"
                onClick={() => { setSelectedJob(job.hr_hrjobid); setView('pipeline'); }}>
                <div className="flex items-start justify-between">
                  <div className="w-10 h-10 bg-indigo-50 rounded-xl flex items-center justify-center flex-shrink-0 group-hover:bg-indigo-100 transition-colors">
                    <BriefcaseIcon className="w-5 h-5 text-indigo-600" />
                  </div>
                  <div className="flex items-center gap-1.5">
                    <span className={`w-2 h-2 rounded-full ${STATUS_DOT[job.hr_status] || 'bg-gray-300'}`} />
                    <span className="text-xs font-medium text-gray-500 capitalize">{job.hr_status}</span>
                  </div>
                </div>
                <h3 className="font-semibold text-gray-900 mt-4 text-base leading-snug">{job.hr_hrjob1}</h3>
                <div className="mt-2">
                  <span className="inline-flex items-center px-2.5 py-0.5 rounded-lg text-xs font-medium bg-gray-100 text-gray-600">
                    {job.hr_department}
                  </span>
                </div>
                <div className="flex items-center justify-between mt-4 pt-3 border-t border-gray-100">
                  <div className="flex items-center gap-3 text-xs text-gray-400">
                    <span className="flex items-center gap-1">
                      <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M15 19.128a9.38 9.38 0 002.625.372 9.337 9.337 0 004.121-.952 4.125 4.125 0 00-7.533-2.493M15 19.128v-.003c0-1.113-.285-2.16-.786-3.07M15 19.128v.106A12.318 12.318 0 018.624 21c-2.331 0-4.512-.645-6.374-1.766l-.001-.109a6.375 6.375 0 0111.964-3.07M12 6.375a3.375 3.375 0 11-6.75 0 3.375 3.375 0 016.75 0zm8.25 2.25a2.625 2.625 0 11-5.25 0 2.625 2.625 0 015.25 0z" />
                      </svg>
                      {job.hr_openings} opening{job.hr_openings > 1 ? 's' : ''}
                    </span>
                    {job.hr_closingdate && (
                      <span className="flex items-center gap-1">
                        <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M6.75 3v2.25M17.25 3v2.25M3 18.75V7.5a2.25 2.25 0 012.25-2.25h13.5A2.25 2.25 0 0121 7.5v11.25m-18 0A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75m-18 0v-7.5A2.25 2.25 0 015.25 9h13.5A2.25 2.25 0 0121 11.25v7.5" />
                        </svg>
                        {format(new Date(job.hr_closingdate), 'dd MMM')}
                      </span>
                    )}
                  </div>
                  <ChevronRightIcon className="w-4 h-4 text-gray-300 group-hover:text-indigo-400 transition-colors" />
                </div>
              </div>
            ))
          )}
        </div>
      )}

      {/* Pipeline / Kanban View */}
      {view === 'pipeline' && (
        <div className="space-y-5">
          {/* Filter Bar */}
          <div className="flex items-center gap-3 bg-white rounded-xl border border-gray-200/60 px-4 py-3">
            <select className="input w-auto !border-gray-200 !rounded-lg" value={selectedJob || ''} onChange={e => setSelectedJob(e.target.value || null)}>
              <option value="">All Jobs</option>
              {jobs.map(j => <option key={j.hr_hrjobid} value={j.hr_hrjobid}>{j.hr_hrjob1}</option>)}
            </select>
            <div className="h-5 w-px bg-gray-200" />
            <span className="text-sm text-gray-400">{applications.length} total applicants</span>
          </div>

          {/* Kanban Columns */}
          <div className="overflow-x-auto pb-4 -mx-2 px-2">
            <div className="flex gap-3 min-w-max">
              {STAGES.map(stage => {
                const stageApps = applications.filter(a => a.hr_stage === stage);
                return (
                  <div key={stage} className={`w-56 flex-shrink-0 rounded-2xl border ${STAGE_BORDER[stage]} ${STAGE_BG[stage]} p-3`}>
                    {/* Column Header */}
                    <div className="flex items-center justify-between mb-3 px-1">
                      <span className="text-sm font-semibold text-gray-700 capitalize">{stage}</span>
                      <span className="flex items-center justify-center min-w-[22px] h-[22px] rounded-full bg-white text-xs font-bold text-gray-500 shadow-sm border border-gray-200/60 px-1.5">
                        {stageApps.length}
                      </span>
                    </div>
                    {/* Cards */}
                    <div className="space-y-2">
                      {stageApps.map(app => (
                        <div key={app.hr_hrapplicationid}
                          className="bg-white rounded-xl p-3 shadow-sm border border-gray-200/40 hover:shadow-md hover:-translate-y-0.5 transition-all duration-200 cursor-grab">
                          <div className="flex items-center gap-2 mb-1">
                            <div className="w-6 h-6 rounded-full bg-gradient-to-br from-indigo-400 to-purple-500 flex items-center justify-center text-white text-xs font-bold flex-shrink-0">
                              {app.hr_candidatename?.charAt(0)?.toUpperCase() || '?'}
                            </div>
                            <p className="font-medium text-sm text-gray-800 truncate">{app.hr_candidatename}</p>
                          </div>
                          <p className="text-xs text-gray-400 truncate ml-8">{app.hr_email}</p>
                          {isHR() && stage !== 'hired' && stage !== 'rejected' && (
                            <div className="mt-2.5 ml-8">
                              <select className="w-full text-xs bg-gray-50 border border-gray-200 rounded-lg px-2 py-1.5 text-gray-600 focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-300 outline-none transition-all"
                                value={app.hr_stage}
                                onChange={e => stageMutation.mutate({ id: app.hr_hrapplicationid, stage: e.target.value })}>
                                {STAGES.map(s => <option key={s} value={s} className="capitalize">{s}</option>)}
                              </select>
                            </div>
                          )}
                        </div>
                      ))}
                      {stageApps.length === 0 && (
                        <div className="text-xs text-gray-300 text-center py-8 border-2 border-dashed border-gray-200/60 rounded-xl">
                          No applicants
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {showModal && <NewJobModal onClose={() => setShowModal(false)} />}
    </div>
  );
}
