import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { payrollSettingsApi } from '../../api/endpoints';
import { Cog6ToothIcon, PlusIcon, TrashIcon } from '@heroicons/react/24/outline';
import toast from 'react-hot-toast';

// Scalar fields, grouped. Each maps 1:1 to a hr_payrollsettings column.
const SECTIONS = [
  {
    title: 'Provident Fund', hint: 'Statutory PF contribution',
    fields: [
      { name: 'hr_pfemployeepercent', label: 'PF Employee %', type: 'number', step: '0.01', suffix: '%' },
      { name: 'hr_pfemployerpercent', label: 'PF Employer %', type: 'number', step: '0.01', suffix: '%' },
      { name: 'hr_pfwageceiling', label: 'PF Wage Ceiling (₹/month)', type: 'number', hint: '0 = no cap' },
      { name: 'hr_pfapplicable', label: 'PF Applicable', toggle: true },
    ],
  },
  {
    title: 'Professional Tax',
    hint: 'Auto-calculated by slab — ₹0 up to ₹15,000 · ₹150 for ₹15,001–₹20,000 · ₹200 above ₹20,000. The toggle only switches PT off entirely.',
    fields: [
      { name: 'hr_ptapplicable', label: 'Applicable', toggle: true },
    ],
  },
  {
    title: 'Income Tax (TDS)',
    fields: [
      { name: 'hr_itpercent', label: 'Flat Income Tax %', type: 'number', step: '0.01', suffix: '%', hint: 'Optional override; 0 = none' },
      { name: 'hr_itapplicable', label: 'Applicable', toggle: true },
    ],
  },
  {
    title: 'Attendance & Overtime',
    fields: [
      { name: 'hr_workinghoursperday', label: 'Working Hours / Day', type: 'number', step: '0.5' },
      { name: 'hr_otmultiplier', label: 'Overtime Multiplier (× hourly)', type: 'number', step: '0.25' },
      { name: 'hr_weeklyoff', label: 'Weekly Off', hint: 'Comma-separated, e.g. Sunday' },
      { name: 'hr_lopbasis', label: 'LOP Basis (Per-Day Salary)', select: [
        ['salary_working_days', 'Gross ÷ Salary Working Days'],
        ['calendar_days', 'Gross ÷ Calendar Days'],
        ['fixed_30', 'Gross ÷ 30'],
      ] },
    ],
  },
  {
    title: 'Leave Policy — drives LOP', hint: 'Paid leave before extra leave becomes Loss of Pay',
    fields: [
      { name: 'hr_paidleavesperyear', label: 'Paid Leaves / Year', type: 'number' },
      { name: 'hr_casualleaves', label: 'Casual Leaves', type: 'number' },
      { name: 'hr_sickleaves', label: 'Sick Leaves', type: 'number' },
      { name: 'hr_maxbackdatedleavedays', label: 'Maximum Backdated Leave Days', type: 'number', hint: 'Employees may apply leave up to this many days in the past. Default 30.' },
    ],
  },
  {
    title: 'Late Login',
    hint: 'Employees can submit a Late Login request (approved by manager → HR) instead of leave; attendance stays Present and no leave is deducted.',
    fields: [
      { name: 'hr_gracetime', label: 'Grace Time (minutes)', type: 'number', hint: 'Minutes after shift start before a login is "late". Default 15.' },
      { name: 'hr_maxlatelogins', label: 'Maximum Late Logins Per Month', type: 'number', hint: 'A warning is shown beyond this; HR can still approve. Default 3.' },
    ],
  },
  {
    title: 'Sick Leave — Medical Certificate',
    hint: 'Require a medical certificate (hospital report) when the CONSECUTIVE working-day Sick-Leave run (across history, ignoring weekly-offs/holidays) exceeds the threshold. e.g. 1 → mandatory for 2+ consecutive working days.',
    fields: [
      { name: 'hr_medcertrequired', label: 'Medical Certificate Required for Sick Leave', toggle: true },
      { name: 'hr_medcertafterdays', label: 'Medical Certificate Required After (days)', type: 'number', hint: 'Mandatory when the consecutive run is more than this' },
    ],
  },
  {
    title: 'Comp Off',
    hint: 'Comp-off is earned by working a holiday / weekly-off (auto-detected, HR-approved) or granted manually. It is paid leave — never LOP.',
    fields: [
      { name: 'hr_compoffautoearn', label: 'Auto-earn on Holiday / Weekly-off Work', toggle: true },
      { name: 'hr_compoffemployeeraise', label: 'Allow Employees to Raise Comp Off', toggle: true },
      { name: 'hr_compoffexpirydays', label: 'Comp Off Expiry (calendar days after worked date)', type: 'number', hint: '0 = never expires. Default 45. A daily job expires overdue comp-off and notifies the employee.' },
    ],
  },
  {
    title: 'Earned Leave',
    hint: 'Optional. When enabled, an Earned Leave card (Allocated / Used / Remaining) appears on the Leave dashboard.',
    fields: [
      { name: 'hr_earnedleaveenabled', label: 'Earned Leave Enabled', toggle: true },
      { name: 'hr_earnedleaves', label: 'Earned Leaves / Year (Allocated)', type: 'number' },
    ],
  },
];

