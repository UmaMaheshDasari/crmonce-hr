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
// Email an employee (best-effort; never throws / blocks the caller).
async function emailEmployee(employeeId, subject, html) {
  try {
    const e = await d365.getById(EMP, employeeId, { select: 'hr_email,hr_hremployee1' });
    if (e?.hr_email) await notif?.sendEmail?.(e.hr_email, subject, html);
  } catch (err) { global.logger?.warn?.(`[comp-off] email skipped: ${err.message}`); }
}
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const pad2 = (n) => String(n).padStart(2, '0');
const today = () => new Date().toISOString().slice(0, 10);
const addDays = (dateStr, days) => { const d = new Date(`${dateStr}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + Number(days)); return d.toISOString().slice(0, 10); };

/**
 * Comp-off days earned for a day's EFFECTIVE worked hours (break already excluded).
 * The single, shared rule for BOTH eTime-sync auto-earn and the month-end scan so
 * they can never disagree:  ≥8h → 1 · >5h and <8h → 0.5 · ≤5h → 0. Never more than 1.
 */
function compOffDaysForHours(effectiveHours) {
  const h = Number(effectiveHours) || 0;
  if (h >= 8) return 1;
  if (h > 5) return 0.5;
  return 0;
}

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
  const rows = (data || []).map(shape);
  // Deletability for the UI: pending / rejected / cancelled / expired → deletable. An
  // APPROVED (ledger-credited) record is deletable ONLY while still UNUSED (the balance
  // still covers its days); a used credit cannot be pulled back. Balance looked up once
  // per employee. The backend delete re-checks — this is only to show/disable the button.
  const balCache = new Map();
  const balanceOf = async (empId, yr) => {
    const key = `${empId}|${yr}`;
    if (!balCache.has(key)) balCache.set(key, await leaveEngine.getBalance(empId, yr).then(b => (b?.compOff?.balance ?? null)).catch(() => null));
    return balCache.get(key);
  };
  for (const r of rows) {
    if (r.status === 'approved' && r.ledgerLinked) {
      const bal = await balanceOf(r.employeeId, r.year || new Date().getFullYear());
      r.used = bal != null ? bal < r.days : false;
    } else { r.used = false; }
    r.deletable = !(r.status === 'approved' && r.used);
  }
  return rows;
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
  catch { return { expiryDays: 45, autoEarn: true, employeeRaise: true }; }
}

// ── create / raise ───────────────────────────────────────────────────────────
async function create({ employeeId, employeeName, type = 'manual', workedDate, workedHours, reason, holidayName, days = 1, remarks, createdBy, status = 'pending' }) {
  const p = await policy();
  const wd = String(workedDate || today()).slice(0, 10);
  const year = Number(wd.slice(0, 4)) || new Date().getFullYear();
  // Expiry starts ONLY at approval — a PENDING record has NO expiry yet. A record
  // created already-approved (a manual HR grant) expires from its APPROVAL date (= now),
  // never the worked date. Reuses the existing 45-day policy (p.expiryDays).
  const expiryDate = (status === 'approved' && Number(p.expiryDays) > 0) ? addDays(today(), p.expiryDays) : '';
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

/**
 * LIVE attendance re-verification for an AUTO comp-off (attendance may have changed
 * since it was generated). Confirms: the day is a Holiday/Weekly-Off, a real attendance
 * record exists with a punch + present/half status, and the EFFECTIVE hours still
 * qualify. Returns { ok, computedDays, effectiveHours, reason }. Manual HR grants are
 * not attendance-derived, so they skip verification (HR discretion).
 */
async function verifyEligibility(row) {
  const ds = String(row?.hr_workeddate || '').slice(0, 10);
  const empId = row?.hr_employeeid;
  if (String(row?.hr_type) !== 'auto') return { ok: true, computedDays: num(row?.hr_days) || 1, reason: 'manual grant (not attendance-verified)' };
  if (!ds || !empId) return { ok: false, reason: 'Missing employee or worked date.' };
  if (!(isHoliday(ds) || isWeeklyOff(ds))) return { ok: false, reason: 'The worked date is not a Holiday or Weekly-Off.' };
  const { toLabel } = require('./picklist');
  const ATT = d365.constructor.entities.attendance;
  let att = null;
  try {
    const { data } = await d365.getList(ATT, {
      select: 'hr_hrattendanceid,hr_date,hr_status,hr_intime,hr_effectivehours,hr_workedhours,_hr_hremployee_value',
      filter: `_hr_hremployee_value eq '${empId}' and hr_date ge '${ds}' and hr_date le '${ds}'`, top: 5,
    });
    att = (data || [])[0] || null;
  } catch (e) { return { ok: false, reason: `Attendance lookup failed: ${e.message}` }; }
  if (!att) return { ok: false, reason: 'No attendance record exists for this date.' };
  if (!att.hr_intime || !['present', 'half_day'].includes(String(toLabel('hr_attendance_status', att.hr_status)))) return { ok: false, reason: 'The employee did not actually work on this date.' };
  const eff = (att.hr_effectivehours != null && att.hr_effectivehours !== '') ? Number(att.hr_effectivehours) : Number(att.hr_workedhours) || 0;
  const computedDays = compOffDaysForHours(eff);
  if (!computedDays) return { ok: false, reason: `Effective worked hours (${eff}h) do not qualify for Comp Off.` };
  return { ok: true, computedDays, effectiveHours: eff };
}

// Decimal hours → "9h 17m" (display only — eligibility ALWAYS uses the exact decimal).
function fmtHours(h) {
  const n = Math.max(0, Number(h) || 0);
  const hh = Math.floor(n), mm = Math.round((n - hh) * 60);
  return mm ? `${hh}h ${mm}m` : `${hh}h`;
}
const SOURCE_LABEL = { etime_device: 'Device', web_checkin: 'Web', manual_correction: 'Manual' };

/**
 * Full attendance verification for the HR "Check Attendance" modal AND the authoritative
 * eligibility. Reads the employee's attendance for the comp-off's EXACT worked date and
 * returns every display field plus the calculated eligibility (same rule as approve() and
 * the month-end scan — never a second calculation). HR-facing; read-only.
 */
async function attendanceVerification(id) {
  const row = await getRaw(id);
  const ds = String(row.hr_workeddate || '').slice(0, 10);
  const empId = row.hr_employeeid;
  const isAuto = String(row.hr_type) === 'auto';
  const holiday = isHoliday(ds), weeklyOff = isWeeklyOff(ds);
  const day = ds ? new Date(`${ds}T00:00:00Z`).toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' }) : '';
  const base = {
    id, employeeId: empId, employeeName: row.hr_employeename || '', workedDate: ds, day,
    type: row.hr_type || 'manual', reason: row.hr_reason || '', holidayName: holiday ? holidayName(ds) : '',
    compOffStatus: row.hr_status || 'pending', storedDays: num(row.hr_days), holiday, weeklyOff,
  };

  const { toLabel } = require('./picklist');
  let att = null;
  try {
    const { data } = await d365.getList(d365.constructor.entities.attendance, {
      select: 'hr_hrattendanceid,hr_date,hr_intime,hr_outtime,hr_status,hr_source,hr_allpunches,hr_punchcount,hr_breakduration,hr_effectivehours,hr_workedhours,_hr_hremployee_value',
      filter: `_hr_hremployee_value eq '${empId}' and hr_date ge '${ds}' and hr_date le '${ds}'`, top: 5,
    });
    att = (data || [])[0] || null;
  } catch (_) { att = null; }

  if (!att) {
    return { ...base, attendanceFound: false, attendance: null, effectiveHours: 0,
      eligible: false, eligibleDays: 0, eligibilityLabel: 'NOT ELIGIBLE',
      eligibilityReason: 'No attendance record exists for this date.' };
  }

  const statusLabel = toLabel('hr_attendance_status', att.hr_status) || String(att.hr_status || '');
  const worked = !!att.hr_intime && ['present', 'half_day'].includes(statusLabel);
  const eff = (att.hr_effectivehours != null && att.hr_effectivehours !== '') ? Number(att.hr_effectivehours) : Number(att.hr_workedhours) || 0;
  let punches = [];
  try { const p = JSON.parse(att.hr_allpunches || '[]'); if (Array.isArray(p)) punches = p; } catch { /* malformed → none */ }
  const brk = Number(att.hr_breakduration) || 0;

  const hoursDays = compOffDaysForHours(eff);   // exact decimal → 0 | 0.5 | 1
  let eligible, eligibleDays, reason;
  if (!(holiday || weeklyOff) && isAuto) { eligible = false; eligibleDays = 0; reason = 'The worked date is not a Holiday or Weekly-Off.'; }
  else if (!worked) { eligible = false; eligibleDays = 0; reason = 'The employee did not actually work on this date (no valid punch / not Present).'; }
  else if (!hoursDays) { eligible = false; eligibleDays = 0; reason = `Effective hours (${fmtHours(eff)}) are 5h or less — not eligible.`; }
  else { eligible = true; eligibleDays = hoursDays; reason = ''; }
  const eligibilityLabel = !eligible ? 'NOT ELIGIBLE' : eligibleDays === 1 ? 'FULL DAY – 1' : 'HALF DAY – 0.5';

  return {
    ...base, attendanceFound: true, effectiveHours: eff,
    attendance: {
      status: statusLabel, inTime: att.hr_intime || '', outTime: att.hr_outtime || '',
      punches, punchCount: Number(att.hr_punchcount) || punches.length,
      effectiveHours: eff, effectiveHoursLabel: fmtHours(eff),
      breakHours: brk, breakLabel: fmtHours(brk),
      source: SOURCE_LABEL[toLabel('hr_attendance_source', att.hr_source)] || toLabel('hr_attendance_source', att.hr_source) || att.hr_source || '—',
    },
    eligible, eligibleDays, eligibilityLabel, eligibilityReason: reason,
  };
}

// ── approve / reject / cancel / expire ───────────────────────────────────────
async function approve(id, approver) {
  const row = await getRaw(id);
  if (['approved', 'expired', 'cancelled'].includes(row.hr_status)) { const e = new Error(`Comp Off is already ${row.hr_status}`); e.status = 409; throw e; }
  // LIVE attendance re-verification (auto records) — never trust the stored values alone;
  // attendance may have changed. Credit the RECOMPUTED days so the balance matches reality.
  const v = await verifyEligibility(row);
  if (!v.ok) { const e = new Error('Comp Off cannot be approved because the attendance does not qualify.'); e.status = 400; e.reason = v.reason; throw e; }
  const days = num(v.computedDays) || num(row.hr_days) || 1;
  if (row.hr_ledgerlinked !== 'true') await bridgeEarned({ ...row, hr_days: String(days) }, days);
  // Expiry clock STARTS at approval — approval date + the 45-day policy (never the
  // worked date). The 409 guard above means a second approve can't reset this.
  const p = await policy();
  const expiryDate = Number(p.expiryDays) > 0 ? addDays(today(), p.expiryDays) : '';
  await d365.update(COMP, id, { hr_status: 'approved', hr_days: String(days), hr_approvedby: approver?.name || 'HR', hr_approveddate: new Date().toISOString(), hr_ledgerlinked: 'true', hr_expirydate: expiryDate });
  notifyUser(row.hr_employeeid, 'compoff:approved', { days, workedDate: row.hr_workeddate });
  audit({ category: 'Attendance', type: 'compoff_approved', title: 'Comp Off approved', name: row.hr_employeename, meta: { days, by: approver?.name } });
  return shape({ ...row, hr_days: String(days), hr_status: 'approved', hr_ledgerlinked: 'true', hr_expirydate: expiryDate });
}

async function reject(id, approver, remarks) {
  const row = await getRaw(id);
  if (row.hr_ledgerlinked === 'true') { const e = new Error('An approved comp-off cannot be rejected — cancel it instead.'); e.status = 400; throw e; }
  // Rejected → no balance credited and NO expiry (it never started).
  await d365.update(COMP, id, { hr_status: 'rejected', hr_approvedby: approver?.name || 'HR', hr_approveddate: new Date().toISOString(), hr_expirydate: '', hr_remarks: remarks || '' });
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
  // Notify the employee — in-app + email (both best-effort).
  notifyUser(row.hr_employeeid, 'compoff:expired', { workedDate: row.hr_workeddate, days: num(row.hr_days) });
  const days = num(row.hr_days) || 1;
  emailEmployee(row.hr_employeeid,
    'Comp Off Expired',
    `<p>Hi ${row.hr_employeename || ''},</p><p>Your Comp Off of <b>${days} day(s)</b> earned for ${row.hr_workeddate || 'a worked day'} has <b>expired</b> and has been removed from your balance.</p><p>Comp Off must be used within the validity period after the worked date.</p>`);
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

/**
 * Expire any approved comp-off past its expiry date (mark Expired, reverse the
 * balance, notify email + in-app). Runs daily via cron and is also called
 * per-employee before a comp-off balance check so expired credits can never be
 * used. Best-effort. Pass an employeeId to scope to one employee.
 */
async function sweepExpired(employeeId) {
  try {
    const t = today();
    const filter = employeeId
      ? `hr_status eq 'approved' and hr_employeeid eq '${String(employeeId).replace(/'/g, "''")}'`
      : `hr_status eq 'approved'`;
    const { data } = await d365.getList(COMP, {
      select: 'hr_compoffid,hr_status,hr_expirydate,hr_ledgerlinked,hr_employeeid,hr_employeename,hr_days,hr_year,hr_workeddate',
      filter, top: 5000,
    });
    let expired = 0;
    for (const r of data || []) {
      if (r.hr_expirydate && r.hr_expirydate < t) { await expire(r.hr_compoffid); expired++; }
    }
    return expired;
  } catch { return 0; }
}

