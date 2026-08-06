import { useState, useRef } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { documentApi } from '../api/endpoints';
import {
  PlusIcon, XMarkIcon, ArrowUpTrayIcon, EyeIcon, ArrowDownTrayIcon, ArrowPathIcon, TrashIcon,
  DocumentTextIcon, CheckCircleIcon, ClockIcon, ChevronDownIcon,
} from '@heroicons/react/24/outline';
import { fmtDate, fmtVal } from '../utils/format';
import toast from 'react-hot-toast';

export const DOC_TYPES = [
  'Aadhaar Card', 'PAN Card', 'Cancelled Cheque', 'Bank Passbook', 'Passport', 'Photo',
  'Resume', 'Offer Letter', 'Experience Certificate', 'Education Certificate',
  'Salary Slip', 'Address Proof', 'Medical Certificate', 'Other',
];

// Classify a document by its original filename / stored mime → how to VIEW it.
const extOf = (n) => (String(n || '').toLowerCase().match(/\.[a-z0-9]+$/) || [''])[0];
function kindOf(d) {
  const e = extOf(d.originalName || d.name); const ct = String(d.contentType || '');
  if (e === '.pdf' || ct === 'application/pdf') return 'pdf';
  if (['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg'].includes(e) || ct.startsWith('image/')) return 'image';
  if (e === '.txt' || e === '.md' || ct === 'text/plain') return 'text';
  if (e === '.csv' || ct === 'text/csv') return 'csv';
  return 'other';   // docx/xlsx/pptx/zip/rar/… → download (Office Online Viewer needs a public URL; ours are auth-protected)
}
// Minimal CSV parser (handles quoted fields + commas), for the table preview.
function parseCsv(text) {
  const rows = []; let row = [], field = '', inQ = false;
  const s = String(text || '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQ) {
      if (c === '"' && s[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') inQ = false;
      else field += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c !== '\r') field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter(r => r.some(c => String(c).trim() !== '')).slice(0, 500);
}

// In-app preview modal for PDF / image / text / csv (uses the authenticated blob,
// so no popup and no dependency on public file serving).
function PreviewModal({ item, onClose }) {
  const { d, kind, url, text, rows } = item;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-0 sm:p-4" onClick={onClose}>
      <div className="bg-white w-full h-full sm:h-[85vh] sm:max-w-4xl sm:rounded-2xl shadow-2xl flex flex-col overflow-hidden" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-4 sm:px-6 py-3 border-b border-gray-100">
          <p className="text-sm font-semibold text-gray-900 truncate">{d.originalName || d.name}</p>
          <button onClick={onClose} className="p-2 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded-lg"><XMarkIcon className="w-5 h-5" /></button>
        </div>
        <div className="flex-1 overflow-auto bg-gray-50">
          {kind === 'pdf' && <iframe title={d.name} src={url} className="w-full h-full min-h-[70vh]" />}
          {kind === 'image' && <div className="w-full h-full flex items-center justify-center p-4"><img src={url} alt={d.name} className="max-w-full max-h-full object-contain" /></div>}
          {kind === 'text' && <pre className="p-4 text-xs text-gray-800 whitespace-pre-wrap break-words font-mono">{text}</pre>}
          {kind === 'csv' && (
            <div className="p-3 overflow-auto">
              <table className="w-full text-xs border-collapse">
                <tbody>
                  {rows.map((r, i) => (
                    <tr key={i} className={i === 0 ? 'bg-gray-100 font-semibold' : 'odd:bg-white even:bg-gray-50'}>
                      {r.map((c, j) => <td key={j} className="border border-gray-200 px-2 py-1 whitespace-nowrap">{c}</td>)}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

const STATUS = {
  pending: { label: 'Pending HR Verification', cls: 'bg-amber-50 text-amber-700 ring-amber-600/20' },
  verified: { label: 'Verified', cls: 'bg-emerald-50 text-emerald-700 ring-emerald-600/20' },
  rejected: { label: 'Rejected', cls: 'bg-red-50 text-red-700 ring-red-600/20' },
  reupload: { label: 'Re-upload Requested', cls: 'bg-orange-50 text-orange-700 ring-orange-600/20' },
  superseded: { label: 'Superseded', cls: 'bg-gray-100 text-gray-500 ring-gray-400/20' },
};
const StatusPill = ({ s }) => { const c = STATUS[s] || STATUS.pending; return <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold ring-1 ring-inset ${c.cls}`}>{c.label}</span>; };

// Group version rows into version chains (by docGroup).
function toGroups(docs) {
  const map = new Map();
  for (const d of docs) { const k = d.docGroup || d.id; if (!map.has(k)) map.set(k, []); map.get(k).push(d); }
  return [...map.values()].map(versions => {
    versions.sort((a, b) => (b.version || 1) - (a.version || 1));   // newest first
    const verified = versions.find(v => v.status === 'verified');
    const latest = versions[0];
    // "current" = active verified version, else the latest (pending/rejected/reupload).
    const current = verified || latest;
    return { key: current.docGroup || current.id, current, latest, versions };
  }).sort((a, b) => new Date(b.current.uploadedOn) - new Date(a.current.uploadedOn));
}

function UploadModal({ employeeId, mode, doc, onClose }) {
  // mode: 'new' (fresh doc) | 'replace' (in-place, pending) | 'version' (new version of a verified doc)
  const qc = useQueryClient();
  const [file, setFile] = useState(null);
  const [type, setType] = useState(doc?.type && DOC_TYPES.includes(doc.type) ? doc.type : 'Aadhaar Card');
  const [name, setName] = useState(doc?.name || '');
  const [remarks, setRemarks] = useState('');
  const [progress, setProgress] = useState(0);
  const [drag, setDrag] = useState(false);
  const inputRef = useRef(null);

  const titles = { new: 'Upload Document', replace: `Replace — ${doc?.name || ''}`, version: `Upload New Version — ${doc?.name || ''}` };
  const mutation = useMutation({
    mutationFn: () => {
      const fd = new FormData(); fd.append('file', file);
      const onP = (e) => setProgress(Math.round((e.loaded / (e.total || 1)) * 100));
      if (mode === 'replace') return documentApi.replace(doc.id, fd, onP);
      if (mode === 'version') { fd.append('remarks', remarks); return documentApi.newVersion(doc.id, fd, onP); }
      fd.append('employeeId', employeeId); fd.append('documentType', type); fd.append('name', name || type); fd.append('remarks', remarks);
      return documentApi.upload(fd, onP);
    },
    onSuccess: () => {
      toast.success(mode === 'replace' ? 'Document replaced — pending verification' : mode === 'version' ? 'New version uploaded — pending verification' : 'Document uploaded — pending verification');
      qc.invalidateQueries({ queryKey: ['documents', employeeId] }); onClose();
    },
    onError: (err) => { setProgress(0); toast.error(err.response?.data?.error || 'Upload failed'); },
  });
  const pick = (f) => { if (f) { setFile(f); if (!name) setName(f.name.replace(/\.[^.]+$/, '')); } };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg max-h-[calc(100dvh-2rem)] overflow-y-auto">
        <div className="flex items-center justify-between px-6 py-5 border-b border-gray-100">
          <h2 className="text-lg font-semibold text-gray-900">{titles[mode]}</h2>
          <button onClick={onClose} className="p-2 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded-xl"><XMarkIcon className="w-5 h-5" /></button>
        </div>
        <div className="px-6 py-5 space-y-4">
          {mode === 'new' && (
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
            </>
          )}
          {mode !== 'replace' && (
            <div>
              <label className="block text-sm font-semibold text-gray-700 mb-1.5">Remarks</label>
              <textarea rows={2} value={remarks} onChange={e => setRemarks(e.target.value)} placeholder={mode === 'version' ? 'What changed in this version?' : 'Optional'} className="w-full px-3 py-2 border border-gray-200 rounded-xl text-sm focus:ring-2 focus:ring-blue-500/20 focus:border-blue-400 outline-none resize-none" />
            </div>
          )}
          <div onDragOver={e => { e.preventDefault(); setDrag(true); }} onDragLeave={() => setDrag(false)}
            onDrop={e => { e.preventDefault(); setDrag(false); pick(e.dataTransfer.files?.[0]); }}
            onClick={() => inputRef.current?.click()}
            className={`border-2 border-dashed rounded-xl px-4 py-8 text-center cursor-pointer transition-colors ${drag ? 'border-blue-400 bg-blue-50' : 'border-gray-200 hover:border-gray-300'}`}>
            <ArrowUpTrayIcon className="w-7 h-7 text-gray-300 mx-auto mb-2" />
            {file ? <p className="text-sm font-medium text-gray-800">{file.name}</p> : <p className="text-sm text-gray-500">Drag & drop a file here, or <span className="text-blue-600 font-medium">browse</span></p>}
            <p className="text-xs text-gray-400 mt-1">PDF, JPG or PNG · up to 10 MB</p>
            <input ref={inputRef} type="file" accept=".pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.png,.jpg,.jpeg,.gif,.webp,.txt,.csv,.html,.htm,.zip,.rar,.7z,.odt,.ods,.odp" className="hidden" onChange={e => pick(e.target.files?.[0])} />
          </div>
          {mutation.isPending && <div className="w-full h-2 bg-gray-100 rounded-full overflow-hidden"><div className="h-full bg-blue-600 transition-all duration-200" style={{ width: `${progress}%` }} /></div>}
        </div>
        <div className="px-6 py-4 border-t border-gray-100 flex justify-end gap-2">
          <button onClick={onClose} className="px-4 py-2 text-sm font-medium text-gray-600 hover:text-gray-800">Cancel</button>
          <button onClick={() => mutation.mutate()} disabled={!file || mutation.isPending} className="px-5 py-2 bg-blue-600 text-white text-sm font-semibold rounded-xl hover:bg-blue-700 disabled:opacity-50">
            {mutation.isPending ? `Uploading ${progress}%` : (mode === 'replace' ? 'Replace' : mode === 'version' ? 'Upload Version' : 'Upload')}
          </button>
        </div>
      </div>
    </div>
  );
}

export default function DocumentsManager({ employeeId, canManage = false, hrView = false }) {
  const qc = useQueryClient();
  const [modal, setModal] = useState(null);   // { mode, doc }
  const [expanded, setExpanded] = useState({});
  const [preview, setPreview] = useState(null);   // { d, kind, url|text|rows }

  const { data, isLoading } = useQuery({ queryKey: ['documents', employeeId], queryFn: () => documentApi.list({ employeeId }), enabled: !!employeeId });
  const groups = toGroups(data?.data?.data || []);

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
  // Download ANY type via the authenticated API (keeps the original filename +
  // extension; Content-Type comes from the server). Works for every file type.
  const download = async (d) => {
    try {
      const res = await documentApi.file(d.id, true);
      const url = URL.createObjectURL(new Blob([res.data], { type: d.contentType || 'application/octet-stream' }));
      const a = document.createElement('a'); a.href = url; a.download = d.originalName || d.name; a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch { toast.error('Download failed — the file may be missing on the server.'); }
  };
  // View: preview PDF/image/text/CSV in-app; everything else downloads.
  const view = async (d) => {
    const kind = kindOf(d);
    if (kind === 'other') return download(d);
    try {
      const res = await documentApi.file(d.id, false);
      const blob = new Blob([res.data], { type: d.contentType || 'application/octet-stream' });
      if (kind === 'pdf' || kind === 'image') setPreview({ d, kind, url: URL.createObjectURL(blob) });
      else if (kind === 'text') setPreview({ d, kind, text: await blob.text() });
      else if (kind === 'csv') setPreview({ d, kind, rows: parseCsv(await blob.text()) });
    } catch { toast.error('Preview failed — the file may be missing on the server.'); }
  };
  const closePreview = () => { if (preview?.url) URL.revokeObjectURL(preview.url); setPreview(null); };

  const iconBtns = (d, { compact } = {}) => (
    <>
      <button onClick={() => view(d)} title="View" className="p-1.5 text-gray-500 hover:text-blue-600 hover:bg-blue-50 rounded-lg"><EyeIcon className="w-4 h-4" /></button>
      <button onClick={() => download(d)} title="Download" className="p-1.5 text-gray-500 hover:text-blue-600 hover:bg-blue-50 rounded-lg"><ArrowDownTrayIcon className="w-4 h-4" /></button>
      {!compact && hrView && (d.status === 'pending' || d.status === 'reupload') && (
        <>
          <button onClick={() => verify.mutate({ docId: d.id, action: 'approve' })} title="Approve" className="p-1.5 text-emerald-600 hover:bg-emerald-50 rounded-lg"><CheckCircleIcon className="w-4 h-4" /></button>
          <button onClick={() => verify.mutate({ docId: d.id, action: 'reject', hrRemarks: window.prompt('Reason for rejection:') || '' })} title="Reject" className="p-1.5 text-red-600 hover:bg-red-50 rounded-lg"><XMarkIcon className="w-4 h-4" /></button>
          <button onClick={() => verify.mutate({ docId: d.id, action: 'reupload', hrRemarks: window.prompt('What needs changing?') || '' })} title="Request re-upload" className="p-1.5 text-orange-600 hover:bg-orange-50 rounded-lg"><ArrowPathIcon className="w-4 h-4" /></button>
        </>
      )}
    </>
  );

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <p className="text-sm text-gray-500">Upload any document; HR verifies it. Verified documents keep a version history — upload a new version instead of overwriting.</p>
        {canManage && (
          <button onClick={() => setModal({ mode: 'new' })} className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-semibold text-white bg-blue-600 rounded-xl hover:bg-blue-700 flex-shrink-0">
            <PlusIcon className="w-4 h-4" /> Upload Document
          </button>
        )}
      </div>

      {isLoading ? (
        <div className="py-10 text-center text-sm text-gray-400">Loading…</div>
      ) : groups.length === 0 ? (
        <div className="py-12 text-center border border-gray-100 rounded-xl">
          <DocumentTextIcon className="w-9 h-9 text-gray-200 mx-auto mb-2" />
          <p className="text-sm text-gray-400">No documents uploaded yet</p>
        </div>
      ) : (
        <div className="space-y-3">
          {groups.map(g => {
            const d = g.current;
            const isVerified = d.status === 'verified';
            const pendingLatest = g.latest.status === 'pending' || g.latest.status === 'reupload';
            const canReplaceInPlace = canManage && (hrView || (!isVerified && pendingLatest));
            const open = !!expanded[g.key];
            return (
              <div key={g.key} className="border border-gray-100 rounded-xl overflow-hidden">
                <div className="flex items-center gap-3 px-4 py-3 flex-wrap">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <p className="text-sm font-semibold text-gray-800">{fmtVal(d.type)}</p>
                      <span className="text-[11px] font-bold text-blue-600 bg-blue-50 px-1.5 py-0.5 rounded">V{d.version || 1}</span>
                      <StatusPill s={d.status} />
                    </div>
                    <p className="text-xs text-gray-500 mt-0.5">{fmtVal(d.name)} · uploaded {fmtDate(d.uploadedOn)} by {fmtVal(d.uploadedBy)}</p>
                    {d.hrRemarks && <p className="text-xs text-gray-400 mt-0.5">HR: {d.hrRemarks}</p>}
                  </div>
                  <div className="flex items-center gap-1 flex-wrap">
                    {iconBtns(d)}
                    {/* Employee can replace in-place only while pending; verified → new version */}
                    {canReplaceInPlace && <button onClick={() => setModal({ mode: 'replace', doc: d })} title="Replace" className="p-1.5 text-gray-500 hover:text-amber-600 hover:bg-amber-50 rounded-lg"><ArrowPathIcon className="w-4 h-4" /></button>}
                    {canManage && (isVerified || d.status === 'superseded') && (
                      <button onClick={() => setModal({ mode: 'version', doc: d })} className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-semibold text-blue-600 bg-blue-50 rounded-lg hover:bg-blue-100"><ArrowUpTrayIcon className="w-3.5 h-3.5" /> New Version</button>
                    )}
                    {canManage && !isVerified && d.status !== 'superseded' && (hrView || pendingLatest) && (
                      <button onClick={() => window.confirm(`Delete "${d.name}" v${d.version}?`) && del.mutate(d.id)} title="Delete" className="p-1.5 text-gray-500 hover:text-red-600 hover:bg-red-50 rounded-lg"><TrashIcon className="w-4 h-4" /></button>
                    )}
                    {g.versions.length > 1 && (
                      <button onClick={() => setExpanded(p => ({ ...p, [g.key]: !p[g.key] }))} className="inline-flex items-center gap-1 px-2 py-1 text-xs font-medium text-gray-500 hover:text-gray-700">
                        <ChevronDownIcon className={`w-4 h-4 transition-transform ${open ? 'rotate-180' : ''}`} /> {g.versions.length} versions
                      </button>
                    )}
                  </div>
                </div>

                {/* Version history */}
                {open && g.versions.length > 1 && (
                  <div className="border-t border-gray-100 bg-gray-50/50 px-4 py-3">
                    <p className="text-[11px] font-semibold text-gray-400 uppercase tracking-wide mb-2">Version History</p>
                    <div className="overflow-x-auto">
                      <table className="w-full text-xs">
                        <thead><tr className="text-gray-400">
                          {['Version', 'Uploaded By', 'Uploaded', 'Status', 'Verified By', 'Verified', 'Remarks', ''].map(h => <th key={h} className="text-left font-semibold px-2 py-1 whitespace-nowrap">{h}</th>)}
                        </tr></thead>
                        <tbody>
                          {g.versions.map(v => (
                            <tr key={v.id} className="border-t border-gray-100">
                              <td className="px-2 py-1.5 font-bold text-blue-600">V{v.version || 1}</td>
                              <td className="px-2 py-1.5 text-gray-600 whitespace-nowrap">{fmtVal(v.uploadedBy)}</td>
                              <td className="px-2 py-1.5 text-gray-500 whitespace-nowrap">{fmtDate(v.uploadedOn)}</td>
                              <td className="px-2 py-1.5"><StatusPill s={v.status} /></td>
                              <td className="px-2 py-1.5 text-gray-600 whitespace-nowrap">{fmtVal(v.verifiedBy)}</td>
                              <td className="px-2 py-1.5 text-gray-500 whitespace-nowrap">{v.verifiedOn ? fmtDate(v.verifiedOn) : '—'}</td>
                              <td className="px-2 py-1.5 text-gray-500 max-w-[160px] truncate">{fmtVal(v.hrRemarks || v.remarks)}</td>
                              <td className="px-2 py-1.5"><div className="flex items-center gap-0.5">{iconBtns(v, { compact: true })}</div></td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {modal && <UploadModal employeeId={employeeId} mode={modal.mode} doc={modal.doc} onClose={() => setModal(null)} />}
      {preview && <PreviewModal item={preview} onClose={closePreview} />}
    </div>
  );
}
