import { useMemo, useRef, useState } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import { importExportApi } from '../../api/endpoints';
import {
  ArrowUpTrayIcon, ArrowDownTrayIcon, DocumentArrowDownIcon, CheckCircleIcon,
  ExclamationTriangleIcon, DocumentDuplicateIcon, ArrowPathIcon, TableCellsIcon,
} from '@heroicons/react/24/outline';
import toast from 'react-hot-toast';
import { useAuth } from '../../context/AuthContext';

const EXPORTS = [
  { id: 'attendance', label: 'Attendance', desc: 'Present / absent / working days' },
  { id: 'payroll', label: 'Payroll', desc: 'Earnings, deductions, net per run' },
  { id: 'leave', label: 'Leave', desc: 'All leave requests & status' },
  { id: 'salary-register', label: 'Salary Register', desc: 'Employee salary structure (CTC)' },
  { id: 'bank-transfer', label: 'Bank Transfer Sheet', desc: 'Net pay + bank details' },
  { id: 'payslip-register', label: 'Payslip Register', desc: 'Every payslip: gross / net / status' },
];

const STATUS_BADGE = {
  valid: 'bg-emerald-50 text-emerald-700 ring-emerald-600/20',
  update: 'bg-blue-50 text-blue-700 ring-blue-600/20',
  duplicate: 'bg-amber-50 text-amber-700 ring-amber-600/20',
  error: 'bg-red-50 text-red-700 ring-red-600/20',
};

function downloadBlob(blob, filename) {
  const url = window.URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = filename; a.click();
  window.URL.revokeObjectURL(url);
}

