import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { attendanceApi } from '../../api/endpoints';
import { ScaleIcon } from '@heroicons/react/24/outline';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const now = new Date();
const hrs = (n) => `${Number(n ?? 0) >= 0 ? '' : ''}${(Number(n) || 0).toFixed(2)}h`;
const signed = (n) => `${Number(n) > 0 ? '+' : ''}${(Number(n) || 0).toFixed(2)}h`;

function Stat({ label, value, tone = 'text-gray-800' }) {
  return (
    <div className="bg-gray-50 rounded-lg px-2.5 py-2 text-center">
      <p className="text-[10px] uppercase tracking-wider text-gray-400 font-semibold">{label}</p>
      <p className={`text-sm font-bold tabular-nums ${tone}`}>{value}</p>
    </div>
  );
}

/**
 * Monthly cumulative hour balance (Phase 2). Reporting only — reads
 * GET /attendance/monthly-balance. `employeeId` omitted → the signed-in employee.
 */
export default function MonthlyBalanceCard({ employeeId }) {
  const [year, setYear] = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth() + 1);

  const { data, isLoading } = useQuery({
    queryKey: ['monthly-balance', employeeId || 'self', year, month],
    queryFn: () => attendanceApi.monthlyBalance({ year, month, ...(employeeId ? { employeeId } : {}) }).then(r => r.data),
  });

  const bal = Number(data?.currentBalance || 0);
  const shortage = Number(data?.finalShortage || 0);

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
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            <Stat label="Carry Forward" value={signed(data?.previousCarryForward)} tone={data?.previousCarryForward < 0 ? 'text-amber-700' : 'text-gray-800'} />
            <Stat label="Required Hrs" value={hrs(data?.requiredHours)} />
            <Stat label="Approved Leave" value={hrs(data?.approvedLeaveHours)} tone="text-sky-700" />
            <Stat label="Worked Hrs" value={hrs(data?.actualWorkedHours)} />
            <Stat label="Overtime" value={hrs(data?.overtime)} tone="text-violet-700" />
            <Stat label="Effective Hrs" value={hrs(data?.effectiveHours)} tone="text-emerald-700" />
            <Stat label="Current Balance" value={signed(bal)} tone={bal < 0 ? 'text-amber-700' : 'text-emerald-700'} />
            <Stat label="Final Shortage" value={hrs(shortage)} tone={shortage > 0 ? 'text-red-600' : 'text-gray-800'} />
          </div>

          {/* Month-end outcome */}
          <div className="mt-3 pt-3 border-t border-gray-100 grid grid-cols-3 gap-2">
            <Stat label="LOP Days" value={Number(data?.lopDays || 0)} tone={data?.lopDays > 0 ? 'text-red-600' : 'text-gray-800'} />
            <Stat label="Carry Forward" value={signed(data?.carryForward)} tone={data?.carryForward < 0 ? 'text-amber-700' : 'text-gray-800'} />
            <Stat label="Est. LOP Deduction" value={data?.estimatedSalaryDeduction == null ? '—' : `₹${Number(data.estimatedSalaryDeduction).toFixed(2)}`} />
          </div>

          <p className="text-[11px] text-gray-400 mt-3">
            Daily balance = worked − expected (Full 9h / Half 5h). Approved leave, holidays and weekly-offs expect 0h. Overtime raises the balance through worked hours (not double-counted). Month-end: shortage &lt;5h carries forward; 5–7h → 0.5 LOP; ≥7h → 1 LOP. The estimated deduction uses the existing payroll rate; payroll computes the actual amount.
          </p>
        </>
      )}
    </div>
  );
}
