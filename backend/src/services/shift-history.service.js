/**
 * Shift History — the SOURCE OF TRUTH for "which shift was effective for an employee
 * on a given attendance date". Every attendance calculation (Late Login, Early Out,
 * off/working-day, expected hours) must resolve the shift by (employee + attendanceDate)
 * so a later shift change never rewrites how a past day is judged.
 *
 * Storage: hr_shifthistories — one row per assignment, keyed by hr_effectivefrom
 * (mirrors the effective-dated Salary Structure). The row with the latest
 * hr_effectivefrom ≤ the attendance date wins (exactly the salary-structure query).
 *
 * BACKWARD COMPATIBLE: an employee with NO history rows falls back to their current
 * shift fields (hr_shiftname/hr_shiftstarttime/hr_shiftendtime) — identical to today's
 * behaviour. History becomes authoritative only once a change is recorded; the FIRST
 * change seeds the prior (current) shift as a closed row from the employee's joining
 * date, so past days keep resolving to the shift they were actually worked under.
 */
const d365 = require('./d365.service');
const cfg = require('./attendance.config');

const SH = d365.constructor.entities.shiftHistory;
const EMP = d365.constructor.entities.employee;

const DEFAULT_GRACE = 5;                                   // matches attendance.util LATE_ENTRY_GRACE_MIN
const SHIFT_COLS = 'hr_shiftname,hr_shiftstarttime,hr_shiftendtime';
const SELECT = 'hr_shifthistoryid,hr_employeeid,hr_employeename,hr_shiftname,hr_shiftstarttime,hr_shiftendtime,hr_gracemins,hr_effectivefrom,hr_effectiveto,hr_status,hr_changedby,hr_changedon,hr_reason,createdon';

