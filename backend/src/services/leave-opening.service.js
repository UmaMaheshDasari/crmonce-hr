/**
 * Historical Leave Opening Balance — one-time migration of leave already used in
 * the previous (Excel) system. The engine folds these into the live balance:
 *
 *     Current Used   = Opening Used + Leaves taken inside the HR System
 *     Current Remain = Annual Allocation − Current Used
 *
 * One row per employee per leave-year (guarded). Every edit is audited
 * (old/new/by/when/reason), one row per changed field.
 */
const d365 = require('./d365.service');

const OPEN = d365.constructor.entities.leaveOpening;
const AUDIT = d365.constructor.entities.leaveOpeningAudit;

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const OPEN_SELECT = 'hr_leaveopeningid,hr_employeeid,hr_employeename,hr_year,hr_casualused,hr_sickused,hr_earnedused,hr_lopused,hr_compoff,hr_remarks,hr_createdby,createdon,modifiedon';
// hr_earnedused was added later; drop it automatically if the column isn't provisioned yet.
const OPEN_BASE = 'hr_leaveopeningid,hr_employeeid,hr_employeename,hr_year,hr_casualused,hr_sickused,hr_lopused,hr_compoff,hr_remarks,hr_createdby,createdon,modifiedon';
const OPEN_OPT = 'hr_earnedused';

const shape = (r) => ({
  id: r.hr_leaveopeningid,
  employeeId: r.hr_employeeid,
  employeeName: r.hr_employeename || '',
  year: Number(r.hr_year) || null,
  casualUsed: num(r.hr_casualused),
  sickUsed: num(r.hr_sickused),
  earnedUsed: num(r.hr_earnedused),
  lopUsed: num(r.hr_lopused),
  compOff: num(r.hr_compoff),
  remarks: r.hr_remarks || '',
  createdBy: r.hr_createdby || '',
  createdOn: r.createdon,
  modifiedOn: r.modifiedon,
});

/** Raw opening-balance row for an employee/year, or null. Never throws. */
async function getOpeningRow(employeeId, year) {
  try {
    const { data } = await d365.getListOptional(OPEN, {
      select: OPEN_BASE, optionalSelect: OPEN_OPT,
      filter: `hr_employeeid eq '${employeeId}' and hr_year eq '${year}'`,
      top: 1,
    });
    return data && data[0] ? data[0] : null;
  } catch { return null; }
}

/**
 * Opening used/comp-off for the engine. Returns zeros if none / table missing.
 * @returns {{casualUsed:number, sickUsed:number, lopUsed:number, compOff:number}}
 */
async function getOpening(employeeId, year) {
  const row = await getOpeningRow(employeeId, year);
  if (!row) return { casualUsed: 0, sickUsed: 0, earnedUsed: 0, lopUsed: 0, compOff: 0 };
  return { casualUsed: num(row.hr_casualused), sickUsed: num(row.hr_sickused), earnedUsed: num(row.hr_earnedused), lopUsed: num(row.hr_lopused), compOff: num(row.hr_compoff) };
}

/** List opening balances (optionally filtered by year / employee). */
async function list({ year, employeeId } = {}) {
  const filters = [];
  if (year) filters.push(`hr_year eq '${year}'`);
  if (employeeId) filters.push(`hr_employeeid eq '${employeeId}'`);
  const { data } = await d365.getListOptional(OPEN, {
    select: OPEN_BASE, optionalSelect: OPEN_OPT,
    filter: filters.join(' and ') || undefined,
    orderby: 'createdon desc',
    top: 2000,
  });
  return (data || []).map(shape);
}

async function writeAudit({ employeeId, employeeName, year, field, oldValue, newValue, action, updatedBy, reason }) {
  try {
    await d365.create(AUDIT, {
      hr_name: `${employeeName || employeeId} · ${year} · ${field}`.slice(0, 250),
      hr_employeeid: String(employeeId), hr_employeename: employeeName || '', hr_year: String(year),
      hr_field: field, hr_oldvalue: String(oldValue ?? ''), hr_newvalue: String(newValue ?? ''),
      hr_action: action || 'updated', hr_updatedby: updatedBy || '', hr_updatedon: new Date().toISOString(),
      hr_reason: reason || '',
    });
  } catch (e) { global.logger?.warn?.(`[leave-opening] audit write skipped: ${e.message}`); }
}

