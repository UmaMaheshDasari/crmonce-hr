/**
 * Comp Off — earned by working a holiday / weekly-off (auto-detected) or granted
 * manually by HR. Rich workflow record (status, expiry, approver) in hr_compoffs.
 *
 * Balance is NOT recomputed here: on APPROVAL we write a `comp_off_earned` ledger
 * entry (and reverse it on cancel/expire), so the existing leave-engine balance
 * math and every balance UI keep working unchanged. Comp-off USAGE (applying a
 * comp-off leave) writes `comp_off_used` via the leave flow — also unchanged.
 */
const d365 = require('./d365.service');
const payrollSettings = require('./payroll-settings.service');
const leaveEngine = require('./leave-engine.service');
let attnCfg; try { attnCfg = require('./attendance.config'); } catch (_) { attnCfg = null; }
let notif; try { notif = require('./notification.service'); } catch (_) { notif = null; }
let activity; try { activity = require('./activity.service'); } catch (_) { activity = null; }

const COMP = d365.constructor.entities.compOff;
const EMP = d365.constructor.entities.employee;

const audit = (p) => { try { activity?.record?.(p); } catch (_) {} };
const notifyUser = (id, ev, p) => { try { notif?.notifyUser?.(id, ev, p); } catch (_) {} };
const broadcast = (ev, p) => { try { notif?.broadcast?.(ev, p); } catch (_) {} };
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const today = () => new Date().toISOString().slice(0, 10);
const addDays = (dateStr, days) => { const d = new Date(`${dateStr}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + Number(days)); return d.toISOString().slice(0, 10); };

const SELECT = 'hr_compoffid,hr_employeeid,hr_employeename,hr_year,hr_type,hr_workeddate,hr_workedhours,hr_reason,hr_holidayname,hr_days,hr_expirydate,hr_status,hr_remarks,hr_approvedby,hr_approveddate,hr_createdby,hr_ledgerlinked,createdon,modifiedon';

const shape = (r) => ({
  id: r.hr_compoffid,
  employeeId: r.hr_employeeid,
  employeeName: r.hr_employeename || '',
  year: Number(r.hr_year) || null,
  type: r.hr_type || 'manual',
  workedDate: r.hr_workeddate || '',
  workedHours: num(r.hr_workedhours),
  reason: r.hr_reason || '',
  holidayName: r.hr_holidayname || '',
  days: num(r.hr_days),
  expiryDate: r.hr_expirydate || '',
  status: r.hr_status || 'pending',
  remarks: r.hr_remarks || '',
  approvedBy: r.hr_approvedby || '',
  approvedDate: r.hr_approveddate || '',
  createdBy: r.hr_createdby || '',
  ledgerLinked: r.hr_ledgerlinked === 'true',
  createdOn: r.createdon,
});

async function resolveEmployeeName(id) {
  try { const e = await d365.getById(EMP, id, { select: 'hr_hremployee1' }); return e?.hr_hremployee1 || ''; }
  catch { return ''; }
}

async function getRaw(id) { return d365.getById(COMP, id, { select: SELECT }); }

async function list({ employeeId, year, status } = {}) {
  const filters = [];
  if (employeeId) filters.push(`hr_employeeid eq '${employeeId}'`);
  if (year) filters.push(`hr_year eq '${year}'`);
  if (status) filters.push(`hr_status eq '${status}'`);
  const { data } = await d365.getList(COMP, {
    select: SELECT, filter: filters.join(' and ') || undefined, orderby: 'createdon desc', top: 2000,
  });
  return (data || []).map(shape);
}

// ── ledger bridge ────────────────────────────────────────────────────────────
async function bridgeEarned(row, days) {
  await leaveEngine.addLedgerEntry({
    employeeId: row.hr_employeeid, employeeName: row.hr_employeename, year: Number(row.hr_year) || new Date().getFullYear(),
    kind: 'comp_off_earned', category: 'compoff', days: Number(days),
    effectiveDate: row.hr_workeddate || today(), reason: `Comp Off (${row.hr_type || 'manual'})${row.hr_holidayname ? ' · ' + row.hr_holidayname : ''}`,
    createdBy: 'CompOff',
  });
}

async function policy() {
  try { return (await payrollSettings.getResolved()).compOff; }
  catch { return { expiryDays: 90, autoEarn: true, employeeRaise: true }; }
}

// ── create / raise ───────────────────────────────────────────────────────────
async function create({ employeeId, employeeName, type = 'manual', workedDate, workedHours, reason, holidayName, days = 1, remarks, createdBy, status = 'pending' }) {
  const p = await policy();
  const wd = String(workedDate || today()).slice(0, 10);
  const year = Number(wd.slice(0, 4)) || new Date().getFullYear();
  const expiryDate = Number(p.expiryDays) > 0 ? addDays(wd, p.expiryDays) : '';
  const name = employeeName || (await resolveEmployeeName(employeeId));
  const body = {
    hr_name: `${name || employeeId} · Comp Off · ${wd}`.slice(0, 250),
    hr_employeeid: String(employeeId), hr_employeename: name, hr_year: String(year),
    hr_type: type, hr_workeddate: wd, hr_workedhours: String(num(workedHours)),
    hr_reason: reason || '', hr_holidayname: holidayName || '', hr_days: String(num(days) || 1),
    hr_expirydate: expiryDate, hr_status: status, hr_remarks: remarks || '',
    hr_createdby: createdBy || '', hr_ledgerlinked: 'false',
  };
  const created = await d365.create(COMP, body);
  const rec = { ...body, hr_compoffid: created.hr_compoffid };

  // A manual HR grant can be created already approved → credit immediately.
  if (status === 'approved') {
    await bridgeEarned(rec, num(days) || 1);
    await d365.update(COMP, created.hr_compoffid, { hr_ledgerlinked: 'true', hr_approveddate: new Date().toISOString(), hr_approvedby: createdBy || 'HR' });
    rec.hr_ledgerlinked = 'true';
    notifyUser(employeeId, 'compoff:granted', { days: num(days) || 1, workedDate: wd });
    audit({ category: 'Attendance', type: 'compoff_granted', title: 'Comp Off granted', name, meta: { days: num(days) || 1, workedDate: wd, by: createdBy } });
  } else {
    broadcast('compoff:pending', { employeeName: name, workedDate: wd });
    notifyUser(employeeId, 'compoff:raised', { days: num(days) || 1, workedDate: wd });
    audit({ category: 'Attendance', type: 'compoff_raised', title: 'Comp Off requested', name, meta: { type, workedDate: wd, by: createdBy } });
  }
  return shape(rec);
}

// ── approve / reject / cancel / expire ───────────────────────────────────────
async function approve(id, approver) {
  const row = await getRaw(id);
  if (['approved', 'expired', 'cancelled'].includes(row.hr_status)) { const e = new Error(`Comp Off is already ${row.hr_status}`); e.status = 409; throw e; }
  const days = num(row.hr_days) || 1;
  if (row.hr_ledgerlinked !== 'true') await bridgeEarned(row, days);
  await d365.update(COMP, id, { hr_status: 'approved', hr_approvedby: approver?.name || 'HR', hr_approveddate: new Date().toISOString(), hr_ledgerlinked: 'true' });
  notifyUser(row.hr_employeeid, 'compoff:approved', { days, workedDate: row.hr_workeddate });
  audit({ category: 'Attendance', type: 'compoff_approved', title: 'Comp Off approved', name: row.hr_employeename, meta: { days, by: approver?.name } });
  return shape({ ...row, hr_status: 'approved', hr_ledgerlinked: 'true' });
}

async function reject(id, approver, remarks) {
  const row = await getRaw(id);
  if (row.hr_ledgerlinked === 'true') { const e = new Error('An approved comp-off cannot be rejected — cancel it instead.'); e.status = 400; throw e; }
  await d365.update(COMP, id, { hr_status: 'rejected', hr_approvedby: approver?.name || 'HR', hr_approveddate: new Date().toISOString(), hr_remarks: remarks || '' });
  notifyUser(row.hr_employeeid, 'compoff:rejected', { workedDate: row.hr_workeddate, remarks: remarks || '' });
  audit({ category: 'Attendance', type: 'compoff_rejected', title: 'Comp Off rejected', name: row.hr_employeename, meta: { by: approver?.name } });
  return shape({ ...row, hr_status: 'rejected' });
}

// Reverse the ledger credit (negative earned) for an approved comp-off being pulled back.
async function reverseEarned(row) {
  if (row.hr_ledgerlinked === 'true') {
    await bridgeEarned(row, -(num(row.hr_days) || 1));
  }
}

async function cancel(id, by, remarks) {
  const row = await getRaw(id);
  if (['cancelled', 'expired'].includes(row.hr_status)) return shape(row);
  await reverseEarned(row);
  await d365.update(COMP, id, { hr_status: 'cancelled', hr_ledgerlinked: 'false', hr_remarks: remarks || row.hr_remarks || '' });
  notifyUser(row.hr_employeeid, 'compoff:cancelled', { workedDate: row.hr_workeddate });
  audit({ category: 'Attendance', type: 'compoff_cancelled', title: 'Comp Off cancelled', name: row.hr_employeename, meta: { by: by?.name } });
  return shape({ ...row, hr_status: 'cancelled', hr_ledgerlinked: 'false' });
}

async function expire(id) {
  const row = await getRaw(id);
  if (row.hr_status !== 'approved') return shape(row);
  await reverseEarned(row);
  await d365.update(COMP, id, { hr_status: 'expired', hr_ledgerlinked: 'false' });
  notifyUser(row.hr_employeeid, 'compoff:expired', { workedDate: row.hr_workeddate });
  audit({ category: 'Attendance', type: 'compoff_expired', title: 'Comp Off expired', name: row.hr_employeename, meta: { workedDate: row.hr_workeddate } });
  return shape({ ...row, hr_status: 'expired', hr_ledgerlinked: 'false' });
}

async function edit(id, patch) {
  const allowed = {};
  if (patch.days !== undefined) allowed.hr_days = String(num(patch.days) || 1);
  if (patch.reason !== undefined) allowed.hr_reason = String(patch.reason);
  if (patch.remarks !== undefined) allowed.hr_remarks = String(patch.remarks);
  if (patch.expiryDate !== undefined) allowed.hr_expirydate = String(patch.expiryDate).slice(0, 10);
  if (patch.holidayName !== undefined) allowed.hr_holidayname = String(patch.holidayName);
  if (Object.keys(allowed).length) await d365.update(COMP, id, allowed);
  audit({ category: 'Attendance', type: 'compoff_edited', title: 'Comp Off edited', meta: { id } });
  return shape(await getRaw(id));
}

/** Lazily expire any approved comp-off past its expiry date. Best-effort. */
async function sweepExpired() {
  try {
    const t = today();
    const { data } = await d365.getList(COMP, {
      select: 'hr_compoffid,hr_status,hr_expirydate,hr_ledgerlinked,hr_employeeid,hr_employeename,hr_days,hr_year,hr_workeddate',
      filter: `hr_status eq 'approved'`, top: 2000,
    });
    let expired = 0;
    for (const r of data || []) {
      if (r.hr_expirydate && r.hr_expirydate < t) { await expire(r.hr_compoffid); expired++; }
    }
    return expired;
  } catch { return 0; }
}

// ── auto-detection (holiday / weekly-off work) ───────────────────────────────
function isHoliday(dateStr) { try { return !!attnCfg && attnCfg.holidays.includes(dateStr); } catch { return false; } }
function isWeeklyOff(dateStr) { try { return !!attnCfg && attnCfg.weekOffDays.includes(new Date(`${dateStr}T00:00:00Z`).getUTCDay()); } catch { return false; } }
function holidayName(dateStr) { try { return (attnCfg?.holidayNames && attnCfg.holidayNames[dateStr]) || ''; } catch { return ''; } }

/** Does this employee already have a comp-off (not rejected/cancelled) for that date? */
async function existsForDate(employeeId, workedDate) {
  try {
    const { data } = await d365.getList(COMP, {
      select: 'hr_compoffid,hr_status',
      filter: `hr_employeeid eq '${employeeId}' and hr_workeddate eq '${workedDate}'`,
      top: 5,
    });
    return (data || []).some((r) => !['rejected', 'cancelled'].includes(r.hr_status));
  } catch { return false; }
}

/**
 * Auto-credit comp-off when an employee has a full (present) attendance day on a
 * holiday or weekly-off. Creates a PENDING record (HR approval is the verification
 * gate). Never throws. Returns the created record or null.
 */
async function maybeAutoCompOff({ employeeId, employeeName, date, statusLabel, workedHours }) {
  try {
    const p = await policy();
    if (!p.autoEarn) return null;
    if (statusLabel && !['present', 'half_day'].includes(String(statusLabel))) return null;
    const ds = String(date || '').slice(0, 10);
    if (!ds) return null;
    const hol = isHoliday(ds); const woff = isWeeklyOff(ds);
    if (!hol && !woff) return null;
    if (await existsForDate(employeeId, ds)) return null;
    const days = statusLabel === 'half_day' ? 0.5 : 1;
    return await create({
      employeeId, employeeName, type: 'auto', workedDate: ds, workedHours,
      reason: hol ? 'Worked on company holiday' : 'Worked on weekly-off', holidayName: hol ? holidayName(ds) : '',
      days, createdBy: 'System (auto)', status: 'pending',
    });
  } catch (e) { global.logger?.warn?.(`[comp-off] auto-earn skipped: ${e.message}`); return null; }
}

/** Scan a date range's attendance for holiday/weekly-off work and raise comp-offs. */
async function scanRange({ from, to }) {
  const created = [];
  try {
    const ATT = d365.constructor.entities.attendance;
    const { toValue } = require('./picklist');
    const present = toValue('hr_attendance_status', 'present');
    const { data } = await d365.getList(ATT, {
      select: 'hr_hrattendanceid,hr_date,hr_status,_hr_hremployee_value',
      filter: `hr_date ge '${from}' and hr_date le '${to}'`,
      top: 5000,
    });
    for (const a of data || []) {
      const ds = String(a.hr_date || '').slice(0, 10);
      if (!(isHoliday(ds) || isWeeklyOff(ds))) continue;
      if (a.hr_status !== present) continue;
      const empId = a._hr_hremployee_value;
      if (!empId) continue;
      const name = a['_hr_hremployee_value@OData.Community.Display.V1.FormattedValue'] || '';
      const rec = await maybeAutoCompOff({ employeeId: empId, employeeName: name, date: ds, statusLabel: 'present' });
      if (rec) created.push(rec);
    }
  } catch (e) { global.logger?.warn?.(`[comp-off] scanRange failed: ${e.message}`); }
  return created;
}

module.exports = { list, getRaw, shape, create, approve, reject, cancel, expire, edit, sweepExpired, maybeAutoCompOff, scanRange };
