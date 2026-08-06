/**
 * HR-managed Holiday Calendar. Holidays are stored in Dataverse (hr_holidays) and
 * merged into attendance.config so every attendance calculation (working days,
 * absent, weekly chart, export…) automatically excludes them — HR just adds a date.
 */
const d365 = require('./d365.service');
const attnCfg = require('./attendance.config');

const HOL = d365.constructor.entities.holiday;

let cache = null, cacheAt = 0;
const TTL = 5 * 60 * 1000;   // 5 min

/** All holidays, newest date first. Degrades to [] if the table isn't there yet. */
async function listHolidays() {
  try {
    // New columns (type/department/status/remarks) are optional — degrade if the
    // schema hasn't been extended yet.
    const { data } = await d365.getListOptional(HOL, {
      select: 'hr_holidayid,hr_name,hr_date,hr_description',
      optionalSelect: 'hr_type,hr_department,hr_status,hr_remarks',
      orderby: 'hr_date desc', top: 1000,
    });
    return (data || []).map(r => ({
      id: r.hr_holidayid, name: r.hr_name || 'Holiday', date: String(r.hr_date || '').slice(0, 10),
      description: r.hr_description || '', type: r.hr_type || '', department: r.hr_department || '',
      status: r.hr_status || 'active', remarks: r.hr_remarks || '',
    })).filter(h => h.date);
  } catch (_) { return []; }
}

/**
 * Refresh attendance.config's dynamic holiday set from the calendar (cached).
 * Only ACTIVE holidays are excluded from attendance/payroll/leave calculations.
 */
async function refresh(force = false) {
  const now = Date.now();
  if (!force && cache && now - cacheAt < TTL) return cache;
  const holidays = await listHolidays();
  cache = holidays; cacheAt = now;
  attnCfg.setDynamicHolidays(holidays.filter(h => h.status !== 'inactive').map(h => h.date));
  return holidays;
}

module.exports = { listHolidays, refresh, entity: HOL };