async function readAudit(employeeId, year) {
  try {
    const filters = [`hr_employeeid eq '${employeeId}'`];
    if (year) filters.push(`hr_year eq '${year}'`);
    const { data } = await d365.getList(AUDIT, {
      select: 'hr_leaveopeningauditid,hr_field,hr_oldvalue,hr_newvalue,hr_action,hr_updatedby,hr_updatedon,hr_reason,hr_year,createdon',
      filter: filters.join(' and '), orderby: 'createdon desc', top: 500,
    });
    return (data || []).map((r) => ({
      id: r.hr_leaveopeningauditid, field: r.hr_field, oldValue: r.hr_oldvalue || '', newValue: r.hr_newvalue || '',
      action: r.hr_action || 'updated', updatedBy: r.hr_updatedby || '', updatedOn: r.hr_updatedon || r.createdon,
      reason: r.hr_reason || '', year: Number(r.hr_year) || null,
    }));
  } catch { return []; }
}

const FIELDS = [
  ['casualUsed', 'hr_casualused', 'Casual Used'],
  ['sickUsed', 'hr_sickused', 'Sick Used'],
  ['earnedUsed', 'hr_earnedused', 'Earned Used'],
  ['lopUsed', 'hr_lopused', 'LOP Used'],
  ['compOff', 'hr_compoff', 'Comp Off'],
  ['remarks', 'hr_remarks', 'Remarks'],
];

/**
 * Create OR update the opening balance for an employee/year. Opening balance is
 * entered only once per year: a second CREATE is rejected; edits go through as
 * updates and are fully audited.
 */
async function upsert({ employeeId, employeeName, year, casualUsed, sickUsed, earnedUsed, lopUsed, compOff, remarks, updatedBy, reason }, { allowUpdate = true } = {}) {
  const existing = await getOpeningRow(employeeId, year);
  const next = {
    casualUsed: num(casualUsed), sickUsed: num(sickUsed), earnedUsed: num(earnedUsed), lopUsed: num(lopUsed),
    compOff: num(compOff), remarks: remarks || '',
  };

  if (!existing) {
    let payload = {
      hr_name: `${employeeName || employeeId} · ${year}`.slice(0, 250),
      hr_employeeid: String(employeeId), hr_employeename: employeeName || '', hr_year: String(year),
      hr_casualused: String(next.casualUsed), hr_sickused: String(next.sickUsed), hr_earnedused: String(next.earnedUsed),
      hr_lopused: String(next.lopUsed), hr_compoff: String(next.compOff),
      hr_remarks: next.remarks, hr_createdby: updatedBy || '',
    };
    let created;
    for (let i = 0; i < 3; i++) {
      try { created = await d365.create(OPEN, payload); break; }
      catch (err) {
        if (d365._isMissingProperty?.(err)) { const p = d365._missingPropertyName?.(err); if (p && payload[p] !== undefined) { delete payload[p]; continue; } }
        throw err;
      }
    }
    await writeAudit({ employeeId, employeeName, year, field: 'Opening Balance', oldValue: '', newValue: `CL ${next.casualUsed} · SL ${next.sickUsed} · EL ${next.earnedUsed} · LOP ${next.lopUsed} · CompOff ${next.compOff}`, action: 'created', updatedBy, reason: reason || 'Created' });
    return { action: 'created', id: created.hr_leaveopeningid };
  }

  if (!allowUpdate) { const e = new Error(`Opening balance for ${year} already exists for this employee.`); e.status = 409; throw e; }

  // Diff each field → audit only what changed.
  const patch = {};
  const prev = shape(existing);
  for (const [key, col, labelText] of FIELDS) {
    const before = prev[key];
    const after = next[key];
    if (String(before) !== String(after)) {
      patch[col] = String(after);
      await writeAudit({ employeeId, employeeName: employeeName || prev.employeeName, year, field: labelText, oldValue: before, newValue: after, action: 'updated', updatedBy, reason });
    }
  }
  if (Object.keys(patch).length) await d365.update(OPEN, existing.hr_leaveopeningid, patch);
  return { action: Object.keys(patch).length ? 'updated' : 'unchanged', id: existing.hr_leaveopeningid };
}

async function remove(id) { return d365.delete(OPEN, id); }

module.exports = { getOpening, getOpeningRow, list, upsert, remove, readAudit, writeAudit, shape };
