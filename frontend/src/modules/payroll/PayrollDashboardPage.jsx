import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { payrollApi, employeeApi } from '../../api/endpoints';
import {
  AreaChart, Area, BarChart, Bar, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer,
} from 'recharts';
import {
  UsersIcon, CheckCircleIcon, ClockIcon, BanknotesIcon, ArrowTrendingDownIcon, WalletIcon, ChartBarIcon,
} from '@heroicons/react/24/outline';

// Validated categorical palette (dataviz: worst adjacent CVD ΔE 8.9; legends +
// tooltips provide the required relief for the contrast WARN).
const SERIES = { indigo: '#6366f1', emerald: '#10b981', amber: '#f59e0b', rose: '#f43f5e', sky: '#0ea5e9' };
// Status palette — reserved states, always shown with a label (never colour-alone).
const STATUS = [
  { key: 'draft', label: 'Draft', color: '#94a3b8' },
  { key: 'processing', label: 'Processing', color: '#f59e0b' },
  { key: 'approved', label: 'Approved', color: '#6366f1' },
  { key: 'locked', label: 'Locked', color: '#8b5cf6' },
  { key: 'paid', label: 'Paid', color: '#10b981' },
];
const MONTHS = ['All', 'January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

const inr = (v) => '₹' + Number(v || 0).toLocaleString('en-IN');
const compact = (v) => {
  const n = Number(v) || 0;
  if (n >= 1e7) return '₹' + (n / 1e7).toFixed(1) + 'Cr';
  if (n >= 1e5) return '₹' + (n / 1e5).toFixed(1) + 'L';
  if (n >= 1e3) return '₹' + Math.round(n / 1e3) + 'k';
  return '₹' + n;
};

// Shared tooltip — values in ink, a colour chip carries series identity.
function ChartTip({ active, payload, label, money = true }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="bg-white border border-gray-200 rounded-lg shadow-lg px-3 py-2 text-xs">
      <p className="font-semibold text-gray-900 mb-1">{label}</p>
      {payload.map((p) => (
        <div key={p.dataKey} className="flex items-center gap-2">
          <span className="w-2.5 h-2.5 rounded-sm" style={{ background: p.color || p.fill }} />
          <span className="text-gray-500">{p.name}</span>
          <span className="ml-auto font-semibold text-gray-900 tabular-nums">{money ? inr(p.value) : p.value}</span>
        </div>
      ))}
    </div>
  );
}

const axisX = { tick: { fontSize: 11, fill: '#94a3b8' }, axisLine: false, tickLine: false };
const axisY = (fmt) => ({ tick: { fontSize: 11, fill: '#94a3b8' }, axisLine: false, tickLine: false, width: 44, tickFormatter: fmt });
const grid = { strokeDasharray: '3 3', stroke: '#f1f5f9', vertical: false };

function ChartCard({ title, subtitle, children, height = 240 }) {
  return (
    <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5">
      <div className="mb-3">
        <h3 className="text-sm font-bold text-gray-900">{title}</h3>
        {subtitle && <p className="text-xs text-gray-400">{subtitle}</p>}
      </div>
      <ResponsiveContainer width="100%" height={height}>{children}</ResponsiveContainer>
    </div>
  );
}

function StatCard({ icon: Icon, label, value, accent }) {
  return (
    <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-4 flex items-center gap-3">
      <div className={`w-11 h-11 rounded-xl flex items-center justify-center ${accent.bg}`}><Icon className={`w-5 h-5 ${accent.text}`} /></div>
      <div className="min-w-0">
        <p className="text-[11px] uppercase tracking-wider text-gray-400">{label}</p>
        <p className="text-xl font-bold text-gray-900 truncate">{value}</p>
      </div>
    </div>
  );
}

