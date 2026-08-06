import { useState } from 'react';
import { createPortal } from 'react-dom';
import { documentApi } from '../api/endpoints';
import { XMarkIcon } from '@heroicons/react/24/outline';
import toast from 'react-hot-toast';

// Works with BOTH shaped documents ({id, originalName, contentType, name}) and raw
// Dataverse rows ({hr_hrdocumentid, hr_originalname, hr_contenttype, hr_name}).
const idOf = (d) => d.id || d.hr_hrdocumentid;
const nameOf = (d) => d.originalName || d.hr_originalname || d.name || d.hr_name || 'document';
const ctypeOf = (d) => d.contentType || d.hr_contenttype || '';
const extOf = (n) => (String(n || '').toLowerCase().match(/\.[a-z0-9]+$/) || [''])[0];

// How to VIEW a document by its filename / mime.
function kindOf(d) {
  const e = extOf(nameOf(d)); const ct = ctypeOf(d);
  if (e === '.pdf' || ct === 'application/pdf') return 'pdf';
  if (['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg'].includes(e) || ct.startsWith('image/')) return 'image';
  if (e === '.txt' || e === '.md' || ct === 'text/plain') return 'text';
  if (e === '.csv' || ct === 'text/csv') return 'csv';
  return 'other';   // docx/xlsx/pptx/zip/rar/mp4/… → download (auth-protected, so no Office/online preview)
}

// Minimal CSV parser (quoted fields + commas) for the table preview.
function parseCsv(text) {
  const rows = []; let row = [], field = '', inQ = false;
  const s = String(text || '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQ) { if (c === '"' && s[i + 1] === '"') { field += '"'; i++; } else if (c === '"') inQ = false; else field += c; }
    else if (c === '"') inQ = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c !== '\r') field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter(r => r.some(c => String(c).trim() !== '')).slice(0, 500);
}

function PreviewModal({ item, onClose }) {
  const { d, kind, url, text, rows } = item;
  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/50 backdrop-blur-sm p-0 sm:p-4" onClick={onClose}>
      <div className="bg-white w-full h-full sm:h-[85vh] sm:max-w-4xl sm:rounded-2xl shadow-2xl flex flex-col overflow-hidden" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-4 sm:px-6 py-3 border-b border-gray-100">
          <p className="text-sm font-semibold text-gray-900 truncate">{nameOf(d)}</p>
          <button onClick={onClose} className="p-2 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded-lg"><XMarkIcon className="w-5 h-5" /></button>
        </div>
        <div className="flex-1 overflow-auto bg-gray-50">
          {kind === 'pdf' && <iframe title={nameOf(d)} src={url} className="w-full h-full min-h-[70vh]" />}
          {kind === 'image' && <div className="w-full h-full flex items-center justify-center p-4"><img src={url} alt={nameOf(d)} className="max-w-full max-h-full object-contain" /></div>}
          {kind === 'text' && <pre className="p-4 text-xs text-gray-800 whitespace-pre-wrap break-words font-mono">{text}</pre>}
          {kind === 'csv' && (
            <div className="p-3 overflow-auto">
              <table className="w-full text-xs border-collapse"><tbody>
                {rows.map((r, i) => (
                  <tr key={i} className={i === 0 ? 'bg-gray-100 font-semibold' : 'odd:bg-white even:bg-gray-50'}>
                    {r.map((c, j) => <td key={j} className="border border-gray-200 px-2 py-1 whitespace-nowrap">{c}</td>)}
                  </tr>
                ))}
              </tbody></table>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * Shared, authenticated document view/download for EVERY consumer (Documents tab,
 * HR Verification, Employee Detail…). Fetches the file through the authenticated
 * API (/documents/:id/file) as a blob — correct Content-Type, original filename,
 * and never the public /uploads link that broke non-PDF types.
 *
 * Usage:
 *   const { view, download, viewer } = useDocumentViewer();
 *   <button onClick={() => view(doc)}>View</button>
 *   <button onClick={() => download(doc)}>Download</button>
 *   {viewer}
 */
export function useDocumentViewer() {
  const [preview, setPreview] = useState(null);

  const download = async (d) => {
    try {
      const res = await documentApi.file(idOf(d), true);
      const url = URL.createObjectURL(new Blob([res.data], { type: ctypeOf(d) || 'application/octet-stream' }));
      const a = document.createElement('a'); a.href = url; a.download = nameOf(d); a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch { toast.error('Download failed — the file may be missing on the server.'); }
  };

  const view = async (d) => {
    const kind = kindOf(d);
    if (kind === 'other') return download(d);   // Office/zip/media → download
    try {
      const res = await documentApi.file(idOf(d), false);
      const blob = new Blob([res.data], { type: ctypeOf(d) || 'application/octet-stream' });
      if (kind === 'pdf' || kind === 'image') setPreview({ d, kind, url: URL.createObjectURL(blob) });
      else if (kind === 'text') setPreview({ d, kind, text: await blob.text() });
      else if (kind === 'csv') setPreview({ d, kind, rows: parseCsv(await blob.text()) });
    } catch { toast.error('Preview failed — the file may be missing on the server.'); }
  };

  const close = () => { if (preview?.url) URL.revokeObjectURL(preview.url); setPreview(null); };
  const viewer = preview ? createPortal(<PreviewModal item={preview} onClose={close} />, document.body) : null;

  return { view, download, viewer };
}