// A friendly editor for a JSON list of { name, type: 'fixed'|'percent', value }.
function ComponentEditor({ title, subtitle, items, setItems, addLabel }) {
  const update = (i, key, val) => setItems(items.map((it, idx) => idx === i ? { ...it, [key]: val } : it));
  const remove = (i) => setItems(items.filter((_, idx) => idx !== i));
  const add = () => setItems([...items, { name: '', type: 'fixed', value: 0 }]);
  return (
    <div className="bg-white rounded-xl border border-gray-100 overflow-hidden">
      <div className="px-6 py-4 border-b border-gray-50 flex items-center justify-between">
        <div>
          <h2 className="text-sm font-bold uppercase tracking-wider text-gray-400">{title}</h2>
          {subtitle && <p className="text-xs text-gray-400 mt-0.5 normal-case font-normal tracking-normal">{subtitle}</p>}
        </div>
        <button type="button" onClick={add}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-indigo-600 bg-indigo-50 hover:bg-indigo-100 rounded-lg transition-colors">
          <PlusIcon className="w-4 h-4" /> {addLabel}
        </button>
      </div>
      <div className="p-6 space-y-3">
        {items.length === 0 && <p className="text-sm text-gray-400">None configured. Click "{addLabel}" to add one.</p>}
        {items.map((it, i) => (
          <div key={i} className="flex items-center gap-2.5">
            <input value={it.name} onChange={e => update(i, 'name', e.target.value)} placeholder="Component name"
              className="flex-1 h-10 px-3 bg-gray-50 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-400 focus:bg-white transition-all" />
            <select value={it.type} onChange={e => update(i, 'type', e.target.value)}
              className="h-10 px-2 bg-gray-50 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-400">
              <option value="fixed">Fixed ₹</option>
              <option value="percent">% of Basic</option>
            </select>
            <input type="number" step="0.01" value={it.value} onChange={e => update(i, 'value', e.target.value)}
              className="w-28 h-10 px-3 bg-gray-50 border border-gray-200 rounded-lg text-sm text-right focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-400 focus:bg-white transition-all" />
            <button type="button" onClick={() => remove(i)} className="p-2 text-gray-300 hover:text-red-500 transition-colors">
              <TrashIcon className="w-4.5 h-4.5" />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

export default function PayrollSettingsPage() {
  const qc = useQueryClient();
  const { register, handleSubmit, reset, watch, setValue, formState: { isDirty } } = useForm();
  const [allowances, setAllowances] = useState([]);
  const [deductions, setDeductions] = useState([]);
  const [listsDirty, setListsDirty] = useState(false);

  const { data, isLoading } = useQuery({ queryKey: ['payroll-settings'], queryFn: payrollSettingsApi.get });
  const settings = data?.data;

  useEffect(() => {
    if (!settings) return;
    reset(settings);
    setAllowances(Array.isArray(settings.resolved?.defaultAllowances) ? settings.resolved.defaultAllowances : []);
    setDeductions(Array.isArray(settings.resolved?.defaultDeductions) ? settings.resolved.defaultDeductions : []);
    setListsDirty(false);
  }, [settings, reset]);

  const mutation = useMutation({
    mutationFn: (values) => payrollSettingsApi.update(values),
    onSuccess: () => { toast.success('Payroll settings saved'); qc.invalidateQueries({ queryKey: ['payroll-settings'] }); },
    onError: (err) => toast.error(err.response?.data?.error || 'Failed to save payroll settings'),
  });

  const onSubmit = (values) => {
    // Normalise the component lists (drop blank rows, coerce numbers) → JSON columns.
    const clean = (rows) => rows
      .filter(r => String(r.name || '').trim())
      .map(r => ({ name: String(r.name).trim(), type: r.type === 'percent' ? 'percent' : 'fixed', value: Number(r.value) || 0 }));
    mutation.mutate({
      ...values,
      hr_defaultallowances: JSON.stringify(clean(allowances)),
      hr_defaultdeductions: JSON.stringify(clean(deductions)),
    });
  };

  const setList = (setter) => (v) => { setter(v); setListsDirty(true); };
  const dirty = isDirty || listsDirty;

  const Toggle = ({ name }) => {
    const on = /^(true|yes|1|on)$/i.test(String(watch(name) ?? ''));
    return (
      <button type="button" onClick={() => setValue(name, on ? 'false' : 'true', { shouldDirty: true })}
        className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${on ? 'bg-indigo-600' : 'bg-gray-300'}`}>
        <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${on ? 'translate-x-6' : 'translate-x-1'}`} />
      </button>
    );
  };

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      <div className="flex items-center gap-3">
        <div className="w-10 h-10 bg-gradient-to-br from-indigo-500 to-indigo-700 rounded-xl flex items-center justify-center shadow-lg shadow-indigo-500/20">
          <Cog6ToothIcon className="w-5 h-5 text-white" />
        </div>
        <div>
          <h1 className="text-2xl font-bold text-gray-900 tracking-tight">Payroll Settings</h1>
          <p className="text-sm text-gray-400">Every payroll number comes from here — nothing is hardcoded. Configure PF, tax, LOP, overtime and leave policy.</p>
        </div>
      </div>

      {isLoading ? (
        <div className="bg-white rounded-xl border border-gray-100 p-16 text-center text-gray-400">Loading…</div>
      ) : (
        <form onSubmit={handleSubmit(onSubmit)} className="space-y-6">
          {SECTIONS.map(section => (
            <div key={section.title} className="bg-white rounded-xl border border-gray-100 overflow-hidden">
              <div className="px-6 py-4 border-b border-gray-50">
                <h2 className="text-sm font-bold uppercase tracking-wider text-gray-400">{section.title}</h2>
                {section.hint && <p className="text-xs text-gray-400 mt-0.5">{section.hint}</p>}
              </div>
              <div className="p-6 grid grid-cols-1 sm:grid-cols-2 gap-5">
                {section.fields.map(f => (
                  <div key={f.name} className="space-y-1.5">
                    <label className="block text-sm font-semibold text-gray-700">{f.label}</label>
                    {f.toggle ? (
                      <div className="h-11 flex items-center"><Toggle name={f.name} /></div>
                    ) : f.select ? (
                      <select
                        className="w-full h-11 px-4 bg-gray-50 border border-gray-200 rounded-xl text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-400 focus:bg-white transition-all"
                        {...register(f.name)}>
                        {f.select.map(([val, lab]) => <option key={val} value={val}>{lab}</option>)}
                      </select>
                    ) : (
                      <div className="relative">
                        <input type={f.type || 'text'} step={f.step}
                          className="w-full h-11 px-4 bg-gray-50 border border-gray-200 rounded-xl text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-400 focus:bg-white transition-all"
                          {...register(f.name)} />
                        {f.suffix && <span className="absolute right-4 top-1/2 -translate-y-1/2 text-sm text-gray-400 pointer-events-none">{f.suffix}</span>}
                      </div>
                    )}
                    {f.hint && !f.toggle && <p className="text-xs text-gray-400">{f.hint}</p>}
                  </div>
                ))}
              </div>
            </div>
          ))}

          <ComponentEditor title="Default Allowances" addLabel="Add Allowance"
            subtitle="Applied to a new employee's salary structure. Percent = % of Basic."
            items={allowances} setItems={setList(setAllowances)} />
          <ComponentEditor title="Default Deductions" addLabel="Add Deduction"
            subtitle="Recurring deductions applied by default (Loan, Insurance, …)."
            items={deductions} setItems={setList(setDeductions)} />

          <div className="sticky bottom-0 bg-white/80 backdrop-blur-sm border-t border-gray-100 -mx-6 px-6 py-4 flex gap-3 justify-end rounded-b-xl">
            <button type="button" onClick={() => { reset(settings); setAllowances(settings?.resolved?.defaultAllowances || []); setDeductions(settings?.resolved?.defaultDeductions || []); setListsDirty(false); }}
              className="px-4 py-2 text-sm font-medium text-gray-600 hover:text-gray-800 transition-colors">Reset</button>
            <button type="submit" disabled={mutation.isPending || !dirty}
              className="px-5 py-2.5 bg-gradient-to-r from-indigo-600 to-indigo-700 text-white text-sm font-medium rounded-xl hover:from-indigo-700 hover:to-indigo-800 disabled:opacity-50 disabled:cursor-not-allowed shadow-lg shadow-indigo-500/25 transition-all">
              {mutation.isPending ? 'Saving…' : 'Save Changes'}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
