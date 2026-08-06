/**
 * Salary Structure — pure helpers for the effective-dated salary revision table
 * (hr_salarystructures). No I/O here: compute Gross (auto), totals & net, validate
 * input, and shape a raw Dataverse row into a clean API object.
 *
 * Effective-dating model: one row per revision. A salary change NEVER overwrites
 * the previous figures — a new row is created with its own `Effective From`, and
 * the latest-dated row for an employee is the `active` one (others `superseded`).
 * The routes layer keeps that status consistent (resequence).
 *
 * Amounts are whole rupees (Integer columns) — rounded on input.
 */

// The six earning components that sum to Gross (spec §2).
const EARNING_FIELDS = ['basic', 'hra', 'special', 'medical', 'conveyance', 'otherAllowance'];
// Deduction components (Gross − these = Net).
const DEDUCTION_FIELDS = ['pfAmount', 'professionalTax', 'incomeTax', 'otherDeductions'];

// Map API (camelCase) ⇆ Dataverse logical (hr_*) column names.
const TO_LOGICAL = {
  employeeId: 'hr_employeeid', employeeName: 'hr_employeename', effectiveFrom: 'hr_effectivefrom',
  basic: 'hr_basic', hra: 'hr_hra', special: 'hr_special', medical: 'hr_medical',
  conveyance: 'hr_conveyance', otherAllowance: 'hr_otherallowance', gross: 'hr_gross',
  pfApplicable: 'hr_pfapplicable', pfAmount: 'hr_pfamount', professionalTax: 'hr_professionaltax',
  incomeTax: 'hr_incometax', otherDeductions: 'hr_otherdeductions',
  status: 'hr_status', remarks: 'hr_remarks', createdBy: 'hr_createdby',
};

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const round = (v) => Math.round(num(v));
const bool = (v) => v === true || /^(true|yes|1|on)$/i.test(String(v ?? ''));
const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''));

/** Gross = Basic + HRA + Special + Medical + Conveyance + Other Allowance. */
function computeGross(src = {}) {
  return EARNING_FIELDS.reduce((sum, f) => sum + round(src[f]), 0);
}

/** { gross, totalDeductions, netSalary } from a normalized/earning+deduction source. */
function computeTotals(src = {}) {
  const gross = computeGross(src);
  const pfApplicable = src.pfApplicable === undefined ? true : bool(src.pfApplicable);
  const pfAmount = pfApplicable ? round(src.pfAmount) : 0;
  const totalDeductions = pfAmount + round(src.professionalTax) + round(src.incomeTax) + round(src.otherDeductions);
  return { gross, totalDeductions, netSalary: gross - totalDeductions };
}

/**
 * Validate + normalize a create/update payload. Returns { ok, errors, value }.
 * `value` holds camelCase normalized fields (numbers rounded, gross computed).
 * @param {object} input   raw request body
 * @param {object} [opts]  { requireEmployee } — POST requires an employee id
 */
function validate(input = {}, opts = {}) {
  const errors = [];
  const v = {};

  if (opts.requireEmployee) {
    const id = String(input.employeeId || '').trim();
    if (!id) errors.push('Please select an employee.');
    else if (!/^[0-9a-fA-F-]{36}$/.test(id)) errors.push('Invalid employee — pick one from the list.');
    else v.employeeId = id;
  }

  if (!isDate(input.effectiveFrom)) errors.push('Effective From must be a valid date (YYYY-MM-DD).');
  else v.effectiveFrom = String(input.effectiveFrom).slice(0, 10);

  const basic = round(input.basic);
  if (!(basic > 0)) errors.push('Basic Salary is required and must be greater than 0.');
  v.basic = basic;

  // Every amount must be a non-negative number.
  for (const f of ['hra', 'special', 'medical', 'conveyance', 'otherAllowance', 'pfAmount', 'professionalTax', 'incomeTax', 'otherDeductions']) {
    const n = round(input[f]);
    if (n < 0) errors.push(`${f} cannot be negative.`);
    v[f] = Math.max(0, n);
  }

  v.pfApplicable = input.pfApplicable === undefined ? true : bool(input.pfApplicable);
  if (!v.pfApplicable) v.pfAmount = 0;   // no PF → force amount to 0

  v.gross = computeGross(v);
  v.status = ['active', 'superseded', 'draft'].includes(input.status) ? input.status : 'active';
  v.remarks = input.remarks != null ? String(input.remarks) : '';
  if (input.employeeName != null) v.employeeName = String(input.employeeName);

  return { ok: errors.length === 0, errors, value: v };
}

