import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { companyApi } from '../../api/endpoints';
import { CurrencyDollarIcon, GlobeAltIcon, ClockIcon } from '@heroicons/react/24/outline';
import toast from 'react-hot-toast';
import PayrollSettingsPage from '../payroll/PayrollSettingsPage';
import SettingHistoryPage from './SettingHistoryPage';
import { useAuth } from '../../context/AuthContext';

// General tab = company identity + locale/calendar. Everything is company-configurable
// and stored in hr_companysettings (single source of truth) — never hard-coded.
const SECTIONS = [
  {
    title: 'Identity',
    fields: [
      { name: 'hr_name', label: 'Company Name', required: true, full: true },
      { name: 'hr_gstin', label: 'GSTIN / Tax ID' },
      { name: 'hr_cin', label: 'CIN / Registration No.' },
      { name: 'hr_companytype', label: 'Company Type' },
      { name: 'hr_incorporationdate', label: 'Date of Incorporation', type: 'date' },
      { name: 'hr_roc', label: 'ROC' },
      { name: 'hr_director', label: 'Director / Owner' },
    ],
  },
  {
    title: 'Registered Office',
    fields: [
      { name: 'hr_addressline', label: 'Address', full: true },
      { name: 'hr_city', label: 'City' },
      { name: 'hr_state', label: 'State / Province' },
      { name: 'hr_country', label: 'Country' },
      { name: 'hr_pincode', label: 'Postal Code' },
    ],
  },
  {
    title: 'Contact & Branding',
    fields: [
      { name: 'hr_email', label: 'Email', type: 'email' },
      { name: 'hr_phone', label: 'Phone' },
      { name: 'hr_website', label: 'Website' },
      { name: 'hr_logourl', label: 'Logo URL' },
      { name: 'hr_authorizedcapital', label: 'Authorized Share Capital' },
      { name: 'hr_paidupcapital', label: 'Paid-up Share Capital' },
    ],
  },
  {
    title: 'Localization & Calendar',
    hint: 'Company-specific — the app never hard-codes India / INR / IST. Each company sets its own.',
    fields: [
      { name: 'hr_currency', label: 'Currency Code', hint: 'e.g. INR, USD, EUR, AED' },
      { name: 'hr_currencysymbol', label: 'Currency Symbol', hint: 'e.g. ₹, $, €' },
      { name: 'hr_timezone', label: 'Time Zone', select: ['Asia/Kolkata', 'Asia/Dubai', 'Asia/Singapore', 'Europe/London', 'America/New_York', 'America/Los_Angeles', 'Australia/Sydney', 'UTC'] },
      { name: 'hr_dateformat', label: 'Date Format', select: ['DD MMM YYYY', 'DD/MM/YYYY', 'MM/DD/YYYY', 'YYYY-MM-DD'] },
      { name: 'hr_timeformat', label: 'Time Format', select: ['12h', '24h'] },
      { name: 'hr_financialyearstart', label: 'Financial Year Start (MM-DD)', hint: 'e.g. 04-01 (India), 01-01' },
      { name: 'hr_leaveyearstart', label: 'Leave Year Start (MM-DD)', hint: 'e.g. 01-01' },
    ],
  },
  {
    title: 'HR Policy',
    fields: [{ name: 'hr_requireddocs', label: 'Required Documents for 100% profile (comma-separated)', full: true, textarea: true }],
  },
];

