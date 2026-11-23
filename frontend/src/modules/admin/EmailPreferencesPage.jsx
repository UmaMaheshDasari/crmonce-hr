import { useState, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { emailPrefApi } from '../../api/endpoints';
import Button from '../../components/Button';
import { EnvelopeIcon, MagnifyingGlassIcon } from '@heroicons/react/24/outline';
import toast from 'react-hot-toast';

// A single category ON/OFF toggle.
function Toggle({ checked, disabled, onChange, label }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-6 w-11 flex-shrink-0 items-center rounded-full transition-colors disabled:opacity-50 ${checked ? 'bg-emerald-500' : 'bg-gray-300'}`}
    >
      <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${checked ? 'translate-x-6' : 'translate-x-1'}`} />
    </button>
  );
}

export default function EmailPreferencesPage() {
  const qc = useQueryClient();
  const [search, setSearch] = useState('');
  const [selectedId, setSelectedId] = useState('');
  const [draft, setDraft] = useState(null);   // local edits { category: bool } or null (= in sync)

  // Employees the caller may manage (HR → all, manager → reportees, else self).
  const { data: empRes, isLoading: empLoading } = useQuery({
    queryKey: ['email-pref-employees'],
    queryFn: () => emailPrefApi.employees().then(r => r.data?.data || []),
  });
  const employees = useMemo(() => empRes || [], [empRes]);
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return employees;
    return employees.filter(e =>
      (e.name || '').toLowerCase().includes(q) ||
      String(e.employeeId || '').toLowerCase().includes(q) ||
      (e.department || '').toLowerCase().includes(q));
  }, [employees, search]);

  // Selected employee's current preferences + the category registry.
  const { data: prefRes, isLoading: prefLoading } = useQuery({
    queryKey: ['email-pref', selectedId],
    queryFn: () => emailPrefApi.get(selectedId).then(r => r.data?.data),
    enabled: !!selectedId,
  });
  const categories = prefRes?.categories || [];
  const savedPrefs = prefRes?.preferences || {};
  const selectedEmp = prefRes?.employee || employees.find(e => e.id === selectedId) || null;

  // The effective toggle state = local draft (if editing) else the saved prefs.
  const current = draft || savedPrefs;
  const dirty = !!draft && Object.keys(draft).some(k => draft[k] !== savedPrefs[k]);

  const setCat = (key, val) => setDraft(d => ({ ...(d || savedPrefs), [key]: val }));

  const saveMut = useMutation({
    mutationFn: () => emailPrefApi.update(selectedId, current),
    onSuccess: () => { toast.success('Email preferences saved'); setDraft(null); qc.invalidateQueries({ queryKey: ['email-pref', selectedId] }); },
    onError: (e) => toast.error(e.response?.data?.error || 'Failed to save preferences'),
  });

  const resetMut = useMutation({
    mutationFn: () => emailPrefApi.reset(selectedId),
    onSuccess: () => { toast.success('Reset to defaults (all enabled)'); setDraft(null); qc.invalidateQueries({ queryKey: ['email-pref', selectedId] }); },
    onError: (e) => toast.error(e.response?.data?.error || 'Failed to reset'),
  });

  const busy = saveMut.isPending || resetMut.isPending;

  const onReset = () => {
    if (window.confirm('Reset ALL email categories to enabled for this employee?')) resetMut.mutate();
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <div className="w-10 h-10 bg-indigo-100 rounded-xl flex items-center justify-center">
          <EnvelopeIcon className="w-5 h-5 text-indigo-600" />
        </div>
        <div>
          <h1 className="text-2xl font-bold text-gray-900 tracking-tight">Email Notification Settings</h1>
          <p className="text-sm text-gray-500">Control which categories of automated emails each employee receives. All categories are enabled by default.</p>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Employee picker */}
        <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-4 lg:col-span-1">
          <div className="relative mb-3">
            <MagnifyingGlassIcon className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
            <input
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search by name, ID or department…"
              className="w-full pl-9 pr-3 py-2.5 bg-gray-50 border border-gray-200 rounded-xl text-sm focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-400 outline-none"
            />
          </div>
          <div className="max-h-[28rem] overflow-y-auto divide-y divide-gray-50">
            {empLoading ? (
              <p className="text-sm text-gray-400 py-6 text-center">Loading employees…</p>
            ) : filtered.length === 0 ? (
              <p className="text-sm text-gray-400 py-6 text-center">No employees found.</p>
            ) : filtered.map(e => (
              <button
                key={e.id}
                onClick={() => { setSelectedId(e.id); setDraft(null); }}
                className={`w-full text-left px-3 py-2.5 rounded-lg transition-colors ${selectedId === e.id ? 'bg-indigo-50' : 'hover:bg-gray-50'}`}
              >
                <p className="text-sm font-semibold text-gray-800">{e.name || 'Employee'}</p>
                <p className="text-xs text-gray-400">{[e.employeeId, e.department].filter(Boolean).join(' · ') || '—'}</p>
              </button>
            ))}
          </div>
        </div>

        {/* Category toggles */}
        <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5 lg:col-span-2">
          {!selectedId ? (
            <div className="py-16 text-center text-gray-400">
              <EnvelopeIcon className="w-10 h-10 mx-auto mb-2 text-gray-300" />
              <p className="text-sm">Select an employee to view and manage their email preferences.</p>
            </div>
          ) : prefLoading ? (
            <p className="text-sm text-gray-400 py-16 text-center">Loading preferences…</p>
          ) : (
            <>
              <div className="mb-4 pb-4 border-b border-gray-100">
                <h2 className="text-base font-bold text-gray-900">{selectedEmp?.name || 'Employee'}</h2>
                <p className="text-xs text-gray-400">{[selectedEmp?.employeeId, selectedEmp?.department].filter(Boolean).join(' · ') || '—'}</p>
              </div>
              <div className="space-y-3">
                {categories.map(c => {
                  const on = current[c.key] !== false;
                  return (
                    <div key={c.key} className="flex items-center justify-between gap-4 py-2">
                      <div className="min-w-0">
                        <p className="text-sm font-semibold text-gray-800">{c.name}</p>
                        <p className="text-xs text-gray-400">{c.description}</p>
                      </div>
                      <div className="flex items-center gap-2 flex-shrink-0">
                        <span className={`text-xs font-medium ${on ? 'text-emerald-600' : 'text-gray-400'}`}>{on ? 'On' : 'Off'}</span>
                        <Toggle checked={on} disabled={busy} onChange={v => setCat(c.key, v)} label={`${c.name} notifications`} />
                      </div>
                    </div>
                  );
                })}
              </div>
              <div className="mt-6 pt-4 border-t border-gray-100 flex flex-wrap items-center justify-end gap-3">
                <Button variant="secondary" onClick={onReset} disabled={busy}>Reset to defaults</Button>
                <Button onClick={() => saveMut.mutate()} loading={saveMut.isPending} disabled={busy || !dirty}>Save changes</Button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
