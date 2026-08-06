/**
 * Consecutive Sick-Leave run — the number of consecutive WORKING days an employee
 * is on Sick Leave, looking across their leave history (not just one request).
 * Weekly-offs and company holidays are ignored when checking adjacency, so
 * Fri-SL + (Sat/Sun off) + Mon-SL counts as consecutive, while Mon-SL + Tue-Present
 * + Wed-SL does not.
 *
 * Drives the medical-certificate rule: a certificate is mandatory when the run is
 * >= the configured threshold of working days (default 2).
 */
const d365 = require('./d365.service');
const { toValue, toLabel } = require('./picklist');
let attnCfg; try { attnCfg = require('./attendance.config'); } catch (_) { attnCfg = null; }

const LEAVE = d365.constructor.entities.leave;

const ymd = (d) => d.toISOString().slice(0, 10);
const parse = (s) => new Date(`${String(s).slice(0, 10)}T00:00:00Z`);
const addDay = (s, n) => { const d = parse(s); d.setUTCDate(d.getUTCDate() + n); return ymd(d); };

function defaultIsWorkingDay(dateStr) {
  try {
    const dow = parse(dateStr).getUTCDay();
    const weeklyOff = attnCfg ? attnCfg.weekOffDays.includes(dow) : (dow === 0);
    const holiday = attnCfg ? attnCfg.holidays.includes(dateStr) : false;
    return !weeklyOff && !holiday;
  } catch { return true; }
}

/** Every working day in [from,to] inclusive. */
function workingDaysBetween(from, to, isWorkingDay) {
  const out = [];
  let d = String(from).slice(0, 10);
  const end = String(to).slice(0, 10);
  let guard = 0;
  while (d <= end && guard++ < 400) { if (isWorkingDay(d)) out.push(d); d = addDay(d, 1); }
  return out;
}

/**
 * Pure: length (in working days) of the consecutive Sick-Leave run that includes
 * the request [requestFrom, requestTo].
 * @param {{requestFrom:string, requestTo:string, slWorkingDates:Set<string>, isWorkingDay?:(d:string)=>boolean}} p
 */
function computeSickRunDays({ requestFrom, requestTo, slWorkingDates, isWorkingDay = defaultIsWorkingDay }) {
  const reqDays = workingDaysBetween(requestFrom, requestTo, isWorkingDay);
  if (reqDays.length === 0) return 0;
  const has = (d) => slWorkingDates.has(d);
  let left = reqDays[0];
  let right = reqDays[reqDays.length - 1];

  // Extend left across non-working gaps while previous working days are also SL.
  let cur = addDay(left, -1), guard = 0;
  while (guard++ < 400) {
    if (!isWorkingDay(cur)) { cur = addDay(cur, -1); continue; }   // skip weekly-off / holiday
    if (has(cur)) { left = cur; cur = addDay(cur, -1); continue; }
    break;                                                          // working day that is NOT SL → run ends
  }
  // Extend right similarly.
  cur = addDay(right, 1); guard = 0;
  while (guard++ < 400) {
    if (!isWorkingDay(cur)) { cur = addDay(cur, 1); continue; }
    if (has(cur)) { right = cur; cur = addDay(cur, 1); continue; }
    break;
  }

  // Count working SL days in [left, right].
  let count = 0, d = left, g = 0;
  while (d <= right && g++ < 800) { if (isWorkingDay(d) && has(d)) count++; d = addDay(d, 1); }
  return count;
}

/**
 * Async: run length for an employee's Sick-Leave request. Considers the employee's
 * pending + approved Sick Leaves in a ±40-day window plus the request itself.
 */
async function sickLeaveRunDays(employeeId, requestFrom, requestTo, { excludeLeaveId } = {}) {
  const from = String(requestFrom).slice(0, 10);
  const to = String(requestTo).slice(0, 10);
  const isWorkingDay = defaultIsWorkingDay;
  const slWorkingDates = new Set(workingDaysBetween(from, to, isWorkingDay));

  try {
    const sickCode = toValue('hr_leave_type', 'Sick Leave');
    const approved = toValue('hr_leave_status', 'approved');
    const pending = toValue('hr_leave_status', 'pending');
    const winStart = addDay(from, -40);
    const winEnd = addDay(to, 40);
    const { data } = await d365.getList(LEAVE, {
      select: 'hr_hrleaveid,hr_fromdate,hr_todate,hr_leavetype,hr_status',
      filter: `_hr_hremployee_value eq '${employeeId}' and hr_leavetype eq ${sickCode} and (hr_status eq ${approved} or hr_status eq ${pending})`,
      top: 500,
    });
    for (const l of data || []) {
      if (excludeLeaveId && l.hr_hrleaveid === excludeLeaveId) continue;
      const lf = String(l.hr_fromdate || '').slice(0, 10);
      const lt = String(l.hr_todate || '').slice(0, 10);
      if (!lf || !lt) continue;
      if (lt < winStart || lf > winEnd) continue;   // outside the window
      for (const d of workingDaysBetween(lf, lt, isWorkingDay)) slWorkingDates.add(d);
    }
  } catch (e) { global.logger?.warn?.(`[sick-run] history fetch skipped: ${e.message}`); }

  return computeSickRunDays({ requestFrom: from, requestTo: to, slWorkingDates, isWorkingDay });
}

module.exports = { computeSickRunDays, sickLeaveRunDays, workingDaysBetween, defaultIsWorkingDay };