const num = (v, d = 0) => { const n = Number(v); return Number.isFinite(n) ? n : d; };
const q = (v) => `'${String(v).replace(/'/g, "''")}'`;
const today = () => new Date().toISOString().slice(0, 10);
const addDays = (dateStr, days) => { const d = new Date(`${String(dateStr).slice(0, 10)}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + Number(days)); return d.toISOString().slice(0, 10); };
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));

const shape = (r) => ({
  id: r.hr_shifthistoryid,
  employeeId: r.hr_employeeid,
  employeeName: r.hr_employeename || '',
  shiftName: r.hr_shiftname || '',
  shiftStart: r.hr_shiftstarttime || '',
  shiftEnd: r.hr_shiftendtime || '',
  graceMins: num(r.hr_gracemins, DEFAULT_GRACE),
  effectiveFrom: r.hr_effectivefrom || '',
  effectiveTo: r.hr_effectiveto || '',
  status: r.hr_status || '',
  changedBy: r.hr_changedby || '',
  changedOn: r.hr_changedon || '',
  reason: r.hr_reason || '',
  createdOn: r.createdon || null,
});

// A resolved shift object = whatever resolveEmployeeShift returns + a grace value.
function shiftFromFields(shiftName, shiftStart, shiftEnd, graceMins) {
  return { ...cfg.resolveEmployeeShift(shiftName, shiftStart, shiftEnd), grace: num(graceMins, DEFAULT_GRACE) };
}
const shiftFromRow = (row) => shiftFromFields(row.hr_shiftname || row.shiftName, row.hr_shiftstarttime || row.shiftStart, row.hr_shiftendtime || row.shiftEnd, row.hr_gracemins != null ? row.hr_gracemins : row.graceMins);
const shiftFromEmployee = (emp) => shiftFromFields(emp?.hr_shiftname, emp?.hr_shiftstarttime, emp?.hr_shiftendtime, DEFAULT_GRACE);

/** All history rows for an employee, newest effective-from first. [] on any error / no table. */
async function loadHistory(employeeId) {
  if (!employeeId) return [];
  try {
    const { data } = await d365.getListOptional(SH, {
      select: SELECT, filter: `hr_employeeid eq ${q(employeeId)}`,
      orderby: 'hr_effectivefrom desc,createdon desc', top: 500,
    });
    return data || [];
  } catch { return []; }
}

/** From pre-loaded rows (desc), the one effective on dateStr (latest effectivefrom ≤ date), else null. */
function pickRowForDate(rows, dateStr) {
  const d = String(dateStr || '').slice(0, 10);
  if (!d || !Array.isArray(rows)) return null;
  for (const r of rows) {                                  // rows are desc by effectivefrom
    if (r.hr_effectivefrom && r.hr_effectivefrom <= d) return r;
  }
  return null;
}

/**
 * THE resolver. Returns the shift object (start/end/durationHours/isNight/grace) that
 * was EFFECTIVE for `employeeId` on `dateStr`. Uses shift history when present; otherwise
 * falls back to the employee's current shift fields (`employeeRecord` avoids a refetch).
 */
async function resolveShiftForDate(employeeId, dateStr, employeeRecord) {
  const rows = await loadHistory(employeeId);
  const row = pickRowForDate(rows, dateStr);
  if (row) return shiftFromRow(row);
  const emp = employeeRecord || (employeeId ? await d365.getById(EMP, employeeId, { select: SHIFT_COLS }).catch(() => null) : null);
  return shiftFromEmployee(emp);
}

/**
 * Batch helper for loops that resolve MANY dates for ONE employee (dashboards, monthly
 * summaries, range reports): load the history once, then resolve each date in memory.
 * Returns { forDate(dateStr) → shift, rows }.
 */
async function shiftResolverFor(employeeId, employeeRecord) {
  const rows = await loadHistory(employeeId);
  const empShift = () => shiftFromEmployee(employeeRecord);
  return {
    rows,
    forDate: (dateStr) => { const r = pickRowForDate(rows, dateStr); return r ? shiftFromRow(r) : empShift(); },
  };
}

/**
 * ONE query that loads ALL shift-history rows (only employees who ever changed shift
 * have any), grouped by employee → Map(employeeId → rows desc). For whole-org sweeps
 * (Late-Login sweep, nightly scan, dashboards) this replaces N per-employee lookups.
 * Employees absent from the map simply have no history → callers fall back to current.
 */
async function loadHistoryMap(filter) {
  try {
    const { data } = await d365.getListOptional(SH, {
      select: SELECT, filter: filter || undefined, orderby: 'hr_effectivefrom desc,createdon desc', top: 5000,
    });
    const map = new Map();
    for (const r of data || []) {                          // global desc → each sublist is desc too
      if (!map.has(r.hr_employeeid)) map.set(r.hr_employeeid, []);
      map.get(r.hr_employeeid).push(r);
    }
    return map;
  } catch { return new Map(); }
}

/** Resolve the shift effective on a date from a pre-loaded history map (falls back to current). */
function shiftForDateFromMap(map, employeeId, dateStr, employeeRecord) {
  const row = pickRowForDate((map && map.get(employeeId)) || [], dateStr);
  return row ? shiftFromRow(row) : shiftFromEmployee(employeeRecord);
}

// ── management: list / change ────────────────────────────────────────────────
async function list(employeeId) {
  const rows = await loadHistory(employeeId);
  return rows.map(shape);
}

async function createRow({ employeeId, employeeName, shiftName, shiftStart, shiftEnd, graceMins, effectiveFrom, effectiveTo = '', status = 'active', changedBy = 'HR', reason = '' }) {
  const body = {
    hr_name: `${employeeName || employeeId} · ${shiftName || 'Shift'} · ${effectiveFrom}`.slice(0, 250),
    hr_employeeid: String(employeeId), hr_employeename: employeeName || '',
    hr_shiftname: shiftName || '', hr_shiftstarttime: shiftStart || '', hr_shiftendtime: shiftEnd || '',
    hr_gracemins: String(num(graceMins, DEFAULT_GRACE)),
    hr_effectivefrom: effectiveFrom, hr_effectiveto: effectiveTo || '', hr_status: status,
    hr_changedby: changedBy || '', hr_changedon: new Date().toISOString(), hr_reason: reason || '',
  };
  const created = await d365.create(SH, body);
  return { ...body, hr_shifthistoryid: created.hr_shifthistoryid };
}

/**
 * Record an employee's shift change WITHOUT overwriting history.
 *  - Same effective date as the current open row → in-place correction (test #13).
 *  - Backdating on/before an existing effective date → 409 (overlap; test #14).
 *  - First ever change → seed the prior/current shift as a closed row from joiningDate
 *    (so past days resolve to the old shift), then append the new open row.
 *  - Subsequent changes → close the open row (effectiveTo = newFrom−1), append the new row.
 * `oldShift` = the employee's CURRENT fields BEFORE this change (for the seed).
 */
async function changeShift({ employeeId, employeeName, shiftName, shiftStart, shiftEnd, graceMins = DEFAULT_GRACE, effectiveFrom, reason = '', changedBy = 'HR', joiningDate, oldShift }) {
  if (!employeeId) { const e = new Error('employeeId is required.'); e.status = 400; throw e; }
  const from = isDate(effectiveFrom) ? String(effectiveFrom).slice(0, 10) : today();
  const start = cfg.normalizeTime(shiftStart);
  if (!start) { const e = new Error('A valid shift start time is required.'); e.status = 400; throw e; }
  const end = cfg.normalizeTime(shiftEnd) || '';

  const rows = await loadHistory(employeeId);
  const openRow = rows.find((r) => !r.hr_effectiveto);      // the current, open-ended assignment
  const latestFrom = rows.length ? rows[0].hr_effectivefrom : null;

  // Same-day correction — replace the open row's shift in place, do not stack a new row.
  if (openRow && openRow.hr_effectivefrom === from) {
    await d365.update(SH, openRow.hr_shifthistoryid, {
      hr_shiftname: shiftName || '', hr_shiftstarttime: start, hr_shiftendtime: end,
      hr_gracemins: String(num(graceMins, DEFAULT_GRACE)), hr_changedby: changedBy, hr_changedon: new Date().toISOString(), hr_reason: reason || '',
    });
    return shape((await d365.getById(SH, openRow.hr_shifthistoryid, { select: SELECT })));
  }

  // Overlap guard — a new assignment must start strictly AFTER the latest one.
  if (latestFrom && from <= latestFrom) {
    const e = new Error(`Effective From (${from}) must be after the current assignment's effective date (${latestFrom}). Overlapping shift assignments are not allowed.`);
    e.status = 409; throw e;
  }

  if (rows.length === 0) {
    // First change ever → seed the prior (current) shift as a closed row so PAST dates
    // resolve to it. Seed from the joining date (per configuration) up to the day before
    // the new assignment. Only seed if we actually know the old shift's start.
    const os = oldShift || {};
    const oldStart = cfg.normalizeTime(os.shiftStart || os.start);
    if (oldStart) {
      const seedFrom = isDate(joiningDate) ? String(joiningDate).slice(0, 10) : '2000-01-01';
      await createRow({
        employeeId, employeeName, shiftName: os.shiftName || os.name || '', shiftStart: oldStart, shiftEnd: cfg.normalizeTime(os.shiftEnd || os.end) || '',
        graceMins: DEFAULT_GRACE, effectiveFrom: seedFrom <= from ? seedFrom : from, effectiveTo: addDays(from, -1),
        status: 'superseded', changedBy: 'System (migration)', reason: 'Initial shift assignment (seeded from the employee current shift).',
      });
    }
  } else if (openRow) {
    // Close the current open assignment at the day before the new one.
    await d365.update(SH, openRow.hr_shifthistoryid, { hr_effectiveto: addDays(from, -1), hr_status: 'superseded' });
  }

  const rec = await createRow({
    employeeId, employeeName, shiftName, shiftStart: start, shiftEnd: end, graceMins,
    effectiveFrom: from, effectiveTo: '', status: 'active', changedBy, reason,
  });
  return shape(rec);
}

/** Explicit initial seed (e.g. on employee create) — one open row from `effectiveFrom`. */
async function seedInitial({ employeeId, employeeName, shiftName, shiftStart, shiftEnd, effectiveFrom, changedBy = 'System' }) {
  if (!employeeId || !cfg.normalizeTime(shiftStart)) return null;
  const rows = await loadHistory(employeeId);
  if (rows.length) return null;                            // already has history — never double-seed
  const rec = await createRow({
    employeeId, employeeName, shiftName, shiftStart: cfg.normalizeTime(shiftStart), shiftEnd: cfg.normalizeTime(shiftEnd) || '',
    graceMins: DEFAULT_GRACE, effectiveFrom: isDate(effectiveFrom) ? effectiveFrom : today(), effectiveTo: '', status: 'active',
    changedBy, reason: 'Initial shift assignment.',
  });
  return shape(rec);
}

module.exports = {
  // resolvers (used by attendance calculations)
  resolveShiftForDate, shiftResolverFor, loadHistoryMap, shiftForDateFromMap, loadHistory, pickRowForDate, shiftFromRow, shiftFromEmployee, shiftFromFields,
  // management
  list, changeShift, seedInitial, shape,
  DEFAULT_GRACE,
};
