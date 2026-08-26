import { useState, useCallback, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { documentApi, employeeApi } from '../../api/endpoints';
import { useDropzone } from 'react-dropzone';
import { TrashIcon, ArrowDownTrayIcon, CloudArrowUpIcon, XMarkIcon, FunnelIcon, EyeIcon, MagnifyingGlassIcon, CheckBadgeIcon } from '@heroicons/react/24/outline';
import { useAuth } from '../../context/AuthContext';
import { useDocumentViewer } from '../../components/DocumentViewer';
import { format } from 'date-fns';
import toast from 'react-hot-toast';

const DOC_TYPES = ['Offer Letter', 'Contract', 'ID Proof', 'Payslip', 'Certificate', 'Other'];

// SVG file type icons
function FileIcon({ name, className = 'w-10 h-10' }) {
  const ext = name?.split('.').pop()?.toLowerCase();
  if (ext === 'pdf') {
    return (
      <div className={`${className} rounded-xl bg-red-50 flex items-center justify-center flex-shrink-0`}>
        <svg className="w-5 h-5 text-red-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" />
          <text x="8" y="18" fill="currentColor" fontSize="6" fontWeight="bold" fontFamily="sans-serif">PDF</text>
        </svg>
      </div>
    );
  }
  if (ext === 'doc' || ext === 'docx') {
    return (
      <div className={`${className} rounded-xl bg-blue-50 flex items-center justify-center flex-shrink-0`}>
        <svg className="w-5 h-5 text-blue-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" />
        </svg>
      </div>
    );
  }
  if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg'].includes(ext)) {
    return (
      <div className={`${className} rounded-xl bg-emerald-50 flex items-center justify-center flex-shrink-0`}>
        <svg className="w-5 h-5 text-emerald-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 15.75l5.159-5.159a2.25 2.25 0 013.182 0l5.159 5.159m-1.5-1.5l1.409-1.409a2.25 2.25 0 013.182 0l2.909 2.909M3.75 21h16.5A2.25 2.25 0 0022.5 18.75V5.25A2.25 2.25 0 0020.25 3H3.75A2.25 2.25 0 001.5 5.25v13.5A2.25 2.25 0 003.75 21z" />
        </svg>
      </div>
    );
  }
  return (
    <div className={`${className} rounded-xl bg-gray-100 flex items-center justify-center flex-shrink-0`}>
      <svg className="w-5 h-5 text-gray-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" />
      </svg>
    </div>
  );
}

