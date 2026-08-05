import { useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { companyApi } from '../../api/endpoints';
import { BuildingOffice2Icon } from '@heroicons/react/24/outline';
import toast from 'react-hot-toast';

// Field groups mirror the Company Settings table (single source of truth).
const SECTIONS = [
  {
    title: 'Identity',
    fields: [
      { name: 'hr_name', label: 'Company Name', required: true, full: true },
      { name: 'hr_gstin', label: 'GSTIN' },
      { name: 'hr_cin', label: 'CIN' },
      { name: 'hr_companytype', label: 'Company Type' },
      { name: 'hr_incorporationdate', label: 'Date of Incorporation', type: 'date' },
      { name: 'hr_roc', label: 'ROC' },
      { name: 'hr_director', label: 'Director' },
    ],
  },
  {
    title: 'Registered Office',
    fields: [
      { name: 'hr_addressline', label: 'Address', full: true },
      { name: 'hr_city', label: 'City' },
      { name: 'hr_state', label: 'State' },
      { name: 'hr_pincode', label: 'Pincode' },
    ],
  },
  {
    title: 'Capital & Contact',
    fields: [
      { name: 'hr_authorizedcapital', label: 'Authorized Share Capital (₹)' },
      { name: 'hr_paidupcapital', label: 'Paid-up Share Capital (₹)' },
      { name: 'hr_email', label: 'Email', type: 'email' },
      { name: 'hr_phone', label: 'Phone' },
      { name: 'hr_website', label: 'Website' },
      { name: 'hr_logourl', label: 'Logo URL' },
    ],
  },
  {
    title: 'Business',
    fields: [{ name: 'hr_business', label: 'Business (semicolon-separated)', full: true, textarea: true }],
  },
];

export default function CompanySettingsPage() {
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

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      <div className="flex items-center gap-3">
        <div className="w-10 h-10 bg-gradient-to-br from-indigo-500 to-indigo-700 rounded-xl flex items-center justify-center shadow-lg shadow-indigo-500/20">
          <BuildingOffice2Icon className="w-5 h-5 text-white" />
        </div>
        <div>
          <h1 className="text-2xl font-bold text-gray-900 tracking-tight">Company Settings</h1>
          <p className="text-sm text-gray-400">The single source of truth for company details used across the HR System.</p>
        </div>
      </div>

      {isLoading ? (
        <div className="bg-white rounded-xl border border-gray-100 p-16 text-center text-gray-400">Loading…</div>
      ) : (
        <form onSubmit={handleSubmit(v => mutation.mutate(v))} className="space-y-6">
          {SECTIONS.map(section => (
            <div key={section.title} className="bg-white rounded-xl border border-gray-100 overflow-hidden">
              <div className="px-6 py-4 border-b border-gray-50">
                <h2 className="text-sm font-bold uppercase tracking-wider text-gray-400">{section.title}</h2>
              </div>
              <div className="p-6 grid grid-cols-1 sm:grid-cols-2 gap-5">
                {section.fields.map(f => (
                  <div key={f.name} className={`space-y-1.5 ${f.full ? 'sm:col-span-2' : ''}`}>
                    <label className="block text-sm font-semibold text-gray-700">
                      {f.label}{f.required && <span className="text-red-500 ml-0.5">*</span>}
                    </label>
                    {f.textarea ? (
                      <textarea rows={3}
                        className="w-full px-4 py-2.5 bg-gray-50 border border-gray-200 rounded-xl text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-400 focus:bg-white transition-all resize-none"
                        {...register(f.name, f.required ? { required: `${f.label} is required` } : {})} />
                    ) : (
                      <input type={f.type || 'text'}
                        className={`w-full h-11 px-4 bg-gray-50 border ${errors[f.name] ? 'border-red-300 ring-2 ring-red-100' : 'border-gray-200'} rounded-xl text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-400 focus:bg-white transition-all`}
                        {...register(f.name, f.required ? { required: `${f.label} is required` } : {})} />
                    )}
                    {errors[f.name] && <p className="text-xs text-red-500 font-medium">{errors[f.name].message}</p>}
                  </div>
                ))}
              </div>
            </div>
          ))}

          <div className="sticky bottom-0 bg-white/80 backdrop-blur-sm border-t border-gray-100 -mx-6 px-6 py-4 flex gap-3 justify-end rounded-b-xl">
            <button type="button" onClick={() => reset(company)}
              className="px-4 py-2 text-sm font-medium text-gray-600 hover:text-gray-800 transition-colors">Reset</button>
            <button type="submit" disabled={mutation.isPending || !isDirty}
              className="px-5 py-2.5 bg-gradient-to-r from-indigo-600 to-indigo-700 text-white text-sm font-medium rounded-xl hover:from-indigo-700 hover:to-indigo-800 disabled:opacity-50 disabled:cursor-not-allowed shadow-lg shadow-indigo-500/25 transition-all">
              {mutation.isPending ? 'Saving…' : 'Save Changes'}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