export default function PayrollDashboardPage() {
  const now = new Date();
  const [month, setMonth] = useState(0);      // 0 = All
  const [year, setYear] = useState(now.getFullYear());
  const [department, setDepartment] = useState('');
  const [employeeId, setEmployeeId] = useState('');

  const { data: empRes } = useQuery({ queryKey: ['employees-lite'], queryFn: () => employeeApi.list({ limit: 500 }) });
  const employees = empRes?.data?.data || empRes?.data || [];
  const departments = useMemo(() => [...new Set(employees.map(e => e.hr_department).filter(Boolean))].sort(), [employees]);

  const params = { year };
  if (month) params.month = month;
  if (department) params.department = department;
  if (employeeId) params.employeeId = employeeId;

  const { data, isLoading } = useQuery({ queryKey: ['payroll-dashboard', params], queryFn: () => payrollApi.dashboard(params), placeholderData: (p) => p });
  const d = data?.data;
  const monthly = d?.monthly || [];
  const pipeline = d?.statusPipeline || {};
  const pipelineTotal = STATUS.reduce((s, x) => s + (pipeline[x.key] || 0), 0);

  const cards = [
    { icon: UsersIcon, label: 'Total Employees', value: d?.cards.totalEmployees ?? '—', accent: { bg: 'bg-indigo-50', text: 'text-indigo-600' } },
    { icon: CheckCircleIcon, label: 'Processed Payroll', value: d?.cards.processedPayroll ?? '—', accent: { bg: 'bg-emerald-50', text: 'text-emerald-600' } },
    { icon: ClockIcon, label: 'Pending Payroll', value: d?.cards.pendingPayroll ?? '—', accent: { bg: 'bg-amber-50', text: 'text-amber-600' } },
    { icon: BanknotesIcon, label: 'Total Gross Salary', value: d ? inr(d.cards.totalGross) : '—', accent: { bg: 'bg-sky-50', text: 'text-sky-600' } },
    { icon: ArrowTrendingDownIcon, label: 'Total Deductions', value: d ? inr(d.cards.totalDeductions) : '—', accent: { bg: 'bg-rose-50', text: 'text-rose-600' } },
    { icon: WalletIcon, label: 'Total Net Salary', value: d ? inr(d.cards.totalNet) : '—', accent: { bg: 'bg-violet-50', text: 'text-violet-600' } },
  ];

  const selCls = 'h-10 px-3 bg-white border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-400';

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex items-center gap-3">
        <div className="w-10 h-10 bg-gradient-to-br from-indigo-500 to-indigo-700 rounded-xl flex items-center justify-center shadow-lg shadow-indigo-500/20"><ChartBarIcon className="w-5 h-5 text-white" /></div>
        <div>
          <h1 className="text-2xl font-bold text-gray-900 tracking-tight">Payroll Dashboard</h1>
          <p className="text-sm text-gray-400">Salary, deductions, LOP, leave and advance trends across the organisation.</p>
        </div>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-2">
        <select value={month} onChange={e => setMonth(Number(e.target.value))} className={selCls}>
          {MONTHS.map((m, i) => <option key={m} value={i}>{i === 0 ? 'All Months' : m}</option>)}
        </select>
        <select value={year} onChange={e => setYear(Number(e.target.value))} className={selCls}>
          {[now.getFullYear(), now.getFullYear() - 1, now.getFullYear() - 2].map(y => <option key={y} value={y}>{y}</option>)}
        </select>
        <select value={department} onChange={e => { setDepartment(e.target.value); }} className={selCls}>
          <option value="">All Departments</option>
          {departments.map(dep => <option key={dep} value={dep}>{dep}</option>)}
        </select>
        <select value={employeeId} onChange={e => setEmployeeId(e.target.value)} className={selCls}>
          <option value="">All Employees</option>
          {employees.filter(e => !department || e.hr_department === department).map(e => <option key={e.hr_hremployeeid} value={e.hr_hremployeeid}>{e.hr_hremployee1}</option>)}
        </select>
        {isLoading && <span className="text-xs text-gray-400">Loading…</span>}
      </div>

      {/* Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-3">
        {cards.map(c => <StatCard key={c.label} {...c} />)}
      </div>

      {/* Payroll pipeline (calendar of states) */}
      <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5">
        <div className="flex items-center justify-between mb-3">
          <div><h3 className="text-sm font-bold text-gray-900">Payroll Pipeline</h3><p className="text-xs text-gray-400">Status of payroll runs {month ? `for ${MONTHS[month]}` : 'this year'}</p></div>
          <span className="text-xs text-gray-400">{pipelineTotal} run{pipelineTotal === 1 ? '' : 's'}</span>
        </div>
        <div className="flex h-3 rounded-full overflow-hidden bg-gray-100 gap-0.5">
          {STATUS.map(s => { const v = pipeline[s.key] || 0; const pct = pipelineTotal ? (v / pipelineTotal) * 100 : 0; return v > 0 ? <div key={s.key} style={{ width: `${pct}%`, background: s.color }} title={`${s.label}: ${v}`} /> : null; })}
        </div>
        <div className="flex flex-wrap gap-x-5 gap-y-2 mt-3">
          {STATUS.map(s => (
            <div key={s.key} className="flex items-center gap-1.5">
              <span className="w-2.5 h-2.5 rounded-sm" style={{ background: s.color }} />
              <span className="text-xs text-gray-500">{s.label}</span>
              <span className="text-xs font-bold text-gray-900">{pipeline[s.key] || 0}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Charts */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <ChartCard title="Department Salary" subtitle={month ? MONTHS[month] : 'This year'}>
          <BarChart data={d?.departmentSalary || []} layout="vertical" margin={{ left: 8, right: 16 }}>
            <CartesianGrid {...grid} horizontal={false} />
            <XAxis type="number" {...axisY(compact)} width={undefined} height={20} />
            <YAxis type="category" dataKey="department" tick={{ fontSize: 11, fill: '#64748b' }} axisLine={false} tickLine={false} width={90} />
            <Tooltip content={<ChartTip />} cursor={{ fill: '#f8fafc' }} />
            <Bar dataKey="net" name="Net Salary" fill={SERIES.indigo} radius={[0, 4, 4, 0]} barSize={16} />
          </BarChart>
        </ChartCard>

        <ChartCard title="Monthly Salary Trend" subtitle="Gross vs Net across the year">
          <AreaChart data={monthly} margin={{ left: 4, right: 8 }}>
            <defs>
              <linearGradient id="gGross" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={SERIES.indigo} stopOpacity={0.25} /><stop offset="100%" stopColor={SERIES.indigo} stopOpacity={0.02} /></linearGradient>
              <linearGradient id="gNet" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={SERIES.emerald} stopOpacity={0.25} /><stop offset="100%" stopColor={SERIES.emerald} stopOpacity={0.02} /></linearGradient>
            </defs>
            <CartesianGrid {...grid} />
            <XAxis dataKey="label" {...axisX} />
            <YAxis {...axisY(compact)} />
            <Tooltip content={<ChartTip />} />
            <Legend iconType="circle" wrapperStyle={{ fontSize: 12 }} />
            <Area type="monotone" dataKey="gross" name="Gross" stroke={SERIES.indigo} strokeWidth={2} fill="url(#gGross)" />
            <Area type="monotone" dataKey="net" name="Net" stroke={SERIES.emerald} strokeWidth={2} fill="url(#gNet)" />
          </AreaChart>
        </ChartCard>

        <ChartCard title="LOP Trend" subtitle="Loss-of-pay deduction by month">
          <BarChart data={monthly} margin={{ left: 4, right: 8 }}>
            <CartesianGrid {...grid} />
            <XAxis dataKey="label" {...axisX} />
            <YAxis {...axisY(compact)} />
            <Tooltip content={<ChartTip />} cursor={{ fill: '#f8fafc' }} />
            <Bar dataKey="lop" name="LOP" fill={SERIES.rose} radius={[4, 4, 0, 0]} barSize={16} />
          </BarChart>
        </ChartCard>

        <ChartCard title="Advance Salary Trend" subtitle="Recovered from payroll by month">
          <AreaChart data={monthly} margin={{ left: 4, right: 8 }}>
            <defs><linearGradient id="gAdv" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={SERIES.amber} stopOpacity={0.3} /><stop offset="100%" stopColor={SERIES.amber} stopOpacity={0.02} /></linearGradient></defs>
            <CartesianGrid {...grid} />
            <XAxis dataKey="label" {...axisX} />
            <YAxis {...axisY(compact)} />
            <Tooltip content={<ChartTip />} />
            <Area type="monotone" dataKey="advance" name="Advance Recovered" stroke={SERIES.amber} strokeWidth={2} fill="url(#gAdv)" />
          </AreaChart>
        </ChartCard>

        <ChartCard title="Leave Trend" subtitle="Approved leave days by month">
          <LineChart data={monthly} margin={{ left: 4, right: 8 }}>
            <CartesianGrid {...grid} />
            <XAxis dataKey="label" {...axisX} />
            <YAxis tick={{ fontSize: 11, fill: '#94a3b8' }} axisLine={false} tickLine={false} width={30} allowDecimals={false} />
            <Tooltip content={<ChartTip money={false} />} />
            <Line type="monotone" dataKey="leave" name="Leave Days" stroke={SERIES.sky} strokeWidth={2} dot={{ r: 3, fill: SERIES.sky }} activeDot={{ r: 5 }} />
          </LineChart>
        </ChartCard>
      </div>
    </div>
  );
}
