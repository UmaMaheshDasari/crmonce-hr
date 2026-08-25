import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { attendanceApi } from '../../api/endpoints';
import { ScaleIcon } from '@heroicons/react/24/outline';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const now = new Date();
// Hours as "6h 14m" (handles negatives for the signed balance).
const hrs = (n) => { const v = Number(n) || 0; const s = v < 0 ? '-' : ''; const t = Math.round(Math.abs(v) * 60); return `${s}${Math.floor(t / 60)}h ${String(t % 60).padStart(2, '0')}m`; };
const signed = (n) => `${Number(n) > 0 ? '+' : ''}${hrs(n)}`;
const rupees = (n) => (n == null ? '—' : `₹${Number(n).toLocaleString('en-IN')}`);

function Stat({ label, value, tone = 'text-gray-800' }) {
  return (
    <div className="bg-gray-50 rounded-lg px-2.5 py-2 text-center">
      <p className="text-[10px] uppercase tracking-wider text-gray-400 font-semibold">{label}</p>
      <p className={`text-sm font-bold tabular-nums ${tone}`}>{value}</p>
    </div>
  );
}

// Small uppercase section heading with a hairline rule.
function SectionLabel({ children }) {
  return (
    <p className="text-[10px] font-bold uppercase tracking-wider text-gray-400 mt-4 mb-2 first:mt-0">{children}</p>
  );
}

// A highlighted summary strip: label left, value right, on a soft tinted background.
const BAND_TONE = {
  indigo: 'bg-indigo-50 text-indigo-700',
  slate: 'bg-gray-100 text-gray-900',
  emerald: 'bg-emerald-50 text-emerald-700',
  red: 'bg-red-50 text-red-700',
};
function Band({ label, value, tone = 'slate', big = false }) {
  return (
    <div className={`flex items-center justify-between rounded-lg px-3 ${big ? 'py-2.5' : 'py-2'} ${BAND_TONE[tone] || BAND_TONE.slate}`}>
      <span className="text-[11px] font-semibold uppercase tracking-wider opacity-80">{label}</span>
      <span className={`font-bold tabular-nums ${big ? 'text-lg' : 'text-sm'}`}>{value}</span>
    </div>
  );
}

/**
 * Monthly hour balance — INDEPENDENT per month, NO carry-forward. Reporting only —
 * reads GET /attendance/monthly-balance. `employeeId` omitted → the signed-in employee.
 */
export default function MonthlyBalanceCard({ employeeId }) {
  const [year, setYear] = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth() + 1);

  const { data, isLoading } = useQuery({
    queryKey: ['monthly-balance', employeeId || 'self', year, month],
    queryFn: () => attendanceApi.monthlyBalance({ year, month, ...(employeeId ? { employeeId } : {}) }).then(r => r.data),
  });

  const diff = Number(data?.monthlyDifference || 0);
  const shortage = Number(data?.shortageHours || 0);

  return (
    <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-5">
      <div className="flex items-center justify-between gap-3 mb-4">
        <h3 className="text-sm font-bold text-gray-900 flex items-center gap-2">
          <ScaleIcon className="w-5 h-5 text-indigo-500" /> Monthly Hour Balance
        </h3>
        <div className="flex items-center gap-2">
          <select value={month} onChange={e => setMonth(Number(e.target.value))} className="h-8 px-2 bg-gray-50 border border-gray-200 rounded-lg text-xs font-semibold">
            {MONTHS.map((mn, i) => <option key={mn} value={i + 1}>{mn}</option>)}
          </select>
          <select value={year} onChange={e => setYear(Number(e.target.value))} className="h-8 px-2 bg-gray-50 border border-gray-200 rounded-lg text-xs font-semibold">
            {[now.getFullYear(), now.getFullYear() - 1].map(y => <option key={y} value={y}>{y}</option>)}
          </select>
        </div>
      </div>

      {isLoading ? (
        <p className="text-sm text-gray-400 py-6 text-center">Calculating…</p>
      ) : (
        <>
          {/* ── Required hours — Working Days × 9, reduced by approved leave + adjustments ── */}
          <SectionLabel>Required Hours</SectionLabel>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-2">
            <Stat label="Working Days" value={Number(data?.workingDays ?? 0)} />
            <Stat label="Base Required" value={hrs(data?.baseRequiredHours)} />
            <Stat label="Approved Leave" value={hrs(data?.approvedLeaveHours)} tone="text-sky-700" />
            <Stat label="Approved Adjustment" value={hrs(data?.approvedAdjustmentHours)} tone="text-violet-700" />
          </div>
          <Band label="Final Required" value={hrs(data?.finalRequiredHours)} tone="indigo" />

          {/* ── Actual attendance — present + half days, ACTUAL punch hours ── */}
          <SectionLabel>Actual Attendance</SectionLabel>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-2">
            <Stat label="Present Days" value={Number(data?.presentDays ?? 0)} tone="text-emerald-700" />
            <Stat label="Present Hours" value={hrs(data?.presentWorkedHours)} tone="text-emerald-700" />
            <Stat label="Half Days" value={Number(data?.halfDays ?? 0)} tone="text-amber-700" />
            <Stat label="Half-Day Hours" value={hrs(data?.halfWorkedHours)} tone="text-amber-700" />
          </div>
          <Band label="Total Worked" value={hrs(data?.totalWorkedHours)} tone="slate" />

          {/* ── Result — Total Worked − Final Required → shortage / deduction ── */}
          <SectionLabel>Result</SectionLabel>
          <Band label="Monthly Difference" value={signed(diff)} tone={diff < 0 ? 'red' : 'emerald'} big />
          <div className="mt-2 grid grid-cols-3 gap-2">
            <Stat label="Shortage Hrs" value={hrs(shortage)} tone={shortage > 0 ? 'text-red-600' : 'text-gray-800'} />
            <Stat label="Hourly Rate" value={data?.hourlyRate == null ? '—' : rupees(data.hourlyRate)} />
            <Stat label="Salary Deduction" value={rupees(data?.salaryDeduction)} tone={data?.salaryDeduction > 0 ? 'text-red-600' : 'text-gray-800'} />
          </div>
          {data?.absentDays > 0 && (
            <p className="text-[11px] text-red-500 mt-2">{data.absentDays} absent day(s) — handled separately as LOP (not part of the hourly shortage).</p>
          )}

          <p className="text-[11px] text-gray-400 mt-3">
            Monthly hours are calculated independently. Working days × 9 hours gives the base required hours. Approved leave and HR-approved hour adjustments reduce the required hours for the days they apply to (an approved adjustment is not a deduction). Present and half-day hours use actual punch hours. The monthly difference is Total Worked Hours − Final Required Hours; a surplus on one day offsets a shortage on another within the same month. Positive hours do not carry forward. Only a negative monthly balance is deducted, using the employee's hourly rate. Absent days are handled separately as LOP.
          </p>
        </>
      )}
    </div>
  );
}
