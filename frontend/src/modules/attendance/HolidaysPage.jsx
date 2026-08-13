import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { format } from 'date-fns';
import toast from 'react-hot-toast';
import { CalendarDaysIcon, TrashIcon, PlusIcon, PencilSquareIcon } from '@heroicons/react/24/outline';
import { holidayApi } from '../../api/endpoints';
import { useAuth } from '../../context/AuthContext';
import Button from '../../components/Button';

const HOLIDAY_TYPES = ['National', 'Festival', 'Company', 'Optional'];
const TYPE_COLOR = { National: 'bg-blue-50 text-blue-700', Festival: 'bg-rose-50 text-rose-700', Company: 'bg-indigo-50 text-indigo-700', Optional: 'bg-amber-50 text-amber-700' };
const EMPTY = { date: '', name: '', description: '', type: 'Festival', department: '', status: 'active', remarks: '' };

export default function HolidaysPage() {
  const { isHR } = useAuth();
  const qc = useQueryClient();
  const [form, setForm] = useState(EMPTY);
  const [editId, setEditId] = useState(null);

  const { data, isLoading } = useQuery({
    queryKey: ['holidays'],
    queryFn: () => holidayApi.list(),
    placeholderData: (prev) => prev,
  });
  const holidays = data?.data?.data || [];

  const add = useMutation({
    mutationFn: () => (editId ? holidayApi.update(editId, form) : holidayApi.add(form)),
    onSuccess: () => { toast.success(editId ? 'Holiday updated' : 'Holiday added'); setForm(EMPTY); setEditId(null); qc.invalidateQueries({ queryKey: ['holidays'] }); },
    onError: (e) => {
      if (e.response?.status === 409 || e.response?.data?.duplicate) {
        if (window.confirm(e.response.data.error + ' Add anyway?')) { holidayApi.add({ ...form, overwrite: true }).then(() => { toast.success('Holiday added'); setForm(EMPTY); qc.invalidateQueries({ queryKey: ['holidays'] }); }).catch(() => toast.error('Failed')); }
      } else toast.error(e.response?.data?.error || 'Could not save holiday');
    },
  });
  const startEdit = (h) => { setEditId(h.id); setForm({ date: h.date, name: h.name, description: h.description || '', type: h.type || 'Festival', department: h.department || '', status: h.status || 'active', remarks: h.remarks || '' }); };
  const remove = useMutation({
    mutationFn: (id) => holidayApi.remove(id),
    onSuccess: () => { toast.success('Holiday removed'); qc.invalidateQueries({ queryKey: ['holidays'] }); },
    onError: (e) => toast.error(e.response?.data?.error || 'Could not remove holiday'),
  });

  const fmt = (d) => { try { return format(new Date(`${d}T00:00:00`), 'EEE, dd-MM-yyyy'); } catch { return d; } };
  const today = new Date().toISOString().slice(0, 10);
  const upcoming = holidays.filter(h => h.date >= today).sort((a, b) => a.date.localeCompare(b.date));
  const past = holidays.filter(h => h.date < today).sort((a, b) => b.date.localeCompare(a.date));

  const Row = ({ h }) => (
    <div className="flex items-center gap-3 px-4 py-3 border-b border-gray-50 last:border-0">
      <div className="w-9 h-9 rounded-lg bg-rose-50 grid place-items-center flex-shrink-0">
        <CalendarDaysIcon className="w-5 h-5 text-rose-500" />
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-semibold text-gray-800 truncate flex items-center gap-2">
          {h.name}
          {h.type && <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded ${TYPE_COLOR[h.type] || 'bg-gray-100 text-gray-600'}`}>{h.type}</span>}
          {h.status === 'inactive' && <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-gray-100 text-gray-500">Inactive</span>}
        </p>
        <p className="text-xs text-gray-400">{fmt(h.date)}{h.department ? ` · ${h.department}` : ''}{h.description ? ` · ${h.description}` : ''}</p>
      </div>
      {isHR() && (
        <div className="flex items-center gap-1">
          <button onClick={() => startEdit(h)} className="p-1.5 rounded-lg text-gray-400 hover:text-indigo-600 hover:bg-indigo-50" title="Edit">
            <PencilSquareIcon className="w-4 h-4" />
          </button>
          <button onClick={() => remove.mutate(h.id)} disabled={remove.isPending}
            className="p-1.5 rounded-lg text-gray-400 hover:text-red-600 hover:bg-red-50 disabled:opacity-50" title="Remove">
            <TrashIcon className="w-4 h-4" />
          </button>
        </div>
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
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-bold text-gray-900">{editId ? 'Edit Holiday' : 'Add Holiday'} <span className="font-normal text-gray-400">— past dates allowed (historical)</span></h2>
            {editId && <button onClick={() => { setEditId(null); setForm(EMPTY); }} className="text-xs font-semibold text-gray-500 hover:text-gray-700">Cancel edit</button>}
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
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
              <label className="block text-xs font-medium text-gray-500 mb-1">Type</label>
              <select value={form.type} onChange={e => setForm(f => ({ ...f, type: e.target.value }))}
                className="w-full px-3 py-2 bg-gray-50 border border-gray-200 rounded-lg text-sm outline-none focus:ring-2 focus:ring-indigo-500/20">
                {HOLIDAY_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">Status</label>
              <select value={form.status} onChange={e => setForm(f => ({ ...f, status: e.target.value }))}
                className="w-full px-3 py-2 bg-gray-50 border border-gray-200 rounded-lg text-sm outline-none focus:ring-2 focus:ring-indigo-500/20">
                <option value="active">Active</option>
                <option value="inactive">Inactive</option>
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">Applicable Department</label>
              <input type="text" value={form.department} onChange={e => setForm(f => ({ ...f, department: e.target.value }))} placeholder="All departments"
                className="w-full px-3 py-2 bg-gray-50 border border-gray-200 rounded-lg text-sm outline-none focus:ring-2 focus:ring-indigo-500/20" />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">Description</label>
              <input type="text" value={form.description} onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
                className="w-full px-3 py-2 bg-gray-50 border border-gray-200 rounded-lg text-sm outline-none focus:ring-2 focus:ring-indigo-500/20" />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">Remarks</label>
              <input type="text" value={form.remarks} onChange={e => setForm(f => ({ ...f, remarks: e.target.value }))}
                className="w-full px-3 py-2 bg-gray-50 border border-gray-200 rounded-lg text-sm outline-none focus:ring-2 focus:ring-indigo-500/20" />
            </div>
            <div className="flex items-end">
              <Button icon={PlusIcon} onClick={() => add.mutate()} disabled={!form.date || !form.name.trim() || add.isPending} fullWidth>
                {add.isPending ? 'Saving…' : (editId ? 'Update' : 'Add')}
              </Button>
            </div>
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
          <div className="px-4 py-3 border-b border-gray-100"><h2 className="text-sm font-bold text-gray-900">Past / Historical</h2></div>
          {past.length ? past.map(h => <Row key={h.id} h={h} />)
            : <p className="px-4 py-8 text-center text-sm text-gray-400">No past holidays.</p>}
        </div>
      </div>
    </div>
  );
}