function FileIconSmall({ name }) {
  const ext = name?.split('.').pop()?.toLowerCase();
  const colors = {
    pdf: 'text-red-500', doc: 'text-blue-500', docx: 'text-blue-500',
    jpg: 'text-emerald-500', jpeg: 'text-emerald-500', png: 'text-emerald-500',
  };
  return (
    <svg className={`w-5 h-5 ${colors[ext] || 'text-gray-400'}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" />
    </svg>
  );
}

const formatSize = (bytes) => bytes < 1024*1024 ? `${(bytes/1024).toFixed(1)} KB` : `${(bytes/(1024*1024)).toFixed(1)} MB`;

const TYPE_TAG_COLORS = {
  'Offer Letter': 'bg-emerald-50 text-emerald-700 border-emerald-200/60',
  'Contract': 'bg-blue-50 text-blue-700 border-blue-200/60',
  'ID Proof': 'bg-amber-50 text-amber-700 border-amber-200/60',
  'Payslip': 'bg-violet-50 text-violet-700 border-violet-200/60',
  'Certificate': 'bg-cyan-50 text-cyan-700 border-cyan-200/60',
  'Other': 'bg-gray-50 text-gray-600 border-gray-200/60',
};

const STATUS_BADGE = {
  verified: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  pending: 'bg-amber-50 text-amber-700 border-amber-200',
  rejected: 'bg-red-50 text-red-700 border-red-200',
  reupload: 'bg-orange-50 text-orange-700 border-orange-200',
  superseded: 'bg-gray-100 text-gray-500 border-gray-200',
};
const STATUS_LABEL = { verified: 'Verified', pending: 'Pending', rejected: 'Rejected', reupload: 'Re-upload', superseded: 'Superseded' };

function UploadModal({ onClose }) {
  const qc = useQueryClient();
  const { user, isHR } = useAuth();
  const [empId, setEmpId] = useState(isHR() ? '' : user.id);
  const [type, setType] = useState('Other');
  const [files, setFiles] = useState([]);

  const { data: empData } = useQuery({
    queryKey: ['employees-all'],
    queryFn: () => employeeApi.list({ limit: 500, status: 'active' }),
    enabled: isHR(),
  });

  const onDrop = useCallback(accepted => setFiles(prev => [...prev, ...accepted]), []);
  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop, accept: { 'application/pdf': [], 'application/msword': [], 'application/vnd.openxmlformats-officedocument.wordprocessingml.document': [], 'image/*': [] },
    maxSize: 10 * 1024 * 1024,
  });

  const mutation = useMutation({
    mutationFn: async () => {
      for (const file of files) {
        const fd = new FormData();
        fd.append('file', file);
        fd.append('employeeId', empId);
        fd.append('documentType', type);   // backend reads `documentType`
        fd.append('name', file.name);
        await documentApi.upload(fd);
      }
    },
    onSuccess: () => { toast.success(`${files.length} document(s) uploaded!`); qc.invalidateQueries({ queryKey: ['documents'] }); onClose(); },
    onError: () => toast.error('Upload failed'),
  });

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg max-h-[calc(100dvh-2rem)] overflow-x-hidden overflow-y-auto animate-in fade-in duration-200">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-5 border-b border-gray-100">
          <div>
            <h2 className="text-lg font-semibold text-gray-900 tracking-tight">Upload Documents</h2>
            <p className="text-sm text-gray-400 mt-0.5">Add files to your document vault</p>
          </div>
          <button onClick={onClose} className="p-2 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded-xl transition-all">
            <XMarkIcon className="w-5 h-5" />
          </button>
        </div>

        {/* Body */}
        <div className="px-6 py-5 space-y-5">
          {isHR() && (
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">Employee</label>
              <select className="input" value={empId} onChange={e => setEmpId(e.target.value)}>
                <option value="">Select employee</option>
                {empData?.data?.data?.map(e => <option key={e.hr_hremployeeid} value={e.hr_hremployeeid}>{e.hr_hremployee1}</option>)}
              </select>
            </div>
          )}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">Document Type</label>
            <select className="input" value={type} onChange={e => setType(e.target.value)}>
              {DOC_TYPES.map(t => <option key={t}>{t}</option>)}
            </select>
          </div>

          {/* Premium Dropzone */}
          <div {...getRootProps()}
            className={`relative border-2 border-dashed rounded-2xl p-10 text-center cursor-pointer transition-all duration-200 ${
              isDragActive
                ? 'border-indigo-400 bg-indigo-50/50'
                : 'border-gray-200 hover:border-indigo-300 hover:bg-gray-50/50'
            }`}>
            <input {...getInputProps()} />
            <div className={`w-14 h-14 rounded-2xl mx-auto mb-3 flex items-center justify-center transition-colors ${
              isDragActive ? 'bg-indigo-100' : 'bg-gray-100'
            }`}>
              <CloudArrowUpIcon className={`w-7 h-7 transition-colors ${isDragActive ? 'text-indigo-500' : 'text-gray-400'}`} />
            </div>
            <p className="text-sm font-medium text-gray-600">
              {isDragActive ? 'Drop files here...' : 'Drag & drop or click to upload'}
            </p>
            <p className="text-xs text-gray-400 mt-1.5">PDF, DOC, DOCX, JPG, PNG -- Max 10MB per file</p>
          </div>

          {/* Selected Files with progress bar style */}
          {files.length > 0 && (
            <div className="space-y-2">
              <p className="text-xs font-medium text-gray-500 uppercase tracking-wider">{files.length} file{files.length > 1 ? 's' : ''} selected</p>
              {files.map((f, i) => (
                <div key={i} className="flex items-center gap-3 bg-gray-50 rounded-xl px-4 py-3 border border-gray-100">
                  <FileIconSmall name={f.name} />
                  <div className="flex-1 overflow-hidden">
                    <p className="text-sm font-medium text-gray-800 truncate">{f.name}</p>
                    <div className="flex items-center gap-2 mt-1">
                      <p className="text-xs text-gray-400">{formatSize(f.size)}</p>
                      <div className="flex-1 h-1 bg-gray-200 rounded-full overflow-hidden">
                        <div className="h-full bg-indigo-500 rounded-full w-full transition-all duration-500" />
                      </div>
                    </div>
                  </div>
                  <button onClick={() => setFiles(files.filter((_, j) => j !== i))}
                    className="p-1.5 text-gray-400 hover:text-red-500 hover:bg-red-50 rounded-lg transition-all">
                    <XMarkIcon className="w-4 h-4" />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex gap-3 px-6 py-4 bg-gray-50/80 border-t border-gray-100">
          <button onClick={onClose} className="btn-secondary flex-1">Cancel</button>
          <button onClick={() => mutation.mutate()}
            disabled={files.length === 0 || !empId || mutation.isPending}
            className="btn-primary flex-1 flex items-center justify-center gap-2">
            {mutation.isPending && <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />}
            Upload {files.length > 0 ? `(${files.length})` : ''}
          </button>
        </div>
      </div>
    </div>
  );
}

export default function DocumentsPage() {
  const { isHR, user, hasPermission } = useAuth();
  const canVerifyDocs = hasPermission('documents.verify');   // RBAC Phase D — verify / reject / delete on the HR Documents page
  const qc = useQueryClient();
  const { view, download, viewer } = useDocumentViewer();
  const [showModal, setShowModal] = useState(false);
  const [filterType, setFilterType] = useState('');
  const [filterEmp, setFilterEmp] = useState('');
  const [filterDept, setFilterDept] = useState('');
  const [filterStatus, setFilterStatus] = useState('');
  const [filterDate, setFilterDate] = useState('');
  const [search, setSearch] = useState('');

  // Fetch once for the scope (HR: everyone; employee: own), then filter client-side.
  const { data, isLoading } = useQuery({
    queryKey: ['documents', 'all'],
    queryFn: () => documentApi.list({ employeeId: isHR() ? undefined : user.id }),
  });

  const { data: empData } = useQuery({
    queryKey: ['employees-all'],
    queryFn: () => employeeApi.list({ limit: 500, status: 'active' }),
    enabled: isHR(),
  });
  const { data: deptData } = useQuery({
    queryKey: ['departments-list'],
    queryFn: () => employeeApi.departments(),
    enabled: isHR(),
  });
  const departments = (deptData?.data?.data || deptData?.data || []).map(d => (typeof d === 'string' ? d : (d?.name || d?.hr_name || d?.department))).filter(Boolean);

  const deleteMutation = useMutation({
    mutationFn: (id) => documentApi.delete(id),
    onSuccess: () => { toast.success('Document deleted'); qc.invalidateQueries({ queryKey: ['documents'] }); },
    onError: (e) => toast.error(e.response?.data?.error || 'Delete failed'),
  });
  const verifyMutation = useMutation({
    mutationFn: ({ id, action, hrRemarks }) => documentApi.verify(id, { action, hrRemarks }),
    onSuccess: (_, v) => { toast.success(v.action === 'approve' ? 'Verified' : 'Rejected'); qc.invalidateQueries({ queryKey: ['documents'] }); },
    onError: (e) => toast.error(e.response?.data?.error || 'Action failed'),
  });

  const allDocs = data?.data?.data || [];
  const q = search.trim().toLowerCase();
  const docs = useMemo(() => allDocs.filter(d => {
    if (filterType && d.type !== filterType) return false;
    if (isHR() && filterEmp && d.employeeId !== filterEmp) return false;
    if (isHR() && filterDept && d.department !== filterDept) return false;
    if (filterStatus && (d.status || 'pending') !== filterStatus) return false;
    if (filterDate && String(d.uploadedOn || '').slice(0, 10) !== filterDate) return false;
    if (q) {
      const hay = `${d.name || ''} ${d.originalName || ''} ${d.employeeName || ''} ${d.employeeCode || ''}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  }), [allDocs, filterType, filterEmp, filterDept, filterStatus, filterDate, q, isHR]);

  const clearFilters = () => { setFilterType(''); setFilterEmp(''); setFilterDept(''); setFilterStatus(''); setFilterDate(''); setSearch(''); };
  const hasFilters = filterType || filterEmp || filterDept || filterStatus || filterDate || search;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 tracking-tight">Documents</h1>
          <p className="text-gray-400 text-sm mt-1">{docs.length} of {allDocs.length} document{allDocs.length === 1 ? '' : 's'}</p>
        </div>
        <button onClick={() => setShowModal(true)}
          className="btn-primary flex items-center gap-2 shadow-lg shadow-indigo-500/20 hover:shadow-xl hover:shadow-indigo-500/30 transition-all duration-200">
          <CloudArrowUpIcon className="w-4 h-4" /> Upload
        </button>
      </div>

      {/* Filter + Search Bar */}
      <div className="bg-white rounded-xl border border-gray-200/60 p-3 space-y-3">
        <div className="relative">
          <MagnifyingGlassIcon className="w-4 h-4 text-gray-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search by document name, employee name or employee ID…"
            className="w-full pl-9 pr-3 py-2 bg-gray-50 border border-gray-200 rounded-lg text-sm outline-none focus:ring-2 focus:ring-indigo-500/20" />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <FunnelIcon className="w-4 h-4 text-gray-400" />
          <select className="input w-auto !border-gray-200 !rounded-lg" value={filterType} onChange={e => setFilterType(e.target.value)}>
            <option value="">All Types</option>
            {DOC_TYPES.map(t => <option key={t}>{t}</option>)}
          </select>
          <select className="input w-auto !border-gray-200 !rounded-lg" value={filterStatus} onChange={e => setFilterStatus(e.target.value)}>
            <option value="">All Status</option>
            <option value="verified">Verified</option>
            <option value="pending">Pending</option>
            <option value="rejected">Rejected</option>
            <option value="reupload">Re-upload</option>
          </select>
          {isHR() && (
            <select className="input w-auto !border-gray-200 !rounded-lg" value={filterEmp} onChange={e => setFilterEmp(e.target.value)}>
              <option value="">All Employees</option>
              {empData?.data?.data?.map(e => <option key={e.hr_hremployeeid} value={e.hr_hremployeeid}>{e.hr_hremployee1}</option>)}
            </select>
          )}
          {isHR() && (
            <select className="input w-auto !border-gray-200 !rounded-lg" value={filterDept} onChange={e => setFilterDept(e.target.value)}>
              <option value="">All Departments</option>
              {departments.map(d => <option key={d} value={d}>{d}</option>)}
            </select>
          )}
          <input type="date" className="input w-auto !border-gray-200 !rounded-lg" value={filterDate} onChange={e => setFilterDate(e.target.value)} title="Upload date" />
          {hasFilters && (
            <button onClick={clearFilters} className="text-xs text-gray-400 hover:text-gray-600 transition-colors ml-auto">Clear filters</button>
          )}
        </div>
      </div>

      {/* Document Grid */}
      {isLoading ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4">
          {Array(6).fill(0).map((_, i) => (
            <div key={i} className="bg-white rounded-2xl border border-gray-200/60 h-40 animate-pulse">
              <div className="p-5 flex gap-4">
                <div className="w-12 h-12 bg-gray-100 rounded-xl" />
                <div className="flex-1 space-y-2">
                  <div className="w-3/4 h-4 bg-gray-100 rounded-lg" />
                  <div className="w-1/2 h-3 bg-gray-100 rounded-lg" />
                  <div className="w-1/3 h-3 bg-gray-100 rounded-lg" />
                </div>
              </div>
            </div>
          ))}
        </div>
      ) : docs.length === 0 ? (
        <div className="bg-white rounded-2xl border border-gray-200/60 p-16 text-center">
          <div className="w-16 h-16 bg-gray-100 rounded-2xl flex items-center justify-center mx-auto mb-4">
            <CloudArrowUpIcon className="w-8 h-8 text-gray-300" />
          </div>
          <p className="text-gray-400 font-medium">No documents found</p>
          <p className="text-gray-300 text-sm mt-1">{hasFilters ? 'Try adjusting your filters' : 'Upload your first document to get started'}</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4">
          {docs.map(doc => {
            const st = doc.status || 'pending';
            return (
              <div key={doc.id}
                className="group bg-white rounded-2xl border border-gray-200/60 p-5 hover:shadow-lg hover:shadow-gray-200/50 transition-all duration-300 flex flex-col">
                <div className="flex items-start gap-4">
                  <FileIcon name={doc.originalName || doc.name} className="w-12 h-12" />
                  <div className="flex-1 min-w-0">
                    <p className="font-semibold text-gray-900 truncate text-sm" title={doc.name}>{doc.name}</p>
                    {(doc.employeeName || doc.employeeCode) && (
                      <p className="text-xs text-gray-500 mt-1 truncate">
                        {doc.employeeCode ? `${doc.employeeCode} · ` : ''}{doc.employeeName || 'Employee'}
                      </p>
                    )}
                    <div className="flex items-center gap-2 mt-1.5 flex-wrap">
                      <span className={`inline-flex items-center px-2 py-0.5 rounded-md text-xs font-medium border ${TYPE_TAG_COLORS[doc.type] || TYPE_TAG_COLORS['Other']}`}>
                        {doc.type || 'Other'}
                      </span>
                      <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-xs font-semibold border ${STATUS_BADGE[st] || STATUS_BADGE.pending}`}>
                        <CheckBadgeIcon className="w-3 h-3" /> {STATUS_LABEL[st] || st}
                      </span>
                    </div>
                    <div className="flex items-center gap-2 mt-2 text-xs text-gray-400 flex-wrap">
                      {doc.department && <span>{doc.department}</span>}
                      {doc.fileSize ? <span>{formatSize(doc.fileSize)}</span> : null}
                      {doc.uploadedOn && <span>{format(new Date(doc.uploadedOn), 'dd-MM-yyyy')}</span>}
                    </div>
                    {doc.uploadedBy && <p className="text-[11px] text-gray-400 mt-1">Uploaded by {doc.uploadedBy}</p>}
                  </div>
                </div>

                {/* Actions */}
                <div className="flex items-center gap-1.5 mt-4 pt-3 border-t border-gray-50">
                  <button onClick={() => view(doc)} title="View"
                    className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-semibold text-indigo-600 bg-indigo-50 hover:bg-indigo-100 rounded-lg transition-all">
                    <EyeIcon className="w-4 h-4" /> View
                  </button>
                  <button onClick={() => download(doc)} title="Download"
                    className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-semibold text-gray-600 bg-gray-100 hover:bg-gray-200 rounded-lg transition-all">
                    <ArrowDownTrayIcon className="w-4 h-4" /> Download
                  </button>
                  {canVerifyDocs && st !== 'verified' && (
                    <button onClick={() => verifyMutation.mutate({ id: doc.id, action: 'approve' })} title="Verify"
                      className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-semibold text-emerald-700 bg-emerald-50 hover:bg-emerald-100 rounded-lg transition-all">
                      Verify
                    </button>
                  )}
                  {canVerifyDocs && st !== 'rejected' && (
                    <button onClick={() => { const r = window.prompt('Reason for rejection (optional):', ''); if (r !== null) verifyMutation.mutate({ id: doc.id, action: 'reject', hrRemarks: r }); }} title="Reject"
                      className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-semibold text-red-600 bg-red-50 hover:bg-red-100 rounded-lg transition-all">
                      Reject
                    </button>
                  )}
                  {canVerifyDocs && (
                    <button title="Delete" onClick={() => { if (confirm('Delete this document?')) deleteMutation.mutate(doc.id); }}
                      className="p-1.5 text-red-500 hover:text-red-700 bg-red-50 hover:bg-red-100 rounded-lg transition-all ml-auto">
                      <TrashIcon className="w-4 h-4" />
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {showModal && <UploadModal onClose={() => setShowModal(false)} />}
      {viewer}
    </div>
  );
}
