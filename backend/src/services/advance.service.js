/**
 * Advance Salary — request lifecycle + EMI recovery that feeds Payroll.
 *
 * Recovery model (idempotent, single table): each advance carries a JSON
 * `recoverySchedule` = [{ period:'YYYY-MM', amount }]. On payroll generation for
 * a period, applyPeriod() adds ONE installment for that period if not already
 * present — so regenerating a month never double-recovers. `recovered` = sum of
 * the schedule; when it reaches `amount` the advance is `completed`.
 *
 * Pure helpers (computeInstallment / applyPeriod / shape) are unit-tested with no
 * network. The async layer (applyMonthlyRecovery) reads/writes Dataverse.
 */
const d365 = require('./d365.service');

const ENTITY = d365.constructor.entities.advanceSalary;   // 'hr_advancesalaries'
const pad2 = (n) => String(n).padStart(2, '0');
const round = (v) => Math.round(Number(v) || 0);
const periodOf = (year, month) => `${year}-${pad2(month)}`;

const SELECT = [
  'hr_advancesalaryid', 'hr_employeeid', 'hr_employeename', 'hr_amount', 'hr_reason',
  'hr_requesteddate', 'hr_emi', 'hr_recoverfrom', 'hr_recovered', 'hr_recoveryschedule',
  'hr_status', 'hr_approvedby', 'hr_approveddate', 'hr_remarks', 'hr_createdby',
  'hr_emailsent', 'hr_emailsenttime', 'createdon', 'modifiedon',
].join(',');

function parseSchedule(v) {
  if (Array.isArray(v)) return v;
  try { const p = JSON.parse(v || '[]'); return Array.isArray(p) ? p : []; } catch { return []; }
}

/** Installment for a period given the amount, EMI and how much is already recovered. */
function computeInstallment({ amount, emi, recovered }) {
  const remaining = Math.max(0, round(amount) - round(recovered));
  if (remaining <= 0) return 0;
  const step = round(emi) > 0 ? round(emi) : round(amount);   // 0/blank EMI → one-shot
  return Math.min(step, remaining);
}

/**
 * Apply one payroll period to an advance. Pure + idempotent.
 * @returns {{installment:number, schedule:Array, recovered:number, status:string, changed:boolean}}
 */
function applyPeriod(adv, period) {
  const amount = round(adv.amount);
  const emi = round(adv.emi);
  const schedule = parseSchedule(adv.schedule ?? adv.recoverySchedule);
  const recoveredNow = schedule.reduce((s, r) => s + round(r.amount), 0);
  const status = adv.status || 'approved';

  // Idempotent FIRST: if this period was already recovered, return its recorded
  // installment regardless of current status (a completed advance still owns the
  // installments it already deducted). This keeps payroll regeneration stable.
  const existing = schedule.find((r) => r.period === period);
  if (existing) return { installment: round(existing.amount), schedule, recovered: recoveredNow, status, changed: false };

  // Otherwise only recover for approved advances, from the RecoverFrom period on.
  if (status !== 'approved') return { installment: 0, schedule, recovered: recoveredNow, status, changed: false };
  if (adv.recoverFrom && period < adv.recoverFrom) return { installment: 0, schedule, recovered: recoveredNow, status, changed: false };

  const installment = computeInstallment({ amount, emi, recovered: recoveredNow });
  if (installment <= 0) {
    const done = recoveredNow >= amount ? 'completed' : status;
    return { installment: 0, schedule, recovered: recoveredNow, status: done, changed: done !== status };
  }
  const newSchedule = [...schedule, { period, amount: installment }];
  const newRecovered = recoveredNow + installment;
  const newStatus = newRecovered >= amount ? 'completed' : 'approved';
  return { installment, schedule: newSchedule, recovered: newRecovered, status: newStatus, changed: true };
}

/** Raw Dataverse row → clean API object with derived remaining/percent. */
function shape(row = {}) {
  const amount = round(row.hr_amount);
  const recovered = round(row.hr_recovered);
  const remaining = Math.max(0, amount - recovered);
  return {
    id: row.hr_advancesalaryid,
    employeeId: row.hr_employeeid || '',
    employeeName: row.hr_employeename || '',
    amount, reason: row.hr_reason || '',
    requestedDate: (row.hr_requesteddate || '').slice(0, 10),
    emi: round(row.hr_emi),
    recoverFrom: row.hr_recoverfrom || '',
    recovered, remaining,
    percent: amount > 0 ? Math.round((recovered / amount) * 100) : 0,
    schedule: parseSchedule(row.hr_recoveryschedule),
    status: row.hr_status || 'pending',
    approvedBy: row.hr_approvedby || '', approvedDate: row.hr_approveddate || '',
    remarks: row.hr_remarks || '', createdBy: row.hr_createdby || '',
    createdOn: row.createdon || null, modifiedOn: row.modifiedon || null,
  };
}

// ── async ─────────────────────────────────────────────────────────

/**
 * Advances relevant to payroll recovery for an employee, oldest first. Includes
 * COMPLETED advances too: `applyPeriod` is idempotent and returns a completed
 * advance's recorded installment only for the exact month it was recovered (0 for
 * any other month). Fetching only 'approved' would drop the final installment when
 * a draft month that completes an advance is regenerated.
 */
async function activeAdvances(employeeId) {
  const q = `'${String(employeeId).replace(/'/g, "''")}'`;
  const { data } = await d365.getList(ENTITY, {
    select: SELECT, filter: `hr_employeeid eq ${q} and (hr_status eq 'approved' or hr_status eq 'completed')`, orderby: 'hr_requesteddate asc,createdon asc',
  });
  return (data || []).map(shape);
}

/**
 * Apply the month's advance recovery for an employee and return the total amount
 * to deduct from this month's payroll. Idempotent (safe to re-run on payroll
 * regeneration). Never throws — returns 0 on any failure so payroll is never
 * blocked.
 */
async function applyMonthlyRecovery(employeeId, { year, month }) {
  const period = periodOf(year, month);
  let total = 0;
  try {
    const advances = await activeAdvances(employeeId);
    for (const a of advances) {
      const res = applyPeriod(
        { amount: a.amount, emi: a.emi, recoverFrom: a.recoverFrom, status: a.status, recoverySchedule: a.schedule },
        period,
      );
      total += res.installment;
      if (res.changed) {
        try {
          await d365.update(ENTITY, a.id, {
            hr_recovered: round(res.recovered),
            hr_recoveryschedule: JSON.stringify(res.schedule),
            hr_status: res.status,
          });
        } catch (e) { global.logger?.warn?.(`[advance] recovery write failed for ${a.id}: ${e.message}`); }
      }
    }
  } catch (e) {
    global.logger?.warn?.(`[advance] applyMonthlyRecovery skipped for ${employeeId}: ${e.message}`);
    return 0;
  }
  return round(total);
}

module.exports = {
  ENTITY, SELECT, parseSchedule, computeInstallment, applyPeriod, shape,
  activeAdvances, applyMonthlyRecovery, periodOf,
};
