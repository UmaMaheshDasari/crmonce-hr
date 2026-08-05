import { useState, useRef } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { documentApi } from '../api/endpoints';
import {
  PlusIcon, XMarkIcon, ArrowUpTrayIcon, EyeIcon, ArrowDownTrayIcon, ArrowPathIcon, TrashIcon,
  DocumentTextIcon, CheckCircleIcon,
} from '@heroicons/react/24/outline';
import { fmtDate, fmtVal } from '../utils/format';
import toast from 'react-hot-toast';

export const DOC_TYPES = [
  'Aadhaar Card', 'PAN Card', 'Cancelled Cheque', 'Bank Passbook', 'Passport', 'Photo',
  'Resume', 'Offer Letter', 'Experience Certificate', 'Education Certificate',
  'Salary Slip', 'Address Proof', 'Medical Certificate', 'Other',
];

const API_BASE = (import.meta.env.VITE_API_URL || 'http://localhost:5000/api').replace(/\/api\/?$/, '');
const fileUrl = (u) => (u ? (u.startsWith('http') ? u : API_BASE + u) : '');

const STATUS = {
  pending: { label: 'Pending HR Verification', cls: 'bg-amber-50 text-amber-700 ring-amber-600/20' },
  verified: { label: 'Verified', cls: 'bg-emerald-50 text-emerald-700 ring-emerald-600/20' },
  rejected: { label: 'Rejected', cls: 'bg-red-50 text-red-700 ring-red-600/20' },
  reupload: { label: 'Re-upload Requested', cls: 'bg-orange-50 text-orange-700 ring-orange-600/20' },
};
const StatusPill = ({ s }) => {
  const c = STATUS[s] || STATUS.pending;
  return <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold ring-1 ring-inset ${c.cls}`}>{c.label}</span>;
};

function UploadModal({ employeeId, replaceDoc, onClose }) {
  const qc = useQueryClient();
  const [file, setFile] = useState(null);
  const [type, setType] = useState(replaceDoc?.type && DOC_TYPES.includes(replaceDoc.type) ? replaceDoc.type : 'Aadhaar Card');
  const [name, setName] = useState(replaceDoc?.name || '');
  const [remarks, setRemarks] = useState('');
  const [progress, setProgress] = useState(0);
  const [drag, setDrag] = useState(false);
  const inputRef = useRef(null);

  const mutation = useMutation({
    mutationFn: () => {
      const fd = new FormData();
      fd.append('file', file);
      if (replaceDoc) return documentApi.replace(replaceDoc.id, fd, (e) => setProgress(Math.round((e.loaded / (e.total || 1)) * 100)));
      fd.append('employeeId', employeeId);
      fd.append('documentType', type);
      fd.append('name', name || type);
      fd.append('remarks', remarks);
      return documentApi.upload(fd, (e) => setProgress(Math.round((e.loaded / (e.total || 1)) * 100)));
    },
    onSuccess: () => { toast.success(replaceDoc ? 'Document replaced — pending verification' : 'Document uploaded — pending verification'); qc.invalidateQueries({ queryKey: ['documents', employeeId] }); onClose(); },
    onError: (err) => { setProgress(0); toast.error(err.response?.data?.error || 'Upload failed'); },
  });

  const pick = (f) => { if (f) { setFile(f); if (!name) setName(f.name.replace(/\.[^.]+$/, '')); } };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg max-h-[calc(100dvh-2rem)] overflow-y-auto">
        <div className="flex items-center justify-between px-6 py-5 border-b border-gray-100">
          <h2 className="text-lg font-semibold text-gray-900">{replaceDoc ? `Replace — ${replaceDoc.name}` : 'Upload Document'}</h2>
          <button onClick={onClose} className="p-2 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded-xl"><XMarkIcon className="w-5 h-5" /></button>
        </div>
        <div className="px-6 py-5 space-y-4">
          {!replaceDoc && (
            <>
              <div>
                <label className="block text-sm font-semibold text-gray-700 mb-1.5">Document Type</label>
                <select value={type} onChange={e => setType(e.target.value)} className="w-full h-11 px-3 border border-gray-200 rounded-xl text-sm focus:ring-2 focus:ring-blue-500/20 focus:border-blue-400 outline-none">
                  {DOC_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-sm font-semibold text-gray-700 mb-1.5">Document Name</label>
                <input value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Aadhaar front & back" className="w-full h-11 px-3 border border-gray-200 rounded-xl text-sm focus:ring-2 focus:ring-blue-500/20 focus:border-blue-400 outline-none" />
              </div>
              <div>
                <label className="block text-sm font-semibold text-gray-700 mb-1.5">Remarks</label>
                <textarea rows={2} value={remarks} onChange={e => setRemarks(e.target.value)} placeholder="Optional" className="w-full px-3 py-2 border border-gray-200 rounded-xl text-sm focus:ring-2 focus:ring-blue-500/20 focus:border-blue-400 outline-none resize-none" />
              </div>
            </>
          )}
          {/* Drag & drop */}
          <div onDragOver={e => { e.preventDefault(); setDrag(true); }} onDragLeave={() => setDrag(false)}
            onDrop={e => { e.preventDefault(); setDrag(false); pick(e.dataTransfer.files?.[0]); }}
            onClick={() => inputRef.current?.click()}
            className={`border-2 border-dashed rounded-xl px-4 py-8 text-center cursor-pointer transition-colors ${drag ? 'border-blue-400 bg-blue-50' : 'border-gray-200 hover:border-gray-300'}`}>
            <ArrowUpTrayIcon className="w-7 h-7 text-gray-300 mx-auto mb-2" />
            {file ? <p className="text-sm font-medium text-gray-800">{file.name}</p> : <p className="text-sm text-gray-500">Drag & drop a file here, or <span className="text-blue-600 font-medium">browse</span></p>}
            <p className="text-xs text-gray-400 mt-1">PDF, JPG or PNG · up to 10 MB</p>
            <input ref={inputRef} type="file" accept=".pdf,.jpg,.jpeg,.png" className="hidden" onChange={e => pick(e.target.files?.[0])} />
          </div>
          {mutation.isPending && (
            <div className="w-full h-2 bg-gray-100 rounded-full overflow-hidden">
              <div className="h-full bg-blue-600 transition-all duration-200" style={{ width: `${progress}%` }} />
            </div>
          )}
        </div>
        <div className="px-6 py-4 border-t border-gray-100 flex justify-end gap-2">
          <button onClick={onClose} className="px-4 py-2 text-sm font-medium text-gray-600 hover:text-gray-800">Cancel</button>
          <button onClick={() => mutation.mutate()} disabled={!file || mutation.isPending} className="px-5 py-2 bg-blue-600 text-white text-sm font-semibold rounded-xl hover:bg-blue-700 disabled:opacity-50">
            {mutation.isPending ? `Uploading ${progress}%` : (replaceDoc ? 'Replace' : 'Upload')}
          </button>
        </div>
      </div>
    </div>
  );
}

export default function DocumentsManager({ employeeId, canManage = false, hrView = false }) {
  const qc = useQueryClient();
  const [modal, setModal] = useState(null);   // { replaceDoc? } or 'new'
  const replaceRef = useRef(null);

  const { data, isLoading } = useQuery({ queryKey: ['documents', employeeId], queryFn: () => documentApi.list({ employeeId }), enabled: !!employeeId });
  const docs = data?.data?.data || [];

  const del = useMutation({
    mutationFn: (docId) => documentApi.delete(docId),
    onSuccess: () => { toast.success('Document deleted'); qc.invalidateQueries({ queryKey: ['documents', employeeId] }); },
    onError: (err) => toast.error(err.response?.data?.error || 'Delete failed'),
  });
  const verify = useMutation({
    mutationFn: ({ docId, action, hrRemarks }) => documentApi.verify(docId, { action, hrRemarks }),
    onSuccess: () => { toast.success('Document updated'); qc.invalidateQueries({ queryKey: ['documents', employeeId] }); qc.invalidateQueries({ queryKey: ['pending-documents'] }); },
    onError: (err) => toast.error(err.response?.data?.error || 'Action failed'),
  });

  const download = (d) => { const a = document.createElement('a'); a.href = fileUrl(d.fileUrl); a.download = d.originalName || d.name; a.target = '_blank'; a.click(); };

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <p className="text-sm text-gray-500">Upload any document; HR verifies it. Verified documents are locked.</p>
        {canManage && (
          <button onClick={() => setModal({ replaceDoc: null })} className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-semibold text-white bg-blue-600 rounded-xl hover:bg-blue-700">
            <PlusIcon className="w-4 h-4" /> Upload Document
          </button>
        )}
      </div>

      <div className="overflow-x-auto rounded-xl border border-gray-100">
        <table className="w-full">
          <thead>
            <tr className="bg-gray-50/80">
              {['Type', 'Name', 'Uploaded', 'Uploaded By', 'Status', 'Verified By', 'Actions'].map(h => (
                <th key={h} className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider whitespace-nowrap">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {isLoading ? (
              <tr><td colSpan={7} className="px-4 py-10 text-center text-sm text-gray-400">Loading…</td></tr>
            ) : docs.length === 0 ? (
              <tr><td colSpan={7} className="px-4 py-12 text-center">
                <DocumentTextIcon className="w-9 h-9 text-gray-200 mx-auto mb-2" />
                <p className="text-sm text-gray-400">No documents uploaded yet</p>
              </td></tr>
            ) : docs.map(d => {
              const locked = d.status === 'verified';
              const canModify = canManage && (hrView || !locked);
              return (
                <tr key={d.id} className="hover:bg-gray-50/50">
                  <td className="px-4 py-3 text-sm font-medium text-gray-800 whitespace-nowrap">{fmtVal(d.type)}</td>
                  <td className="px-4 py-3 text-sm text-gray-600">{fmtVal(d.name)}{d.remarks && <span className="block text-xs text-gray-400">{d.remarks}</span>}</td>
                  <td className="px-4 py-3 text-sm text-gray-500 whitespace-nowrap">{fmtDate(d.uploadedOn)}</td>
                  <td className="px-4 py-3 text-sm text-gray-500 whitespace-nowrap">{fmtVal(d.uploadedBy)}</td>
                  <td className="px-4 py-3"><StatusPill s={d.status} />{d.hrRemarks && <span className="block text-xs text-gray-400 mt-0.5">HR: {d.hrRemarks}</span>}</td>
                  <td className="px-4 py-3 text-sm text-gray-500 whitespace-nowrap">{fmtVal(d.verifiedBy)}</td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-1">
                      <a href={fileUrl(d.fileUrl)} target="_blank" rel="noreferrer" title="Preview" className="p-1.5 text-gray-500 hover:text-blue-600 hover:bg-blue-50 rounded-lg"><EyeIcon className="w-4 h-4" /></a>
                      <button onClick={() => download(d)} title="Download" className="p-1.5 text-gray-500 hover:text-blue-600 hover:bg-blue-50 rounded-lg"><ArrowDownTrayIcon className="w-4 h-4" /></button>
                      {canModify && <button onClick={() => setModal({ replaceDoc: d })} title="Replace" className="p-1.5 text-gray-500 hover:text-amber-600 hover:bg-amber-50 rounded-lg"><ArrowPathIcon className="w-4 h-4" /></button>}
                      {canModify && <button onClick={() => window.confirm(`Delete "${d.name}"?`) && del.mutate(d.id)} title="Delete" className="p-1.5 text-gray-500 hover:text-red-600 hover:bg-red-50 rounded-lg"><TrashIcon className="w-4 h-4" /></button>}
                      {hrView && (d.status === 'pending' || d.status === 'reupload') && (
                        <>
                          <button onClick={() => verify.mutate({ docId: d.id, action: 'approve' })} title="Approve" className="p-1.5 text-emerald-600 hover:bg-emerald-50 rounded-lg"><CheckCircleIcon className="w-4 h-4" /></button>
                          <button onClick={() => verify.mutate({ docId: d.id, action: 'reject', hrRemarks: window.prompt('Reason for rejection:') || '' })} title="Reject" className="p-1.5 text-red-600 hover:bg-red-50 rounded-lg"><XMarkIcon className="w-4 h-4" /></button>
                        </>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {modal && <UploadModal employeeId={employeeId} replaceDoc={modal.replaceDoc} onClose={() => setModal(null)} />}
      <input ref={replaceRef} type="file" className="hidden" />
    </div>
  );
}