/** Nearest upcoming comp-off expiry date for an employee (approved, non-expired). */
async function nextExpiry(employeeId) {
  try {
    const t = today();
    const { data } = await d365.getList(COMP, {
      select: 'hr_expirydate',
      filter: `hr_status eq 'approved' and hr_employeeid eq '${String(employeeId).replace(/'/g, "''")}'`,
      top: 5000,
    });
    const dates = (data || []).map(r => r.hr_expirydate).filter(d => d && d >= t).sort();
    return dates[0] || null;
  } catch { return null; }
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
async function maybeAutoCompOff({ employeeId, employeeName, date, statusLabel, effectiveHours, workedHours }) {
  try {
    const p = await policy();
    if (!p.autoEarn) return null;
    if (statusLabel && !['present', 'half_day'].includes(String(statusLabel))) return null;
    const ds = String(date || '').slice(0, 10);
    if (!ds) return null;
    const hol = isHoliday(ds); const woff = isWeeklyOff(ds);
    if (!hol && !woff) return null;
    // Days from EFFECTIVE hours (break excluded) — the SAME rule the month-end scan uses.
    // Prefer effectiveHours; fall back to workedHours (eTime device rows have no break).
    const hours = (effectiveHours != null && effectiveHours !== '') ? effectiveHours : workedHours;
    const days = compOffDaysForHours(hours);
    if (!days) return null;                       // ≤5h worked → no comp-off
    if (await existsForDate(employeeId, ds)) return null;
    return await create({
      employeeId, employeeName, type: 'auto', workedDate: ds, workedHours: num(hours),
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
      select: 'hr_hrattendanceid,hr_date,hr_status,hr_intime,hr_effectivehours,hr_workedhours,_hr_hremployee_value',
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
      const eff = (a.hr_effectivehours != null && a.hr_effectivehours !== '') ? a.hr_effectivehours : a.hr_workedhours;
      const rec = await maybeAutoCompOff({ employeeId: empId, employeeName: name, date: ds, statusLabel: 'present', effectiveHours: eff });
      if (rec) created.push(rec);
    }
  } catch (e) { global.logger?.warn?.(`[comp-off] scanRange failed: ${e.message}`); }
  return created;
}

/**
 * MONTH-END Comp-Off scan for ONE completed month. For every employee who actually
 * WORKED on a Holiday or Weekly-Off in [month], credit comp-off from EFFECTIVE hours
 * (≥8→1, >5&&<8→0.5, ≤5→0), as a PENDING `auto` record (HR approval → ledger → balance).
 *
 * Eligibility (existing rules): the day must be a Holiday or Weekly-Off (normal working
 * days never earn), the employee ACTIVE and employed on that date, and the attendance
 * valid (a real in-punch + present/half status — no absent / missing punch / leave-only).
 * Idempotent via existsForDate (Employee + Attendance Date) — a re-run creates NO
 * duplicates. Month-isolated by the [from,to] query. Per-row try/catch: one bad row
 * never stops the month. Returns a structured summary (also logged).
 */
async function scanMonthCompOff({ month, year }) {
  const m = Number(month), y = Number(year);
  const summary = { month: m, year: y, employeesScanned: 0, daysScanned: 0, fullCompOff: 0, halfCompOff: 0, duplicatesSkipped: 0, ineligibleDays: 0, invalidSkipped: 0, errors: [] };
  if (!m || m < 1 || m > 12 || !y) { summary.errors.push({ error: 'invalid month/year' }); return summary; }
  try {
    const p = await policy();
    if (!p.autoEarn) { global.logger?.info(`[comp-off] month-end scan ${m}/${y} skipped — auto-earn disabled.`); summary.skipped = true; return summary; }

    const { toValue, toLabel } = require('./picklist');
    const ATT = d365.constructor.entities.attendance;
    const from = `${y}-${pad2(m)}-01`;
    const to = `${y}-${pad2(m)}-${pad2(new Date(y, m, 0).getDate())}`;

    // Active employees (+ employment dates) — the eligibility gate for each row.
    const { data: emps } = await d365.getListOptional(EMP, {
      select: 'hr_hremployeeid,hr_hremployee1,hr_status,hr_joiningdate',
      optionalSelect: 'hr_relievingdate',
      filter: `hr_status eq ${toValue('hr_employee_status', 'active')}`, top: 5000,
    });
    const empMap = new Map((emps || []).map((e) => [e.hr_hremployeeid, e]));
    summary.employeesScanned = empMap.size;

    // Attendance for the month ONLY (month isolation).
    const { data: atts } = await d365.getListOptional(ATT, {
      select: 'hr_hrattendanceid,hr_date,hr_status,hr_intime,_hr_hremployee_value',
      optionalSelect: 'hr_effectivehours,hr_workedhours',
      filter: `hr_date ge '${from}' and hr_date le '${to}'`, top: 10000,
    });

    for (const a of atts || []) {
      try {
        summary.daysScanned++;
        const ds = String(a.hr_date || '').slice(0, 10);
        const empId = a._hr_hremployee_value;
        if (!ds || !empId) { summary.invalidSkipped++; continue; }
        // Eligibility (A1): Holiday OR Weekly-Off only — a normal working day never earns.
        if (!(isHoliday(ds) || isWeeklyOff(ds))) { summary.ineligibleDays++; continue; }
        // Employee ACTIVE + employed on that date.
        const emp = empMap.get(empId);
        if (!emp) { summary.invalidSkipped++; continue; }                                   // inactive/unknown
        if (emp.hr_joiningdate && ds < String(emp.hr_joiningdate).slice(0, 10)) { summary.invalidSkipped++; continue; }
        if (emp.hr_relievingdate && ds > String(emp.hr_relievingdate).slice(0, 10)) { summary.invalidSkipped++; continue; }
        // ACTUALLY worked: a real in-punch + a present/half status (excludes absent /
        // missing-punch / leave-only rows — leave without work has no in-punch).
        const statusLabel = toLabel('hr_attendance_status', a.hr_status);
        if (!a.hr_intime || !['present', 'half_day'].includes(String(statusLabel))) { summary.invalidSkipped++; continue; }
        // Authoritative EFFECTIVE hours (break excluded); fall back to workedHours (legacy/device).
        const eff = (a.hr_effectivehours != null && a.hr_effectivehours !== '') ? Number(a.hr_effectivehours) : Number(a.hr_workedhours) || 0;
        const days = compOffDaysForHours(eff);
        if (!days) { summary.ineligibleDays++; continue; }                                   // ≤5h worked
        // Idempotency: Employee + Attendance Date — a re-run skips the existing record.
        if (await existsForDate(empId, ds)) { summary.duplicatesSkipped++; continue; }
        await create({
          employeeId: empId, employeeName: emp.hr_hremployee1, type: 'auto', workedDate: ds, workedHours: eff,
          reason: isHoliday(ds) ? 'Worked on company holiday' : 'Worked on weekly-off', holidayName: isHoliday(ds) ? holidayName(ds) : '',
          days, createdBy: 'System (auto)', status: 'pending',
        });
        if (days === 1) summary.fullCompOff++; else summary.halfCompOff++;
      } catch (e) {
        summary.errors.push({ date: a?.hr_date, employeeId: a?._hr_hremployee_value, error: e.message });
        global.logger?.warn?.(`[comp-off] month-end row failed (${a?._hr_hremployee_value} ${a?.hr_date}): ${e.message}`);
      }
    }
  } catch (e) {
    summary.errors.push({ error: e.message });
    global.logger?.error?.(`[comp-off] month-end scan ${m}/${y} failed: ${e.message}`);
  }
  global.logger?.info?.(`[comp-off] Month-end Comp Off — ${m}/${y}: employees ${summary.employeesScanned}, days scanned ${summary.daysScanned}, full ${summary.fullCompOff}, half ${summary.halfCompOff}, duplicates ${summary.duplicatesSkipped}, invalid ${summary.invalidSkipped}, ineligible ${summary.ineligibleDays}, errors ${summary.errors.length}`);
  return summary;
}

/** Is this approved comp-off's credit already consumed (balance can't cover reversing it)? */
async function isCompOffUsed(employeeId, days, year) {
  try {
    const bal = await leaveEngine.getBalance(employeeId, year);
    return (bal?.compOff?.balance || 0) < num(days);
  } catch { return false; }   // can't confirm → allow (delete still only reverses a linked credit)
}

/**
 * DELETE a comp-off. This is an EMPLOYEE-only action on THEIR OWN record — HR/Admin
 * manage comp-off via Approve/Reject and can never delete (403). An employee may delete
 * only their own record (403 otherwise). Pending / rejected / cancelled / expired → just
 * remove (no live credit). Approved + ledger-credited → allowed ONLY while still UNUSED:
 * reverse the ledger credit first, then delete; a USED approved comp-off can NEVER be
 * deleted (409). Backend-authoritative — never relies on the UI hiding the button.
 */
async function remove(id, user) {
  const row = await getRaw(id);
  // ── Authorization (enforced here, not just in React) ──
  const role = String(user?.role || '');
  if (role === 'super_admin' || role === 'hr_manager') { const e = new Error('Delete is not available for HR/Admin. Use Approve or Reject.'); e.status = 403; throw e; }
  if (user?.id && String(row.hr_employeeid) !== String(user.id)) { const e = new Error('You can only delete your own Comp Off.'); e.status = 403; throw e; }
  const status = row.hr_status;
  const days = num(row.hr_days) || 1;
  const year = Number(row.hr_year) || Number(String(row.hr_workeddate || today()).slice(0, 4)) || new Date().getFullYear();
  if (status === 'approved' && row.hr_ledgerlinked === 'true') {
    if (await isCompOffUsed(row.hr_employeeid, days, year)) {
      const e = new Error('This Comp Off has already been used and cannot be deleted.'); e.status = 409; throw e;
    }
    await reverseEarned(row);   // negative comp_off_earned ledger entry → balance corrected
  }
  await d365.delete(COMP, id);
  notifyUser(row.hr_employeeid, 'compoff:deleted', { workedDate: row.hr_workeddate });
  audit({ category: 'Attendance', type: 'compoff_deleted', title: 'Comp Off deleted', name: row.hr_employeename, meta: { id, status, workedDate: row.hr_workeddate } });
  return { deleted: true, id };
}

module.exports = { list, getRaw, shape, create, approve, reject, cancel, expire, edit, remove, verifyEligibility, attendanceVerification, isCompOffUsed, sweepExpired, nextExpiry, maybeAutoCompOff, scanRange, scanMonthCompOff, compOffDaysForHours, fmtHours };