/** camelCase normalized value → Dataverse payload (hr_* keys, strings/ints). */
function toDataverse(value = {}) {
  const body = {};
  for (const [k, col] of Object.entries(TO_LOGICAL)) {
    if (value[k] === undefined) continue;
    if (k === 'pfApplicable') body[col] = value[k] ? 'true' : 'false';
    else if (['status', 'remarks', 'employeeId', 'employeeName', 'effectiveFrom', 'createdBy'].includes(k)) body[col] = value[k] == null ? '' : String(value[k]);
    else body[col] = round(value[k]);   // integer amounts
  }
  return body;
}

/** Raw Dataverse row → clean API object (with computed totals). */
function shape(row = {}) {
  const src = {
    basic: row.hr_basic, hra: row.hr_hra, special: row.hr_special, medical: row.hr_medical,
    conveyance: row.hr_conveyance, otherAllowance: row.hr_otherallowance,
    pfApplicable: row.hr_pfapplicable, pfAmount: row.hr_pfamount,
    professionalTax: row.hr_professionaltax, incomeTax: row.hr_incometax, otherDeductions: row.hr_otherdeductions,
  };
  const { gross, totalDeductions, netSalary } = computeTotals(src);
  return {
    id: row.hr_salarystructureid,
    employeeId: row.hr_employeeid || '',
    employeeName: row.hr_employeename || '',
    effectiveFrom: (row.hr_effectivefrom || '').slice(0, 10),
    basic: round(row.hr_basic), hra: round(row.hr_hra), special: round(row.hr_special),
    medical: round(row.hr_medical), conveyance: round(row.hr_conveyance), otherAllowance: round(row.hr_otherallowance),
    gross,
    pfApplicable: bool(row.hr_pfapplicable),
    pfAmount: bool(row.hr_pfapplicable) ? round(row.hr_pfamount) : 0,
    professionalTax: round(row.hr_professionaltax), incomeTax: round(row.hr_incometax), otherDeductions: round(row.hr_otherdeductions),
    totalDeductions, netSalary,
    status: row.hr_status || 'active',
    remarks: row.hr_remarks || '',
    createdBy: row.hr_createdby || '',
    createdOn: row.createdon || null,
    modifiedOn: row.modifiedon || null,
  };
}

// Column list for $select (logical names).
const SELECT = [
  'hr_salarystructureid', 'hr_employeeid', 'hr_employeename', 'hr_effectivefrom',
  'hr_basic', 'hr_hra', 'hr_special', 'hr_medical', 'hr_conveyance', 'hr_otherallowance', 'hr_gross',
  'hr_pfapplicable', 'hr_pfamount', 'hr_professionaltax', 'hr_incometax', 'hr_otherdeductions',
  'hr_status', 'hr_remarks', 'hr_createdby', 'createdon', 'modifiedon',
].join(',');

/**
 * The salary structure in effect for an employee AS OF a date — the latest
 * revision whose Effective From is on/before the date (any status). Returns a
 * shaped object or null. Used by the payroll engine to source earnings.
 * @param {object} d365  the d365 service (injected to keep this module I/O-light)
 */
async function getEffectiveStructure(d365, employeeId, asOfDate) {
  const ENTITY = d365.constructor.entities.salaryStructure;
  const q = `'${String(employeeId).replace(/'/g, "''")}'`;
  const asOf = String(asOfDate || '').slice(0, 10);
  try {
    const { data } = await d365.getListOptional(ENTITY, {
      select: SELECT,
      filter: `hr_employeeid eq ${q}${asOf ? ` and hr_effectivefrom le '${asOf}'` : ''}`,
      orderby: 'hr_effectivefrom desc,createdon desc', top: 1,
    });
    return data && data[0] ? shape(data[0]) : null;
  } catch { return null; }
}

module.exports = {
  EARNING_FIELDS, DEDUCTION_FIELDS, TO_LOGICAL, SELECT,
  computeGross, computeTotals, validate, toDataverse, shape, getEffectiveStructure,
};
