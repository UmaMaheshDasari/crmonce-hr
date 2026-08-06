/**
 * Professional Tax Master — the single, configurable source for PT.
 *
 * getProfessionalTax(state, grossSalary, payrollDate) resolves the PT amount from
 * the effective-dated slab table (hr_ptslabs), so:
 *   • HR manages slabs (add / edit / deactivate / future-date) with NO code change,
 *   • payroll picks the slab by State + Gross + Month,
 *   • historical payroll keeps using the slab that was effective then (the resolved
 *     amount is stored on the payroll row, so old payslips never change),
 *   • if the master is empty/unavailable it falls back to the built-in slab
 *     (professional-tax.js) — 100% backward compatible.
 *
 * The resolver is PURE (resolveSlab) and unit-tested; the async layer just loads +
 * caches the active slabs.
 */
const d365 = require('./d365.service');
const { calculateProfessionalTax } = require('./professional-tax');

const ENTITY = 'hr_ptslabs';
const SELECT = 'hr_ptslabid,hr_name,hr_state,hr_effectivefrom,hr_effectiveto,hr_salaryfrom,hr_salaryto,hr_amount,hr_status,hr_remarks,createdon,modifiedon';

const S = (v) => String(v == null ? '' : v).trim();
const N = (v) => Math.max(0, Math.round(Number(v) || 0));
const dstr = (v) => S(v).slice(0, 10);

function shape(row = {}) {
  return {
    id: row.hr_ptslabid, name: row.hr_name || '',
    state: row.hr_state || '', effectiveFrom: dstr(row.hr_effectivefrom), effectiveTo: dstr(row.hr_effectiveto),
    salaryFrom: N(row.hr_salaryfrom), salaryTo: N(row.hr_salaryto),   // salaryTo 0 = no upper bound
    amount: N(row.hr_amount), status: row.hr_status || 'active', remarks: row.hr_remarks || '',
    createdOn: row.createdon || null, modifiedOn: row.modifiedon || null,
  };
}

/**
 * PURE resolver: pick the PT amount for (state, gross, date) from a slab list.
 * Returns a number, or null when no slab matches (caller then falls back).
 */
function resolveSlab(slabs, { state, gross, date }) {
  const g = N(gross);
  const d = dstr(date) || '9999-12-31';
  const st = S(state).toLowerCase();
  const matches = (slabs || []).filter((s) => {
    if (S(s.status).toLowerCase() !== 'active') return false;
    // State: a slab with a blank state applies to any state; else must match.
    if (S(s.state) && S(s.state).toLowerCase() !== st) return false;
    if (s.effectiveFrom && d < s.effectiveFrom) return false;
    if (s.effectiveTo && d > s.effectiveTo) return false;
    if (g < N(s.salaryFrom)) return false;
    const to = N(s.salaryTo);
    if (to > 0 && g > to) return false;
    return true;
  });
  if (!matches.length) return null;
  // On overlap, the most recently effective slab wins (future rules supersede),
  // then the narrower band, then the higher amount — deterministic.
  matches.sort((a, b) =>
    String(b.effectiveFrom).localeCompare(String(a.effectiveFrom)) ||
    ((N(a.salaryTo) || Infinity) - N(a.salaryFrom)) - ((N(b.salaryTo) || Infinity) - N(b.salaryFrom)) ||
    (N(b.amount) - N(a.amount)));
  return N(matches[0].amount);
}

// ── cached load of active slabs ──
let cache = null, cacheAt = 0;
const TTL = 5 * 60 * 1000;
function invalidate() { cache = null; cacheAt = 0; }

async function loadActiveSlabs() {
  const now = Date.now();
  if (cache && now - cacheAt < TTL) return cache;
  try {
    const { data } = await d365.getList(ENTITY, { select: SELECT, filter: `hr_status eq 'active'`, top: 2000 });
    cache = (data || []).map(shape); cacheAt = now;
  } catch { cache = cache || []; }   // table missing → empty; getProfessionalTax falls back
  return cache;
}

/**
 * The reusable function used everywhere (payroll generation, salary preview).
 * Never throws — falls back to the built-in slab if the master can't answer.
 */
async function getProfessionalTax(state, grossSalary, payrollDate) {
  try {
    const amount = resolveSlab(await loadActiveSlabs(), { state, gross: grossSalary, date: payrollDate });
    return amount == null ? calculateProfessionalTax(grossSalary) : amount;
  } catch { return calculateProfessionalTax(grossSalary); }
}

// ── CRUD (used by the routes) ──
async function listSlabs() {
  const { data } = await d365.getList(ENTITY, { select: SELECT, orderby: 'hr_state asc,hr_salaryfrom asc', top: 2000 });
  return (data || []).map(shape);
}
function toDataverse(input = {}) {
  const state = S(input.state) || 'Andhra Pradesh';
  const salaryFrom = N(input.salaryFrom), salaryTo = N(input.salaryTo), amount = N(input.amount);
  return {
    hr_name: `${state} · ${salaryFrom}-${salaryTo || '∞'} · ₹${amount}`.slice(0, 200),
    hr_state: state, hr_effectivefrom: dstr(input.effectiveFrom), hr_effectiveto: dstr(input.effectiveTo),
    hr_salaryfrom: salaryFrom, hr_salaryto: salaryTo, hr_amount: amount,
    hr_status: ['active', 'inactive'].includes(input.status) ? input.status : 'active',
    hr_remarks: S(input.remarks),
  };
}

module.exports = { getProfessionalTax, resolveSlab, shape, toDataverse, listSlabs, loadActiveSlabs, invalidate, ENTITY, SELECT };