// ── Import panel ──
function ImportPanel() {
  const { hasPermission } = useAuth();
  const canImport = hasPermission('reports.export');   // RBAC Phase D (page also route-gated to HR)
  const { data: typesRes } = useQuery({ queryKey: ['import-types'], queryFn: () => importExportApi.types() });
  const types = typesRes?.data?.types || [];
  const [type, setType] = useState('');
  const [file, setFile] = useState(null);
  const [preview, setPreview] = useState(null);
  const [result, setResult] = useState(null);
  const inputRef = useRef(null);
  const meta = useMemo(() => types.find(t => t.id === type), [types, type]);

  const previewMut = useMutation({
    mutationFn: ({ type, file }) => { const fd = new FormData(); fd.append('file', file); return importExportApi.preview(type, fd); },
    onSuccess: (res) => { setPreview(res.data); setResult(null); },
    onError: (e) => { setPreview(null); toast.error(e.response?.data?.error || 'Could not read the file'); },
  });
  const commitMut = useMutation({
    mutationFn: ({ type, file }) => { const fd = new FormData(); fd.append('file', file); return importExportApi.commit(type, fd); },
    onSuccess: (res) => { setResult(res.data); toast.success(`Imported: ${res.data.created} created, ${res.data.updated} updated`); },
    onError: (e) => toast.error(e.response?.data?.error || 'Import failed'),
  });

  const pick = (f) => { if (!f) return; setFile(f); setResult(null); if (type) previewMut.mutate({ type, file: f }); };
  const onType = (t) => { setType(t); setFile(null); setPreview(null); setResult(null); if (inputRef.current) inputRef.current.value = ''; };
  const template = async () => {
    try { const res = await importExportApi.template(type); downloadBlob(new Blob([res.data]), `${type}_template.xlsx`); }
    catch { toast.error('Failed to download template'); }
  };

  const s = preview?.summary || {};
  const importable = (s.valid || 0) + (s.updates || 0);

  return (
    <div className="space-y-4">
      {/* Type chips */}
      <div>
        <p className="text-xs font-semibold text-gray-500 mb-2">1 · Choose what to import</p>
        <div className="flex flex-wrap gap-2">
          {types.map(t => (
            <button key={t.id} onClick={() => onType(t.id)}
              className={`px-3 py-2 rounded-lg text-sm font-medium border transition-colors ${type === t.id ? 'bg-indigo-600 text-white border-indigo-600' : 'bg-white text-gray-700 border-gray-200 hover:border-indigo-300'}`}>
              {t.label}
            </button>
          ))}
        </div>
      </div>

      {type && (
        <>
          <div className="flex flex-wrap items-center gap-3">
            <button onClick={template} className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-semibold text-indigo-600 bg-indigo-50 rounded-lg hover:bg-indigo-100">
              <DocumentArrowDownIcon className="w-4 h-4" /> Download Template
            </button>
            <span className="text-xs text-gray-400">Required columns marked with *</span>
          </div>

          {/* Dropzone */}
          <div onDragOver={e => e.preventDefault()} onDrop={e => { e.preventDefault(); pick(e.dataTransfer.files?.[0]); }}
            onClick={() => inputRef.current?.click()}
            className="border-2 border-dashed border-gray-200 rounded-xl p-8 text-center cursor-pointer hover:border-indigo-300 hover:bg-indigo-50/30 transition-colors">
            <ArrowUpTrayIcon className="w-8 h-8 text-gray-300 mx-auto mb-2" />
            <p className="text-sm font-medium text-gray-600">{file ? file.name : 'Drop an .xlsx file here, or click to browse'}</p>
            <p className="text-xs text-gray-400 mt-1">{meta ? `Columns: ${meta.columns.map(c => c.header).join(', ')}` : ''}</p>
            <input ref={inputRef} type="file" accept=".xlsx" className="hidden" onChange={e => pick(e.target.files?.[0])} />
          </div>
          {previewMut.isPending && <p className="text-sm text-gray-400">Validating…</p>}

          {/* Preview */}
          {preview && (
            <div className="space-y-3">
              <p className="text-xs font-semibold text-gray-500">2 · Review & fix</p>
              <div className="flex flex-wrap gap-2">
                <Chip icon={TableCellsIcon} label="Total" value={s.total} tone="gray" />
                <Chip icon={CheckCircleIcon} label="Valid" value={s.valid} tone="emerald" />
                {s.updates > 0 && <Chip icon={ArrowPathIcon} label="Will update" value={s.updates} tone="blue" />}
                <Chip icon={DocumentDuplicateIcon} label="Duplicates" value={s.duplicates} tone="amber" />
                <Chip icon={ExclamationTriangleIcon} label="Errors" value={s.errors} tone="red" />
              </div>

              <div className="border border-gray-100 rounded-xl overflow-hidden">
                <div className="overflow-x-auto max-h-[420px]">
                  <table className="w-full text-xs">
                    <thead className="bg-gray-50 sticky top-0">
                      <tr>
                        <th className="px-3 py-2 text-left font-semibold text-gray-500">#</th>
                        <th className="px-3 py-2 text-left font-semibold text-gray-500">Status</th>
                        {preview.columns.map(c => <th key={c.key} className="px-3 py-2 text-left font-semibold text-gray-500 whitespace-nowrap">{c.header}</th>)}
                        <th className="px-3 py-2 text-left font-semibold text-gray-500">Issues</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-50">
                      {preview.rows.map(r => (
                        <tr key={r.row} className={r.status === 'error' ? 'bg-red-50/30' : r.status === 'duplicate' ? 'bg-amber-50/20' : ''}>
                          <td className="px-3 py-1.5 text-gray-400">{r.row}</td>
                          <td className="px-3 py-1.5"><span className={`px-2 py-0.5 rounded-full text-[10px] font-semibold uppercase ring-1 ${STATUS_BADGE[r.status]}`}>{r.status}</span></td>
                          {preview.columns.map(c => <td key={c.key} className="px-3 py-1.5 text-gray-700 whitespace-nowrap">{String(r.data[c.key] ?? '')}</td>)}
                          <td className="px-3 py-1.5 text-red-500">{r.errors.join('; ')}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              <div className="flex items-center justify-between">
                <p className="text-xs text-gray-400">{s.errors > 0 || s.duplicates > 0 ? 'Rows with errors or duplicates are skipped.' : 'All rows are valid.'}</p>
                {canImport && <button onClick={() => commitMut.mutate({ type, file })} disabled={commitMut.isPending || importable === 0}
                  className="px-5 py-2.5 bg-gradient-to-r from-indigo-600 to-indigo-700 text-white text-sm font-medium rounded-xl hover:from-indigo-700 hover:to-indigo-800 disabled:opacity-50 shadow-lg shadow-indigo-500/25">
                  {commitMut.isPending ? 'Importing…' : `Import ${importable} row${importable === 1 ? '' : 's'}`}
                </button>}
              </div>
            </div>
          )}

          {/* Result / error report */}
          {result && (
            <div className="bg-white border border-gray-100 rounded-xl p-4 space-y-2">
              <p className="text-sm font-bold text-gray-900">Import complete</p>
              <div className="flex flex-wrap gap-2">
                <Chip label="Created" value={result.created} tone="emerald" />
                <Chip label="Updated" value={result.updated} tone="blue" />
                <Chip label="Skipped" value={result.skipped} tone="amber" />
                <Chip label="Failed" value={result.failed} tone="red" />
              </div>
              {result.errors?.length > 0 && (
                <div className="mt-2 max-h-40 overflow-y-auto text-xs">
                  <p className="font-semibold text-red-600 mb-1">Error report</p>
                  {result.errors.map((e, i) => <p key={i} className="text-red-500">Row {e.row}: {e.message}</p>)}
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function Chip({ icon: Icon, label, value, tone }) {
  const tones = { gray: 'bg-gray-100 text-gray-600', emerald: 'bg-emerald-50 text-emerald-700', blue: 'bg-blue-50 text-blue-700', amber: 'bg-amber-50 text-amber-700', red: 'bg-red-50 text-red-700' };
  return (
    <span className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold ${tones[tone] || tones.gray}`}>
      {Icon && <Icon className="w-4 h-4" />}{label}: <span className="font-bold">{value ?? 0}</span>
    </span>
  );
}

// ── Export panel ──
function ExportPanel() {
  const now = new Date();
  const [year, setYear] = useState(now.getFullYear());
  const [busy, setBusy] = useState('');
  const run = async (e) => {
    setBusy(e.id);
    try { const res = await importExportApi.export(e.id, { year }); downloadBlob(new Blob([res.data]), `${e.id}_${year}.xlsx`); toast.success(`${e.label} downloaded`); }
    catch { toast.error(`Failed to export ${e.label}`); }
    finally { setBusy(''); }
  };
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <span className="text-sm text-gray-500">Year</span>
        <select value={year} onChange={e => setYear(Number(e.target.value))} className="h-9 px-3 bg-white border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20">
          {[now.getFullYear(), now.getFullYear() - 1, now.getFullYear() - 2].map(y => <option key={y} value={y}>{y}</option>)}
        </select>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        {EXPORTS.map(e => (
          <button key={e.id} onClick={() => run(e)} disabled={busy === e.id}
            className="text-left bg-white border border-gray-100 rounded-xl p-4 hover:border-indigo-300 hover:shadow-sm transition-all disabled:opacity-50">
            <div className="flex items-center justify-between">
              <p className="font-semibold text-gray-900">{e.label}</p>
              <ArrowDownTrayIcon className="w-4 h-4 text-indigo-500" />
            </div>
            <p className="text-xs text-gray-400 mt-1">{e.desc}</p>
            {busy === e.id && <p className="text-xs text-indigo-500 mt-1">Generating…</p>}
          </button>
        ))}
      </div>
    </div>
  );
}

export default function ImportExportPage() {
  const [tab, setTab] = useState('import');
  return (
    <div className="max-w-5xl mx-auto space-y-5">
      <div className="flex items-center gap-3">
        <div className="w-10 h-10 bg-gradient-to-br from-indigo-500 to-indigo-700 rounded-xl flex items-center justify-center shadow-lg shadow-indigo-500/20"><TableCellsIcon className="w-5 h-5 text-white" /></div>
        <div>
          <h1 className="text-2xl font-bold text-gray-900 tracking-tight">Import / Export Center</h1>
          <p className="text-sm text-gray-400">Bulk-import from Excel with validation & duplicate checks, or export HR data.</p>
        </div>
      </div>

      <div className="inline-flex bg-gray-100/80 p-1 rounded-xl gap-0.5">
        {[['import', 'Import'], ['export', 'Export']].map(([k, l]) => (
          <button key={k} onClick={() => setTab(k)} className={`px-6 py-2 rounded-lg text-sm font-semibold transition-all ${tab === k ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'}`}>{l}</button>
        ))}
      </div>

      <div className="bg-gray-50/60 rounded-2xl border border-gray-100 p-4 sm:p-6">
        {tab === 'import' ? <ImportPanel /> : <ExportPanel />}
      </div>
    </div>
  );
}
