import { useRef, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { documentApi } from '../api/endpoints';
import { useDocumentViewer } from './DocumentViewer';
import {
  DocumentArrowUpIcon, EyeIcon, ArrowDownTrayIcon, CheckIcon, XMarkIcon,
  ArrowPathIcon, ExclamationTriangleIcon, ShieldCheckIcon, PaperClipIcon,
} from '@heroicons/react/24/outline';
import toast from 'react-hot-toast';

// Sick-leave medical certificate — a normal document (hr_hrdocuments) of type
// "Medical Certificate", reusing the full document pipeline (upload, versioning,
// verify/reject/re-upload, authenticated streaming). This file provides the two
// UI pieces: the apply-time uploader and the HR/employee review card.

const ACCEPT = '.pdf,.jpg,.jpeg,.png';
const ACCEPT_EXT = ['pdf', 'jpg', 'jpeg', 'png'];
const MAX_BYTES = 10 * 1024 * 1024;   // 10MB

function validateFile(file) {
  const ext = (file.name.split('.').pop() || '').toLowerCase();
  if (!ACCEPT_EXT.includes(ext)) return 'Only PDF, JPG, JPEG or PNG files are allowed.';
  if (file.size > MAX_BYTES) return 'File must be 10MB or smaller.';
  return '';
}

const STATUS_META = {
  pending: { label: 'Pending Verification', cls: 'bg-amber-50 text-amber-700 border-amber-200' },
  verified: { label: 'Verified', cls: 'bg-emerald-50 text-emerald-700 border-emerald-200' },
  rejected: { label: 'Rejected', cls: 'bg-red-50 text-red-700 border-red-200' },
  reupload: { label: 'Re-upload Requested', cls: 'bg-orange-50 text-orange-700 border-orange-200' },
  superseded: { label: 'Superseded', cls: 'bg-gray-100 text-gray-500 border-gray-200' },
};

/**
 * Apply-time uploader. `doc` is the shaped uploaded document (or null); `onChange`
 * receives the shaped doc after a successful upload, or null when removed.
 */
export function CertUploader({ from, to, doc, onChange, required }) {
  const { view, viewer } = useDocumentViewer();
  const fileRef = useRef(null);
  const [uploading, setUploading] = useState(false);
  const [err, setErr] = useState('');

  const handleFile = async (e) => {
    const file = e.target.files?.[0];
    if (fileRef.current) fileRef.current.value = '';
    if (!file) return;
    const v = validateFile(file);
    if (v) { setErr(v); return; }
    setErr('');
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append('file', file);
      fd.append('documentType', 'Medical Certificate');
      fd.append('name', `Medical Certificate${from ? ` (${from}${to ? ` to ${to}` : ''})` : ''}`);
      fd.append('remarks', 'Sick leave medical certificate');
      const res = await documentApi.upload(fd);
      onChange(res.data);
      toast.success('Medical certificate uploaded');
    } catch (e) {
      setErr(e.response?.data?.error || 'Upload failed. Please try again.');
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="rounded-xl border-2 border-dashed border-rose-200 bg-rose-50/40 p-4">
      <div className="flex items-center gap-2 mb-1">
        <ShieldCheckIcon className="w-4 h-4 text-rose-500" />
        <p className="text-sm font-semibold text-rose-800">
          Medical Certificate {required && <span className="text-rose-500">*</span>}
        </p>
      </div>
      <p className="text-xs text-rose-600/80 mb-3">
        A hospital report / medical certificate is mandatory for this Sick Leave.
        Accepted: PDF, JPG, JPEG, PNG — up to 10MB.
      </p>

      {doc ? (
        <div className="flex items-center gap-2 rounded-lg bg-white border border-rose-200 px-3 py-2">
          <PaperClipIcon className="w-4 h-4 text-rose-400 flex-shrink-0" />
          <span className="text-sm text-gray-700 truncate flex-1">{doc.originalName || doc.name || 'Certificate'}</span>
          <button type="button" onClick={() => view(doc)}
            className="inline-flex items-center gap-1 text-xs font-semibold text-indigo-600 hover:text-indigo-800">
            <EyeIcon className="w-3.5 h-3.5" /> Preview
          </button>
          <button type="button" onClick={() => onChange(null)}
            className="inline-flex items-center gap-1 text-xs font-semibold text-red-600 hover:text-red-800">
            <XMarkIcon className="w-3.5 h-3.5" /> Remove
          </button>
        </div>
      ) : (
        <button type="button" onClick={() => fileRef.current?.click()} disabled={uploading}
          className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-rose-600 text-white text-sm font-semibold hover:bg-rose-700 active:scale-95 transition-all disabled:opacity-60">
          <DocumentArrowUpIcon className="w-4 h-4" />
          {uploading ? 'Uploading…' : 'Upload Certificate'}
        </button>
      )}

      <input ref={fileRef} type="file" accept={ACCEPT} className="hidden" onChange={handleFile} />
      {err && (
        <div className="mt-2 flex items-center gap-1.5 text-xs font-medium text-red-700">
          <ExclamationTriangleIcon className="w-3.5 h-3.5 flex-shrink-0" /> {err}
        </div>
      )}
      {viewer}
    </div>
  );
}

/**
 * Review card shown on a leave request. Renders the linked certificate with
 * View/Download for everyone, Verify/Reject for HR, and Re-upload for the owner
 * when it was rejected. `docId` is leave.hr_medcertdocid.
 */
export function CertReview({ docId, status: statusProp, isHR, isOwner }) {
  const qc = useQueryClient();
  const { view, download, viewer } = useDocumentViewer();
  const fileRef = useRef(null);
  const [replacing, setReplacing] = useState(false);
  const [err, setErr] = useState('');

  // Only the owner or HR may open the file (document RBAC). A reporting manager
  // sees the status chip only — driven by the status the leave list carries.
  const canAccessFile = !!isHR || !!isOwner;
  const { data: doc, refetch } = useQuery({
    queryKey: ['medcert-doc', docId],
    queryFn: () => documentApi.get(docId).then(r => r.data),
    enabled: !!docId && canAccessFile,
  });

  const verifyMut = useMutation({
    mutationFn: ({ action, hrRemarks }) => documentApi.verify(docId, { action, hrRemarks }),
    onSuccess: (_, vars) => {
      toast.success(vars.action === 'approve' ? 'Certificate verified' : 'Certificate rejected');
      refetch();
      qc.invalidateQueries({ queryKey: ['leaves'] });
    },
    onError: (e) => toast.error(e.response?.data?.error || 'Action failed'),
  });

  const handleReplace = async (e) => {
    const file = e.target.files?.[0];
    if (fileRef.current) fileRef.current.value = '';
    if (!file) return;
    const v = validateFile(file);
    if (v) { setErr(v); return; }
    setErr('');
    setReplacing(true);
    try {
      const fd = new FormData();
      fd.append('file', file);
      await documentApi.replace(docId, fd);
      toast.success('Certificate re-uploaded — pending verification');
      refetch();
      qc.invalidateQueries({ queryKey: ['leaves'] });
    } catch (e) {
      setErr(e.response?.data?.error || 'Re-upload failed');
    } finally {
      setReplacing(false);
    }
  };

  if (!docId) return null;
  const status = doc?.status || statusProp || 'pending';
  const meta = STATUS_META[status] || STATUS_META.pending;
  const canReupload = isOwner && ['rejected', 'reupload'].includes(status);

  return (
    <div className="mt-3 rounded-lg border border-gray-150 bg-gray-50/70 px-3 py-2.5">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="inline-flex items-center gap-1 text-xs font-semibold text-gray-600">
          <ShieldCheckIcon className="w-4 h-4 text-rose-500" /> Medical Certificate
        </span>
        <span className={`inline-flex items-center text-[11px] font-semibold border px-2 py-0.5 rounded-full ${meta.cls}`}>
          {meta.label}
        </span>
        {doc?.hrRemarks && status === 'rejected' && (
          <span className="text-[11px] text-red-600 italic">— {doc.hrRemarks}</span>
        )}
      </div>

      <div className="flex items-center gap-2 flex-wrap mt-2">
        {canAccessFile && doc && (
          <>
            <button type="button" onClick={() => view(doc)}
              className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-semibold text-indigo-600 bg-white border border-gray-200 hover:bg-indigo-50">
              <EyeIcon className="w-3.5 h-3.5" /> View
            </button>
            <button type="button" onClick={() => download(doc)}
              className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-semibold text-gray-600 bg-white border border-gray-200 hover:bg-gray-100">
              <ArrowDownTrayIcon className="w-3.5 h-3.5" /> Download
            </button>
          </>
        )}

        {isHR && status !== 'verified' && (
          <button type="button" disabled={verifyMut.isPending}
            onClick={() => verifyMut.mutate({ action: 'approve' })}
            className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-semibold text-white bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50">
            <CheckIcon className="w-3.5 h-3.5" /> Verify
          </button>
        )}
        {isHR && status !== 'rejected' && (
          <button type="button" disabled={verifyMut.isPending}
            onClick={() => {
              const r = window.prompt('Reason for rejecting the certificate (optional):', '');
              if (r === null) return;   // cancelled
              verifyMut.mutate({ action: 'reject', hrRemarks: r });
            }}
            className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-semibold text-white bg-red-600 hover:bg-red-700 disabled:opacity-50">
            <XMarkIcon className="w-3.5 h-3.5" /> Reject
          </button>
        )}

        {canReupload && (
          <button type="button" onClick={() => fileRef.current?.click()} disabled={replacing}
            className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-semibold text-white bg-rose-600 hover:bg-rose-700 disabled:opacity-50">
            <ArrowPathIcon className="w-3.5 h-3.5" /> {replacing ? 'Uploading…' : 'Re-upload'}
          </button>
        )}
      </div>

      <input ref={fileRef} type="file" accept={ACCEPT} className="hidden" onChange={handleReplace} />
      {err && (
        <div className="mt-1.5 flex items-center gap-1.5 text-xs font-medium text-red-700">
          <ExclamationTriangleIcon className="w-3.5 h-3.5 flex-shrink-0" /> {err}
        </div>
      )}
      {viewer}
    </div>
  );
}
