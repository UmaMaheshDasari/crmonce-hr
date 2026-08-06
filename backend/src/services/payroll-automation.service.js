/**
 * Payroll Automation — orchestrates the end-to-end pipeline for a month:
 *
 *   Attendance → Leave & Comp Off → LOP → Salary Calculation → Payroll →
 *   Payslip PDF → Employee Email → Activity Log → Notification
 *
 * Each run is persisted as a Job (hr_payrolljobs) with per-stage status, a
 * processing log, and a summary. Stages reuse the EXISTING, idempotent payroll
 * code (runGeneration / finalizeMonth) so nothing is duplicated and a retry is
 * safe. Nothing throws out of a stage — failures are captured on the stage.
 */
const d365 = require('./d365.service');
const { toValue } = require('./picklist');
const activity = require('./activity.service');
const { broadcast } = require('./notification.service');
const leaveEngine = require('./leave-engine.service');
const { ensurePayrollJobTable } = require('./provision-payroll-job');

const ENTITY = d365.constructor.entities.payrollJob;
const EMP = d365.constructor.entities.employee;
const LEAVE = d365.constructor.entities.leave;
const ATT = d365.constructor.entities.attendance;
const pad2 = (n) => String(n).padStart(2, '0');
const MONTHS = ['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// ── Stage catalogue (order matters; payroll is the critical stage) ──
const STAGE_DEFS = [
  { key: 'attendance', label: 'Attendance', critical: false },
  { key: 'leave', label: 'Leave & Comp Off', critical: false },
  { key: 'lop', label: 'LOP', critical: false },
  { key: 'payroll', label: 'Salary Calculation & Payroll', critical: true },
  { key: 'payslip', label: 'Payslip · Email · Notification', critical: true },
];

// ── PURE helpers (unit-tested) ──
function blankStages() {
  return STAGE_DEFS.map((s) => ({ key: s.key, label: s.label, critical: s.critical, status: 'pending', count: 0, message: '', startedAt: null, finishedAt: null }));
}
/** Overall job status from its stages. */
function deriveStatus(stages) {
  if (!stages.length) return 'running';
  if (stages.some((s) => s.status === 'running' || s.status === 'pending')) {
    // still in progress unless a critical stage already failed
    if (stages.some((s) => s.status === 'failed' && s.critical)) return 'failed';
    return 'running';
  }
  const anyFailed = stages.some((s) => s.status === 'failed');
  if (!anyFailed) return 'completed';
  if (stages.some((s) => s.status === 'failed' && s.critical)) return 'failed';
  return 'partial';
}
/** Which stage keys a retry should re-run (anything not yet succeeded). */
function stagesToRetry(stages) { return stages.filter((s) => s.status !== 'success').map((s) => s.key); }

// ── persistence ──
function parse(v, fb) { try { const p = JSON.parse(v || ''); return p == null ? fb : p; } catch { return fb; } }
function shapeJob(row = {}) {
  return {
    id: row.hr_payrolljobid, name: row.hr_name || '',
    month: Number(row.hr_month) || 0, year: Number(row.hr_year) || 0,
    status: row.hr_status || 'running', trigger: row.hr_trigger || 'manual', triggeredBy: row.hr_triggeredby || '',
    startedOn: row.hr_startedon || null, finishedOn: row.hr_finishedon || null,
    stages: parse(row.hr_stages, []), summary: parse(row.hr_summary, {}), logs: parse(row.hr_logs, []),
    error: row.hr_error || '', createdOn: row.createdon || null,
  };
}
async function writeJob(id, patch) {
  const body = {};
  for (const [k, v] of Object.entries(patch)) body[k] = (v && typeof v === 'object') ? JSON.stringify(v) : (v == null ? '' : String(v));
  if (id) return d365.update(ENTITY, id, body);
  return d365.create(ENTITY, body);
}

// ── stage implementations (never throw; return {status,count,message,detail}) ──
async function stageAttendance({ month, year, employees }) {
  const from = `${year}-${pad2(month)}-01`;
  const to = `${year}-${pad2(month)}-${pad2(new Date(year, month, 0).getDate())}`;
  const { data } = await d365.getList(ATT, { select: 'hr_date,_hr_hremployee_value', filter: `hr_date ge '${from}' and hr_date le '${to}'`, top: 5000 });
  const withAtt = new Set((data || []).map((r) => r._hr_hremployee_value));
  return { status: 'success', count: withAtt.size, message: `${withAtt.size} of ${employees.length} employees have attendance for ${MONTHS[month]} ${year}.` };
}
async function stageLeave({ month, year }) {
  const approved = toValue('hr_leave_status', 'approved');
  const ym = `${year}-${pad2(month)}`;
  const { data } = await d365.getList(LEAVE, { select: 'hr_fromdate,hr_status', filter: `hr_status eq ${approved}`, top: 5000 });
  const inMonth = (data || []).filter((l) => String(l.hr_fromdate || '').slice(0, 7) === ym).length;
  return { status: 'success', count: inMonth, message: `${inMonth} approved leave record(s) apply to ${MONTHS[month]} ${year}.` };
}
async function stageLop({ month, year, employees }) {
  let totalLop = 0, affected = 0;
  for (const e of employees) {
    const split = await leaveEngine.splitMonthLeave(e.hr_hremployeeid, { year, month });
    if (split.lopLeaveDays > 0) { totalLop += split.lopLeaveDays; affected++; }
  }
  return { status: 'success', count: affected, message: `${totalLop} LOP day(s) across ${affected} employee(s) will reduce pay.` };
}
async function stagePayroll({ month, year, employeeIds }) {
  const payroll = require('../modules/payroll/payroll.routes');   // lazy — avoids any load-order cycle
  const r = await payroll.runGeneration({ month, year, employeeIds });
  return { status: 'success', count: r.created + r.updated, message: `Payroll calculated: ${r.created} created, ${r.updated} updated (${r.skipped} finalised, ${r.locked} locked skipped).`, detail: r };
}
async function stageFinalize({ month, year, employeeIds }) {
  const payroll = require('../modules/payroll/payroll.routes');
  const r = await payroll.finalizeMonth({ month, year, employeeIds });
  activity.record({ category: 'Payroll', type: 'payroll_automation', title: 'Payroll Automation', name: 'Automation', meta: `Automation finalised ${MONTHS[month]} ${year}: ${r.approved} approved, ${r.emailed} payslips emailed` });
  broadcast('payroll:processed', { month: `${month}/${year}`, count: r.approved });
  const msg = `${r.approved} approved · ${r.emailed} payslip email(s) sent${r.emailFailed ? ` · ${r.emailFailed} email(s) failed` : ''} · ${r.notified} notified.`;
  // Email failures are reported but do NOT fail the stage (payroll is still done).
  return { status: 'success', count: r.approved, message: msg, detail: r };
}
const RUNNERS = { attendance: stageAttendance, leave: stageLeave, lop: stageLop, payroll: stagePayroll, payslip: stageFinalize };

// ── orchestration ──
async function ensureTable() { try { await d365.getList(ENTITY, { top: 1 }); } catch { await ensurePayrollJobTable(global.logger || console).catch(() => {}); } }

async function runStages({ id, month, year, employeeIds, stages, logs, summary, onlyKeys }) {
  const employees = await (async () => {
    const filter = employeeIds?.length ? employeeIds.map((x) => `hr_hremployeeid eq '${x}'`).join(' or ') : `hr_status eq ${toValue('hr_employee_status', 'active')}`;
    const { data } = await d365.getList(EMP, { select: 'hr_hremployeeid', filter, top: 5000 });
    return data || [];
  })();
  const log = (level, message) => logs.push({ ts: new Date().toISOString(), level, message });

  for (const st of stages) {
    if (onlyKeys && !onlyKeys.includes(st.key)) continue;
    st.status = 'running'; st.startedAt = new Date().toISOString(); st.message = '';
    await writeJob(id, { hr_stages: stages, hr_logs: logs, hr_status: 'running' }).catch(() => {});
    try {
      const res = await RUNNERS[st.key]({ month, year, employeeIds, employees });
      st.status = res.status || 'success'; st.count = res.count || 0; st.message = res.message || '';
      if (res.detail) summary[st.key] = res.detail;
      log('info', `${st.label}: ${st.message}`);
    } catch (e) {
      st.status = 'failed'; st.message = e.message;
      log('error', `${st.label} FAILED: ${e.message}`);
      if (st.critical) { st.finishedAt = new Date().toISOString(); await writeJob(id, { hr_stages: stages, hr_logs: logs }).catch(() => {}); break; }
    }
    st.finishedAt = new Date().toISOString();
    await writeJob(id, { hr_stages: stages, hr_logs: logs, hr_summary: summary }).catch(() => {});
  }
}

// Run the stages + finalise the job status, then persist. Used by run + retry.
async function executeJob({ id, month, year, employeeIds, stages, logs, summary, onlyKeys, kind = 'Automation' }) {
  try {
    await runStages({ id, month, year, employeeIds, stages, logs, summary, onlyKeys });
    const status = deriveStatus(stages);
    logs.push({ ts: new Date().toISOString(), level: status === 'completed' ? 'info' : 'warn', message: `${kind} finished: ${status}.` });
    await writeJob(id, { hr_status: status, hr_finishedon: new Date().toISOString(), hr_stages: stages, hr_summary: summary, hr_logs: logs }).catch(() => {});
  } catch (e) {
    logs.push({ ts: new Date().toISOString(), level: 'error', message: `${kind} crashed: ${e.message}` });
    await writeJob(id, { hr_status: 'failed', hr_error: e.message, hr_finishedon: new Date().toISOString(), hr_logs: logs }).catch(() => {});
  }
}

/**
 * Start a new automation run. Creates the job, kicks stages off in the BACKGROUND
 * (so the HTTP call returns immediately — the UI polls), and returns the running
 * job. Set `wait:true` to await completion (used by the scheduled cron).
 */
async function runJob({ month, year, employeeIds, user, trigger = 'manual', wait = false }) {
  await ensureTable();
  const stages = blankStages();
  const logs = [{ ts: new Date().toISOString(), level: 'info', message: `Automation started for ${MONTHS[month]} ${year} by ${user?.name || 'system'}.` }];
  const summary = {};
  const created = await writeJob(null, {
    hr_name: `Payroll ${MONTHS[month]} ${year}`, hr_month: month, hr_year: year, hr_status: 'running',
    hr_trigger: trigger, hr_triggeredby: user?.name || user?.email || 'system', hr_startedon: new Date().toISOString(),
    hr_stages: stages, hr_summary: summary, hr_logs: logs,
  });
  const id = created.hr_payrolljobid;
  const exec = executeJob({ id, month, year, employeeIds, stages, logs, summary });
  if (wait) await exec; else exec.catch(() => {});
  return shapeJob({ ...created, hr_payrolljobid: id, hr_stages: JSON.stringify(stages), hr_logs: JSON.stringify(logs), hr_summary: JSON.stringify(summary) });
}

/** Retry the not-yet-succeeded stages of an existing job (background). */
async function retryJob({ jobId, user }) {
  const job = shapeJob(await d365.getById(ENTITY, jobId, { select: '*' }));
  const stages = job.stages.length ? job.stages : blankStages();
  const logs = job.logs || [];
  const summary = job.summary || {};
  const retryKeys = stagesToRetry(stages);
  logs.push({ ts: new Date().toISOString(), level: 'info', message: `Retry by ${user?.name || 'system'} — re-running: ${retryKeys.join(', ') || 'nothing'}.` });
  await writeJob(jobId, { hr_status: 'running', hr_logs: logs }).catch(() => {});
  executeJob({ id: jobId, month: job.month, year: job.year, employeeIds: undefined, stages, logs, summary, onlyKeys: retryKeys, kind: 'Retry' }).catch(() => {});
  return shapeJob(await d365.getById(ENTITY, jobId, { select: '*' }));
}

async function listJobs({ top = 50 } = {}) {
  try {
    const { data } = await d365.getList(ENTITY, { select: 'hr_payrolljobid,hr_name,hr_month,hr_year,hr_status,hr_trigger,hr_triggeredby,hr_startedon,hr_finishedon,hr_stages', orderby: 'createdon desc', top });
    return (data || []).map(shapeJob);
  } catch { return []; }
}
async function getJob(id) { return shapeJob(await d365.getById(ENTITY, id, { select: '*' })); }

module.exports = { runJob, retryJob, listJobs, getJob, deriveStatus, stagesToRetry, blankStages, STAGE_DEFS, shapeJob };
