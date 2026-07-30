import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { format } from 'date-fns';
import toast from 'react-hot-toast';
import { CalendarDaysIcon, TrashIcon, PlusIcon } from '@heroicons/react/24/outline';
import { holidayApi } from '../../api/endpoints';
import { useAuth } from '../../context/AuthContext';
import Button from '../../components/Button';

export default function HolidaysPage() {
  const { isHR } = useAuth();
  const qc = useQueryClient();
  const [form, setForm] = useState({ date: '', name: '', description: '' });

  const { data, isLoading } = useQuery({
    queryKey: ['holidays'],
    queryFn: () => holidayApi.list(),
    placeholderData: (prev) => prev,
  });
  const holidays = data?.data?.data || [];

  const add = useMutation({
    mutationFn: () => holidayApi.add(form),
    onSuccess: () => { toast.success('Holiday added'); setForm({ date: '', name: '', description: '' }); qc.invalidateQueries({ queryKey: ['holidays'] }); },
    onError: (e) => toast.error(e.response?.data?.error || 'Could not add holiday'),
  });
  const remove = useMutation({
    mutationFn: (id) => holidayApi.remove(id),
    onSuccess: () => { toast.success('Holiday removed'); qc.invalidateQueries({ queryKey: ['holidays'] }); },
    onError: (e) => toast.error(e.response?.data?.error || 'Could not remove holiday'),
  });

  const fmt = (d) => { try { return format(new Date(`${d}T00:00:00`), 'EEE, dd MMM yyyy'); } catch { return d; } };
  const today = new Date().toISOString().slice(0, 10);
  const upcoming = holidays.filter(h => h.date >= today).sort((a, b) => a.date.localeCompare(b.date));
  const past = holidays.filter(h => h.date < today).sort((a, b) => b.date.localeCompare(a.date));

  const Row = ({ h }) => (
    <div className="flex items-center gap-3 px-4 py-3 border-b border-gray-50 last:border-0">
      <div className="w-9 h-9 rounded-lg bg-rose-50 grid place-items-center flex-shrink-0">
        <CalendarDaysIcon className="w-5 h-5 text-rose-500" />
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-semibold text-gray-800 truncate">{h.name}</p>
        <p className="text-xs text-gray-400">{fmt(h.date)}{h.description ? ` · ${h.description}` : ''}</p>
      </div>
      {isHR() && (
        <button onClick={() => remove.mutate(h.id)} disabled={remove.isPending}
          className="p-1.5 rounded-lg text-gray-400 hover:text-red-600 hover:bg-red-50 disabled:opacity-50" title="Remove">
          <TrashIcon className="w-4 h-4" />
        </button>
      )}
    </div>
  );

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-xl font-bold text-gray-900">Holiday Calendar</h1>
        <p className="text-sm text-gray-400">Company holidays {isHR() ? '— add or remove; attendance excludes these days automatically.' : '— maintained by HR.'}</p>
      </div>

      {isHR() && (
        <div className="bg-white rounded-xl border border-gray-100 p-4">
          <div className="grid grid-cols-1 sm:grid-cols-[160px_1fr_1fr_auto] gap-3 items-end">
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">Date</label>
              <input type="date" value={form.date} onChange={e => setForm(f => ({ ...f, date: e.target.value }))}
                className="w-full px-3 py-2 bg-gray-50 border border-gray-200 rounded-lg text-sm outline-none focus:ring-2 focus:ring-indigo-500/20" />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">Holiday Name</label>
              <input type="text" value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder="e.g. Diwali"
                className="w-full px-3 py-2 bg-gray-50 border border-gray-200 rounded-lg text-sm outline-none focus:ring-2 focus:ring-indigo-500/20" />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">Description (optional)</label>
              <input type="text" value={form.description} onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
                className="w-full px-3 py-2 bg-gray-50 border border-gray-200 rounded-lg text-sm outline-none focus:ring-2 focus:ring-indigo-500/20" />
            </div>
            <Button icon={PlusIcon} onClick={() => add.mutate()} disabled={!form.date || !form.name.trim() || add.isPending}>
              {add.isPending ? 'Adding…' : 'Add'}
            </Button>
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        <div className="bg-white rounded-xl border border-gray-100 overflow-hidden">
          <div className="px-4 py-3 border-b border-gray-100"><h2 className="text-sm font-bold text-gray-900">Upcoming</h2></div>
          {isLoading && !holidays.length ? <p className="px-4 py-8 text-center text-sm text-gray-400">Loading…</p>
            : upcoming.length ? upcoming.map(h => <Row key={h.id} h={h} />)
              : <p className="px-4 py-8 text-center text-sm text-gray-400">No upcoming holidays.</p>}
        </div>
        <div className="bg-white rounded-xl border border-gray-100 overflow-hidden">
          <div className="px-4 py-3 border-b border-gray-100"><h2 className="text-sm font-bold text-gray-900">Past</h2></div>
          {past.length ? past.map(h => <Row key={h.id} h={h} />)
            : <p className="px-4 py-8 text-center text-sm text-gray-400">No past holidays.</p>}
        </div>
      </div>
    </div>
  );
}
