import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { payrollApi } from '../../api/endpoints';
import { CurrencyDollarIcon, PlayIcon, XMarkIcon, BanknotesIcon, UserGroupIcon, ChartBarIcon, CalendarIcon, ExclamationTriangleIcon, ArrowDownTrayIcon } from '@heroicons/react/24/outline';
import { format } from 'date-fns';
import toast from 'react-hot-toast';

const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];

function ProcessPayrollModal({ onClose }) {
  const qc = useQueryClient();
  const now = new Date();
  const [month, setMonth] = useState(now.getMonth() + 1);
  const [year, setYear] = useState(now.getFullYear());
  const [confirmed, setConfirmed] = useState(false);

  const mutation = useMutation({
    mutationFn: () => payrollApi.process({ month, year }),
    onSuccess: (res) => {
      toast.success(`Payroll processed for ${res.data.count} employees`);
      qc.invalidateQueries(['payroll']);
      onClose();
    },
    onError: () => toast.error('Payroll processing failed'),
  });

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md overflow-hidden">
        {/* Header */}
        <div className="px-6 py-5 border-b border-gray-100 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-emerald-100 rounded-xl flex items-center justify-center">
              <BanknotesIcon className="w-5 h-5 text-emerald-600" />
            </div>
            <div>
              <h2 className="text-lg font-bold text-gray-900">Process Payroll</h2>
              <p className="text-xs text-gray-500 mt-0.5">Select period to process</p>
            </div>
          </div>
          <button onClick={onClose} className="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-gray-100 text-gray-400 hover:text-gray-600 transition-colors">
            <XMarkIcon className="w-5 h-5" />
          </button>
        </div>

        <div className="p-6 space-y-5">
          {/* Month / Year side by side */}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-semibold text-gray-700 mb-1.5">Month</label>
              <select className="w-full px-3 py-2.5 bg-gray-50 border border-gray-200 rounded-xl text-sm text-gray-700 focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-400 outline-none transition-all appearance-none" value={month} onChange={e => { setMonth(Number(e.target.value)); setConfirmed(false); }}>
                {MONTHS.map((m, i) => <option key={m} value={i+1}>{m}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-sm font-semibold text-gray-700 mb-1.5">Year</label>
              <input type="number" className="w-full px-3 py-2.5 bg-gray-50 border border-gray-200 rounded-xl text-sm text-gray-700 focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-400 outline-none transition-all" value={year} onChange={e => { setYear(Number(e.target.value)); setConfirmed(false); }} min={2020} max={2099} />
            </div>
          </div>

          {/* Selected period display */}
          <div className="flex items-center justify-center">
            <div className="inline-flex items-center gap-3 bg-gradient-to-r from-indigo-50 to-violet-50 border border-indigo-100 rounded-2xl px-5 py-3">
              <CalendarIcon className="w-5 h-5 text-indigo-500" />
              <span className="text-sm font-bold text-indigo-900">{MONTHS[month-1]} {year}</span>
            </div>
          </div>

          {/* Confirmation step */}
          <div className={`rounded-xl border p-4 transition-all duration-200 ${confirmed ? 'bg-emerald-50 border-emerald-200' : 'bg-amber-50 border-amber-100'}`}>
            <div className="flex items-start gap-3">
              <ExclamationTriangleIcon className={`w-5 h-5 flex-shrink-0 mt-0.5 ${confirmed ? 'text-emerald-600' : 'text-amber-600'}`} />
              <div className="flex-1">
                <p className={`text-sm font-medium ${confirmed ? 'text-emerald-800' : 'text-amber-800'}`}>
                  {confirmed ? 'Ready to process!' : 'Please confirm this action'}
                </p>
                <p className={`text-xs mt-1 ${confirmed ? 'text-emerald-600' : 'text-amber-600'}`}>
                  This will process payroll for all active employees for {MONTHS[month-1]} {year}.
                </p>
                {!confirmed && (
                  <button
                    onClick={() => setConfirmed(true)}
                    className="mt-3 text-xs font-semibold text-amber-700 bg-amber-100 hover:bg-amber-200 px-3 py-1.5 rounded-lg transition-colors"
                  >
                    I understand, confirm
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-gray-100 bg-gray-50/50 flex gap-3">
          <button onClick={onClose} className="flex-1 px-4 py-2.5 text-sm font-semibold text-gray-700 bg-white border border-gray-200 rounded-xl hover:bg-gray-50 transition-colors">
            Cancel
          </button>
          <button
            onClick={() => mutation.mutate()}
            disabled={!confirmed || mutation.isLoading}
            className="flex-1 px-4 py-2.5 text-sm font-semibold text-white bg-indigo-600 rounded-xl shadow-md shadow-indigo-200 hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2 transition-all"
          >
            {mutation.isLoading && <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />}
            <PlayIcon className="w-4 h-4" />
            Process
          </button>
        </div>
      </div>
    </div>
  );
}

export default function PayrollPage() {
  const qc = useQueryClient();
  const [showModal, setShowModal] = useState(false);
  const [filterYear, setFilterYear] = useState(new Date().getFullYear());
  const [page, setPage] = useState(1);
  const limit = 20;

  const { data, isLoading } = useQuery({
    queryKey: ['payroll', filterYear, page],
    queryFn: () => payrollApi.list({ year: filterYear, page, limit }),
    keepPreviousData: true,
  });

  const records = data?.data?.data || [];
  const total = data?.data?.count || 0;
  const totalPages = Math.ceil(total / limit);

  const totalNet = records.reduce((s, r) => s + (r.hr_netpay || 0), 0);

  const summaryCards = [
    {
      label: 'Total Disbursed',
      value: `\u20b9${(totalNet/100000).toFixed(2)}L`,
      icon: BanknotesIcon,
      iconBg: 'bg-indigo-100',
      iconColor: 'text-indigo-600',
      border: 'border-l-indigo-500',
      valueColor: 'text-indigo-700',
      trend: totalNet > 0 ? '+' : '',
    },
    {
      label: 'Employees Paid',
      value: records.length,
      icon: UserGroupIcon,
      iconBg: 'bg-emerald-100',
      iconColor: 'text-emerald-600',
      border: 'border-l-emerald-500',
      valueColor: 'text-emerald-700',
      trend: records.length > 0 ? 'Active' : '',
    },
    {
      label: 'Avg Net Pay',
      value: records.length > 0 ? `\u20b9${Math.round(totalNet / records.length).toLocaleString('en-IN')}` : '\u20b90',
      icon: ChartBarIcon,
      iconBg: 'bg-violet-100',
      iconColor: 'text-violet-600',
      border: 'border-l-violet-500',
      valueColor: 'text-gray-900',
      trend: records.length > 0 ? 'Per employee' : '',
    },
  ];

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 tracking-tight">Payroll</h1>
          <p className="text-sm text-gray-500 mt-1">{total} records</p>
        </div>
        <button
          onClick={() => setShowModal(true)}
          className="inline-flex items-center gap-2.5 px-5 py-2.5 bg-indigo-600 text-white text-sm font-semibold rounded-xl shadow-md shadow-indigo-200 hover:bg-indigo-700 hover:shadow-lg hover:shadow-indigo-200 transition-all duration-200"
        >
          <PlayIcon className="w-4.5 h-4.5" /> Process Payroll
        </button>
      </div>

      {/* Summary Cards */}
      {records.length > 0 && (
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          {summaryCards.map(s => (
            <div key={s.label} className={`bg-white rounded-xl border border-gray-100 border-l-4 ${s.border} p-5 shadow-sm hover:shadow-md transition-shadow duration-200`}>
              <div className="flex items-start justify-between">
                <div>
                  <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider">{s.label}</p>
                  <p className={`text-2xl font-bold mt-2 ${s.valueColor} tracking-tight`}>{s.value}</p>
                  {s.trend && (
                    <p className="text-xs font-medium text-gray-400 mt-1">{s.trend}</p>
                  )}
                </div>
                <div className={`w-10 h-10 ${s.iconBg} rounded-full flex items-center justify-center flex-shrink-0`}>
                  <s.icon className={`w-5 h-5 ${s.iconColor}`} />
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Year Filter */}
      <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-4">
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2">
            <CalendarIcon className="w-4 h-4 text-gray-400" />
            <label className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Year</label>
          </div>
          <select
            className="px-3 py-2 bg-gray-50 border border-gray-200 rounded-lg text-sm font-medium text-gray-700 focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-400 outline-none transition-all appearance-none"
            value={filterYear}
            onChange={e => { setFilterYear(Number(e.target.value)); setPage(1); }}
          >
            {[2024, 2025, 2026].map(y => <option key={y}>{y}</option>)}
          </select>
        </div>
      </div>

      {/* Table */}
      <div className="bg-white rounded-xl border border-gray-100 shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="bg-gray-50/80">
                <th className="px-5 py-3.5 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">Employee</th>
                <th className="px-5 py-3.5 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">Period</th>
                <th className="px-5 py-3.5 text-right text-xs font-semibold text-gray-500 uppercase tracking-wider">Basic</th>
                <th className="px-5 py-3.5 text-right text-xs font-semibold text-gray-500 uppercase tracking-wider">Allowances</th>
                <th className="px-5 py-3.5 text-right text-xs font-semibold text-gray-500 uppercase tracking-wider">Deductions</th>
                <th className="px-5 py-3.5 text-right text-xs font-semibold text-gray-500 uppercase tracking-wider">Net Pay</th>
                <th className="px-5 py-3.5 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">Status</th>
                <th className="px-5 py-3.5 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">Processed On</th>
                <th className="px-5 py-3.5 text-center text-xs font-semibold text-gray-500 uppercase tracking-wider">Payslip</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100/70">
              {isLoading ? (
                Array(8).fill(0).map((_, i) => (
                  <tr key={i}>{Array(8).fill(0).map((_, j) => (
                    <td key={j} className="px-5 py-4"><div className="h-4 bg-gray-100 rounded-md animate-pulse" /></td>
                  ))}</tr>
                ))
              ) : records.length === 0 ? (
                <tr><td colSpan={8} className="px-5 py-16 text-center">
                  <div className="flex flex-col items-center gap-2">
                    <BanknotesIcon className="w-10 h-10 text-gray-300" />
                    <p className="text-sm text-gray-400 font-medium">No payroll records found</p>
                    <p className="text-xs text-gray-300">Process payroll to get started</p>
                  </div>
                </td></tr>
              ) : (
                records.map(r => (
                  <tr key={r.hr_hrpayrollid} className="hover:bg-gray-50/50 transition-colors duration-150">
                    <td className="px-5 py-4">
                      <div className="flex items-center gap-3">
                        <div className="w-9 h-9 rounded-full bg-gradient-to-br from-indigo-400 to-violet-500 flex items-center justify-center text-white text-xs font-bold shadow-sm flex-shrink-0">
                          {(r['_hr_hremployee_value@OData.Community.Display.V1.FormattedValue'] || 'E')[0].toUpperCase()}
                        </div>
                        <span className="text-sm font-semibold text-gray-900">
                          {r['_hr_hremployee_value@OData.Community.Display.V1.FormattedValue'] || '\u2014'}
                        </span>
                      </div>
                    </td>
                    <td className="px-5 py-4">
                      <span className="inline-flex items-center gap-1.5 text-sm text-gray-700 font-medium">
                        <CalendarIcon className="w-3.5 h-3.5 text-gray-400" />
                        {MONTHS[(r.hr_month||1)-1].slice(0,3)} {r.hr_year}
                      </span>
                    </td>
                    <td className="px-5 py-4 text-right">
                      <span className="text-sm text-gray-700 font-medium tabular-nums">₹{r.hr_basic?.toLocaleString('en-IN') || '—'}</span>
                    </td>
                    <td className="px-5 py-4 text-right">
                      <span className="text-sm text-emerald-600 font-semibold tabular-nums">+₹{r.hr_allowances?.toLocaleString('en-IN') || '0'}</span>
                    </td>
                    <td className="px-5 py-4 text-right">
                      <span className="text-sm text-red-500 font-semibold tabular-nums">-₹{r.hr_deductions?.toLocaleString('en-IN') || '0'}</span>
                    </td>
                    <td className="px-5 py-4 text-right">
                      <span className="text-sm font-bold text-gray-900 tabular-nums">₹{r.hr_netpay?.toLocaleString('en-IN') || '—'}</span>
                    </td>
                    <td className="px-5 py-4">
                      <span className="inline-flex items-center gap-1.5 text-xs font-semibold">
                        <span className={`w-2 h-2 rounded-full ${r.hr_status === 'processed' ? 'bg-emerald-500' : 'bg-amber-400'}`} />
                        <span className={r.hr_status === 'processed' ? 'text-emerald-700' : 'text-amber-700'}>
                          {r.hr_status?.charAt(0).toUpperCase() + r.hr_status?.slice(1)}
                        </span>
                      </span>
                    </td>
                    <td className="px-5 py-4 text-sm text-gray-500">
                      {r.hr_processeddate ? format(new Date(r.hr_processeddate), 'dd MMM yyyy') : '\u2014'}
                    </td>
                    <td className="px-5 py-4 text-center">
                      {r.hr_status === 'processed' && (
                        <button
                          onClick={async () => {
                            try {
                              const res = await payrollApi.downloadPayslip(r.hr_hrpayrollid);
                              const url = window.URL.createObjectURL(new Blob([res.data], { type: 'application/pdf' }));
                              const a = document.createElement('a');
                              a.href = url;
                              a.download = `Payslip_${MONTHS[(r.hr_month||1)-1]}_${r.hr_year}.pdf`;
                              a.click();
                              window.URL.revokeObjectURL(url);
                              toast.success('Payslip downloaded');
                            } catch { toast.error('Failed to download payslip'); }
                          }}
                          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-indigo-600 bg-indigo-50 rounded-lg hover:bg-indigo-100 transition-colors"
                        >
                          <ArrowDownTrayIcon className="w-3.5 h-3.5" />
                          PDF
                        </button>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        {totalPages > 1 && (
          <div className="px-5 py-3.5 border-t border-gray-100 flex items-center justify-between">
            <span className="text-sm text-gray-500">Page <span className="font-medium text-gray-700">{page}</span> of <span className="font-medium text-gray-700">{totalPages}</span></span>
            <div className="flex gap-2">
              <button onClick={() => setPage(p => p-1)} disabled={page === 1} className="px-4 py-1.5 text-sm font-medium text-gray-600 bg-white border border-gray-200 rounded-lg hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors">Prev</button>
              <button onClick={() => setPage(p => p+1)} disabled={page >= totalPages} className="px-4 py-1.5 text-sm font-medium text-gray-600 bg-white border border-gray-200 rounded-lg hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors">Next</button>
            </div>
          </div>
        )}
      </div>

      {showModal && <ProcessPayrollModal onClose={() => setShowModal(false)} />}
    </div>
  );
}