function GeneralTab() {
  const { hasPermission } = useAuth();
  const canEditSettings = hasPermission('settings.edit');   // RBAC Phase D (page also route-gated to super_admin)
  const qc = useQueryClient();
  const { register, handleSubmit, reset, formState: { errors, isDirty } } = useForm();
  const { data, isLoading } = useQuery({ queryKey: ['company'], queryFn: companyApi.get });
  const company = data?.data;
  useEffect(() => { if (company) reset(company); }, [company, reset]);

  const mutation = useMutation({
    mutationFn: (values) => companyApi.update(values),
    onSuccess: () => { toast.success('Company settings saved'); qc.invalidateQueries({ queryKey: ['company'] }); },
    onError: (err) => toast.error(err.response?.data?.error || 'Failed to save company settings'),
  });

  if (isLoading) return <div className="bg-white rounded-xl border border-gray-100 p-16 text-center text-gray-400">Loading…</div>;

  return (
    <form onSubmit={handleSubmit(v => mutation.mutate(v))} className="space-y-6">
      {company?.modifiedon && (
        <p className="text-xs text-gray-400">Last updated {new Date(company.modifiedon).toLocaleString()}</p>
      )}
      {SECTIONS.map(section => (
        <div key={section.title} className="bg-white rounded-xl border border-gray-100 overflow-hidden">
          <div className="px-6 py-4 border-b border-gray-50">
            <h2 className="text-sm font-bold uppercase tracking-wider text-gray-400">{section.title}</h2>
            {section.hint && <p className="text-xs text-gray-400 mt-0.5 normal-case tracking-normal">{section.hint}</p>}
          </div>
          <div className="p-6 grid grid-cols-1 sm:grid-cols-2 gap-5">
            {section.fields.map(f => (
              <div key={f.name} className={`space-y-1.5 ${f.full ? 'sm:col-span-2' : ''}`}>
                <label className="block text-sm font-semibold text-gray-700">{f.label}{f.required && <span className="text-red-500 ml-0.5">*</span>}</label>
                {f.textarea ? (
                  <textarea rows={3} className="w-full px-4 py-2.5 bg-gray-50 border border-gray-200 rounded-xl text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-400 focus:bg-white transition-all resize-none"
                    {...register(f.name, f.required ? { required: `${f.label} is required` } : {})} />
                ) : f.select ? (
                  <select className="w-full h-11 px-4 bg-gray-50 border border-gray-200 rounded-xl text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-400 focus:bg-white transition-all" {...register(f.name)}>
                    {f.select.map(o => <option key={o} value={o}>{o}</option>)}
                  </select>
                ) : (
                  <input type={f.type || 'text'} className={`w-full h-11 px-4 bg-gray-50 border ${errors[f.name] ? 'border-red-300 ring-2 ring-red-100' : 'border-gray-200'} rounded-xl text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-400 focus:bg-white transition-all`}
                    {...register(f.name, f.required ? { required: `${f.label} is required` } : {})} />
                )}
                {f.hint && !f.textarea && <p className="text-xs text-gray-400">{f.hint}</p>}
                {errors[f.name] && <p className="text-xs text-red-500 font-medium">{errors[f.name].message}</p>}
              </div>
            ))}
          </div>
        </div>
      ))}
      <div className="sticky bottom-0 bg-white/80 backdrop-blur-sm border-t border-gray-100 -mx-6 px-6 py-4 flex gap-3 justify-end rounded-b-xl">
        <button type="button" onClick={() => reset(company)} className="px-4 py-2 text-sm font-medium text-gray-600 hover:text-gray-800 transition-colors">Reset</button>
        {canEditSettings && <button type="submit" disabled={mutation.isPending || !isDirty}
          className="px-5 py-2.5 bg-gradient-to-r from-indigo-600 to-indigo-700 text-white text-sm font-medium rounded-xl hover:from-indigo-700 hover:to-indigo-800 disabled:opacity-50 disabled:cursor-not-allowed shadow-lg shadow-indigo-500/25 transition-all">
          {mutation.isPending ? 'Saving…' : 'Save Changes'}
        </button>}
      </div>
    </form>
  );
}

// Company Settings tabs. Each tab reuses the EXISTING settings screen/service — no
// duplicate stores. To keep every setting in exactly ONE navigation location, only
// settings whose audience matches this (Super-Admin) page are embedded here:
//   • General  → company identity + locale (this page)
//   • Payroll & Policies → the Payroll Settings master form (its standalone sidebar
//     entry is removed, so it lives ONLY here + its /payroll-settings route)
// Professional Tax, Holidays and Celebrations keep their OWN sidebar entries (they
// are HR-manager / employee facing) so they are not duplicated here.
const TABS = [
  { key: 'general', label: 'General', icon: GlobeAltIcon, render: () => <GeneralTab /> },
  { key: 'payroll', label: 'Payroll & Policies', icon: CurrencyDollarIcon, render: () => <PayrollSettingsPage /> },
  { key: 'history', label: 'Setting History', icon: ClockIcon, render: () => <SettingHistoryPage /> },
];

export default function CompanySettingsPage() {
  const [tab, setTab] = useState('general');
  const active = TABS.find(t => t.key === tab) || TABS[0];

  return (
    <div className="max-w-5xl mx-auto space-y-6">
      <div className="flex items-center gap-3">
        <div className="w-10 h-10 bg-gradient-to-br from-indigo-500 to-indigo-700 rounded-xl flex items-center justify-center shadow-lg shadow-indigo-500/20">
          <GlobeAltIcon className="w-5 h-5 text-white" />
        </div>
        <div>
          <h1 className="text-2xl font-bold text-gray-900 tracking-tight">Company Settings</h1>
          <p className="text-sm text-gray-400">The single source of truth for every company policy — attendance, leave, payroll, tax, notifications. Multi-company ready; nothing hard-coded.</p>
        </div>
      </div>

      {/* Tab bar */}
      <div className="bg-white rounded-xl border border-gray-100 p-1.5 flex gap-1 overflow-x-auto">
        {TABS.map(t => (
          <button key={t.key} onClick={() => setTab(t.key)}
            className={`inline-flex items-center gap-2 px-4 py-2 text-sm font-semibold rounded-lg whitespace-nowrap transition-colors ${tab === t.key ? 'bg-indigo-600 text-white shadow-sm' : 'text-gray-600 hover:bg-gray-50'}`}>
            <t.icon className="w-4 h-4" /> {t.label}
          </button>
        ))}
      </div>

      {/* Active tab. Embedded policy tabs render the existing settings screen (reused
          service, no duplication). Their own outer container is neutralized here. */}
      <div className="[&>div]:max-w-none [&>div]:mx-0">
        {active.render()}
      </div>
    </div>
  );
}
