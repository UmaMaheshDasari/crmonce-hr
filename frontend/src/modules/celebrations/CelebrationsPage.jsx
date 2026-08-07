import { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { celebrationsApi } from '../../api/endpoints';
import Button from '../../components/Button';
import TodaysCelebrations from '../dashboard/TodaysCelebrations';
import { GiftIcon, PlayIcon } from '@heroicons/react/24/outline';
import { format } from 'date-fns';
import toast from 'react-hot-toast';

const inp = 'w-full h-10 px-3 bg-gray-50 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-400';
const area = 'w-full px-3 py-2 bg-gray-50 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-400 resize-y';

const EVENTS = [
  { key: 'birthday', enabled: 'birthdayEnabled', title: '🎂 Birthday Wishes' },
  { key: 'marriage_anniversary', enabled: 'marriageEnabled', title: '💐 Marriage Anniversary Wishes' },
  { key: 'work_anniversary', enabled: 'workAnnivEnabled', title: '🏆 Work Anniversary Wishes' },
];
const STATUS_PILL = {
  sent: 'bg-emerald-50 text-emerald-700', failed: 'bg-red-50 text-red-700',
  skipped: 'bg-slate-100 text-slate-600', disabled: 'bg-gray-100 text-gray-400',
};
const fmt = (d) => { try { return d ? format(new Date(d), 'dd MMM yyyy, HH:mm') : '—'; } catch { return '—'; } };

function Toggle({ checked, onChange, label }) {
  return (
    <label className="flex items-center gap-2 cursor-pointer">
      <button type="button" onClick={() => onChange(!checked)}
        className={`relative w-10 h-6 rounded-full transition-colors ${checked ? 'bg-indigo-600' : 'bg-gray-300'}`}>
        <span className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white transition-transform ${checked ? 'translate-x-4' : ''}`} />
      </button>
      <span className="text-sm font-semibold text-gray-700">{label}</span>
    </label>
  );
}

export default function CelebrationsPage() {
  const qc = useQueryClient();
  const [form, setForm] = useState(null);

  const { data: settings } = useQuery({ queryKey: ['celebration-settings'], queryFn: () => celebrationsApi.settings().then(r => r.data) });
  const { data: logsRes } = useQuery({ queryKey: ['celebration-logs'], queryFn: () => celebrationsApi.logs().then(r => r.data) });
  const logs = logsRes?.data || [];

  useEffect(() => { if (settings && !form) setForm(structuredClone(settings)); }, [settings, form]);

  const save = useMutation({
    mutationFn: () => {
      const t = form.templates;
      return celebrationsApi.updateSettings({
        hr_birthdayenabled: String(form.birthdayEnabled),
        hr_marriageenabled: String(form.marriageEnabled),
        hr_workannivenabled: String(form.workAnnivEnabled),
        hr_sendtime: form.sendTime,
        hr_birthdaysubject: t.birthday.subject, hr_birthdaybody: t.birthday.body, hr_birthdaynotif: t.birthday.notif,
        hr_marriagesubject: t.marriage_anniversary.subject, hr_marriagebody: t.marriage_anniversary.body, hr_marriagenotif: t.marriage_anniversary.notif,
        hr_worksubject: t.work_anniversary.subject, hr_workbody: t.work_anniversary.body, hr_worknotif: t.work_anniversary.notif,
      });
    },
    onSuccess: () => { toast.success('Celebration settings saved'); qc.invalidateQueries({ queryKey: ['celebration-settings'] }); },
    onError: (e) => toast.error(e.response?.data?.error || 'Failed to save'),
  });

  const run = useMutation({
    mutationFn: () => celebrationsApi.run(),
    onSuccess: (res) => {
      const total = res?.data?.total || 0;
      toast.success(total ? `Sent ${total} wish(es)` : 'No pending wishes to send right now');
      qc.invalidateQueries({ queryKey: ['celebration-logs'] });
      qc.invalidateQueries({ queryKey: ['celebrations-today'] });
    },
    onError: (e) => toast.error(e.response?.data?.error || 'Run failed'),
  });

  const setTpl = (evKey, field, val) => setForm(f => ({ ...f, templates: { ...f.templates, [evKey]: { ...f.templates[evKey], [field]: val } } }));

  if (!form) return <div className="bg-white rounded-xl border border-gray-100 p-16 text-center text-gray-400">Loading…</div>;

  return (
    <div className="space-y-6 max-w-5xl">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 tracking-tight flex items-center gap-2"><GiftIcon className="w-6 h-6 text-indigo-500" /> Celebrations</h1>
          <p className="text-sm text-gray-500 mt-1">Automated Birthday, Marriage Anniversary and Work Anniversary wishes — email + in-app, sent daily.</p>
        </div>
        <button onClick={() => run.mutate()} disabled={run.isPending}
          className="inline-flex items-center gap-2 h-10 px-4 bg-indigo-600 text-white text-sm font-semibold rounded-lg hover:bg-indigo-700 disabled:opacity-50">
          <PlayIcon className="w-4 h-4" /> {run.isPending ? 'Running…' : 'Run Now'}
        </button>
      </div>

      {/* Today's celebrations preview */}
      <TodaysCelebrations />

      {/* Settings */}
      <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-5 space-y-5">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex flex-wrap gap-5">
            <Toggle checked={form.birthdayEnabled} onChange={v => setForm(f => ({ ...f, birthdayEnabled: v }))} label="Birthday Wishes" />
            <Toggle checked={form.marriageEnabled} onChange={v => setForm(f => ({ ...f, marriageEnabled: v }))} label="Marriage Anniversary" />
            <Toggle checked={form.workAnnivEnabled} onChange={v => setForm(f => ({ ...f, workAnnivEnabled: v }))} label="Work Anniversary" />
          </div>
          <div className="flex items-center gap-2">
            <label className="text-sm font-semibold text-gray-600">Send Time</label>
            <input type="time" className="h-10 px-3 bg-gray-50 border border-gray-200 rounded-lg text-sm" value={form.sendTime} onChange={e => setForm(f => ({ ...f, sendTime: e.target.value }))} />
          </div>
        </div>

        <p className="text-xs text-gray-400">Templates support placeholders: <code className="text-indigo-600">{'{firstName}'}</code>, <code className="text-indigo-600">{'{name}'}</code>, <code className="text-indigo-600">{'{years}'}</code>, <code className="text-indigo-600">{'{department}'}</code>, <code className="text-indigo-600">{'{designation}'}</code>.</p>

        {EVENTS.map(ev => (
          <div key={ev.key} className="rounded-xl border border-gray-100 p-4 space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-bold text-gray-800">{ev.title}</h3>
              <span className={`text-[11px] font-semibold px-2 py-0.5 rounded-full ${form[ev.enabled] ? 'bg-emerald-50 text-emerald-700' : 'bg-gray-100 text-gray-400'}`}>{form[ev.enabled] ? 'Enabled' : 'Disabled'}</span>
            </div>
            <div>
              <label className="block text-xs font-semibold text-gray-600 mb-1">Email Subject</label>
              <input className={inp} value={form.templates[ev.key].subject} onChange={e => setTpl(ev.key, 'subject', e.target.value)} />
            </div>
            <div>
              <label className="block text-xs font-semibold text-gray-600 mb-1">Email Body</label>
              <textarea rows={4} className={area} value={form.templates[ev.key].body} onChange={e => setTpl(ev.key, 'body', e.target.value)} />
            </div>
            <div>
              <label className="block text-xs font-semibold text-gray-600 mb-1">In-App Notification</label>
              <input className={inp} value={form.templates[ev.key].notif} onChange={e => setTpl(ev.key, 'notif', e.target.value)} />
            </div>
          </div>
        ))}

        <div className="flex justify-end">
          <Button onClick={() => save.mutate()} loading={save.isPending}>Save Settings</Button>
        </div>
      </div>

      {/* Audit log */}
      <div className="bg-white rounded-xl border border-gray-100 shadow-sm overflow-hidden">
        <div className="px-5 py-4 border-b border-gray-100"><h2 className="text-base font-bold text-gray-900">Audit Log</h2></div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-gray-500">
              <tr className="text-left">
                <th className="px-4 py-3 font-semibold">Employee</th>
                <th className="px-4 py-3 font-semibold">Event</th>
                <th className="px-4 py-3 font-semibold">Date</th>
                <th className="px-4 py-3 font-semibold">Sent At</th>
                <th className="px-4 py-3 font-semibold">Email</th>
                <th className="px-4 py-3 font-semibold">Notification</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {logs.length === 0 ? (
                <tr><td colSpan={6} className="px-4 py-10 text-center text-gray-400">No celebration activity yet.</td></tr>
              ) : logs.map(l => (
                <tr key={l.id} className="hover:bg-gray-50/50">
                  <td className="px-4 py-3 font-medium text-gray-800">{l.employeeName || '—'}</td>
                  <td className="px-4 py-3 text-gray-600">{l.typeLabel}</td>
                  <td className="px-4 py-3 text-gray-600">{l.date}</td>
                  <td className="px-4 py-3 text-gray-500">{fmt(l.time || l.createdOn)}</td>
                  <td className="px-4 py-3"><span className={`inline-flex text-[11px] font-semibold px-2 py-0.5 rounded-full capitalize ${STATUS_PILL[l.emailStatus] || STATUS_PILL.skipped}`}>{l.emailStatus || '—'}</span></td>
                  <td className="px-4 py-3"><span className={`inline-flex text-[11px] font-semibold px-2 py-0.5 rounded-full capitalize ${STATUS_PILL[l.notificationStatus] || STATUS_PILL.skipped}`}>{l.notificationStatus || '—'}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
