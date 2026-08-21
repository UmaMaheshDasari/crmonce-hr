/**
 * eTime punch INGESTION — the shared, idempotent core that turns raw ZK/eTime punches
 * (pushed by the Office Sync Agent over HTTPS) into Dataverse attendance records.
 *
 * Architecture: Office ZK device → Office Sync Agent (office LAN) → HTTPS → this backend
 * → Dataverse. The VPS never connects to the office LAN device (that path is impossible
 * across NAT — it was the original failure).
 *
 * A punch is `{ etimeCode, date:'YYYY-MM-DD', time:'HH:MM' }` where date/time are the
 * device's LOCAL wall-clock (IST) — already civil values, so NO timezone conversion is
 * applied here (a 00:30 IST punch stays on the same date; never shifted to the prev UTC
 * day). Employee mapping is via the existing hr_etimecode field → hr_hremployeeid GUID
 * (never the GUID as the device id). Idempotent: re-sending the same punch is a no-op.
 */
const d365 = require('./d365.service');
const { toValue } = require('./picklist');
const { computeSession } = require('./attendance.util');
const attnCfg = require('./attendance.config');

const EMP = d365.constructor.entities.employee;
const ATT = d365.constructor.entities.attendance;

const esc = (v) => String(v ?? '').replace(/'/g, "''");
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;              // YYYY-MM-DD
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;        // HH:MM 24-hour

/** Validate one incoming punch. @returns {{ok:boolean, reason?:string}} */
function validatePunch(p) {
  if (!p || typeof p !== 'object') return { ok: false, reason: 'not an object' };
  if (p.etimeCode === undefined || p.etimeCode === null || String(p.etimeCode).trim() === '') return { ok: false, reason: 'missing etimeCode' };
  if (!DATE_RE.test(String(p.date || ''))) return { ok: false, reason: 'invalid date (want YYYY-MM-DD)' };
  if (!TIME_RE.test(String(p.time || ''))) return { ok: false, reason: 'invalid time (want HH:MM 24h)' };
  return { ok: true };
}

/**
 * Merge a punch time into the day's existing punches (idempotent).
 * @returns {{punches:string[], added:boolean}} — added=false when the time is already present.
 */
function mergePunch(existing, time) {
  let punches = Array.isArray(existing) ? existing.slice() : [];
  punches = punches.map((x) => (x && typeof x === 'object' ? (x.t || x.time) : x)).filter(Boolean);
  if (punches.includes(time)) return { punches, added: false };   // same punch already stored → no-op
  punches.push(time);
  punches.sort();                                                  // chronological (HH:MM sorts lexically)
  return { punches, added: true };
}

/** Map a device (eTime) code → employee (+ shift). NEVER treats the GUID as the code. */
async function resolveByEtimeCode(code) {
  try {
    const { data } = await d365.getListOptional(EMP, {
      filter: `hr_etimecode eq '${esc(code)}'`,
      select: 'hr_hremployeeid,hr_hremployee1,hr_etimecode',
      optionalSelect: 'hr_shiftname,hr_shiftstarttime,hr_shiftendtime',
    });
    return (data && data[0]) || null;
  } catch { return null; }
}

/** computeSession result → the attendance write payload (same shape web check-in uses). */
function payloadFromSession(c) {
  return {
    hr_intime: c.firstPunch || '',
    hr_outtime: c.state === 'out' ? c.lastPunch : '',
    hr_workedhours: c.totalSpanHours,
    hr_overtime: c.overtimeHours,
    hr_breakduration: c.breakHours,
    hr_effectivehours: c.effectiveHours,
    hr_punchcount: c.count,
    hr_allpunches: JSON.stringify(c.punches.map((p) => p.t)),
    hr_status: toValue('hr_attendance_status', c.status),
  };
}

/**
 * Ingest a batch of punches idempotently.
 * @returns {Promise<{received,created,updated,duplicates,unmapped,failed,lastPunch,errors}>}
 */
async function ingestPunches(punches, { deviceId } = {}) {
  const stats = { received: Array.isArray(punches) ? punches.length : 0, created: 0, updated: 0, duplicates: 0, unmapped: 0, failed: 0, lastPunch: null, errors: [] };
  if (!Array.isArray(punches)) { stats.received = 0; return stats; }

  const empCache = new Map();   // etimeCode → employee|null (per-batch cache)
  const shiftCache = new Map(); // etimeCode → date-aware shift resolver (per-batch cache)
  for (const p of punches) {
    const v = validatePunch(p);
    if (!v.ok) { stats.failed++; stats.errors.push({ etimeCode: p?.etimeCode ?? null, reason: v.reason }); continue; }
    const code = String(p.etimeCode).trim();
    try {
      if (!empCache.has(code)) empCache.set(code, await resolveByEtimeCode(code));
      const emp = empCache.get(code);
      if (!emp) { stats.unmapped++; continue; }   // unknown device user — not an error, just unmapped

      // Resolve the shift EFFECTIVE on the PUNCH date (history-aware) — a backfilled /
      // late-synced punch for a prior date must never use the employee's current shift.
      if (!shiftCache.has(code)) shiftCache.set(code, await require('./shift-history.service').shiftResolverFor(emp.hr_hremployeeid, emp));
      const shift = shiftCache.get(code).forDate(String(p.date).slice(0, 10));
      const { data: existing } = await d365.getList(ATT, {
        filter: `_hr_hremployee_value eq '${emp.hr_hremployeeid}' and hr_date eq ${p.date}`,
        select: 'hr_hrattendanceid,hr_allpunches',
      });

      if (existing && existing[0]) {
        let cur = [];
        try { cur = JSON.parse(existing[0].hr_allpunches || '[]'); } catch { cur = []; }
        const { punches: merged, added } = mergePunch(cur, p.time);
        if (!added) { stats.duplicates++; continue; }     // IDEMPOTENT: same punch synced twice → one record
        const c = computeSession(merged, shift, { graceMinutes: shift.grace });
        await d365.update(ATT, existing[0].hr_hrattendanceid, payloadFromSession(c));
        stats.updated++;
      } else {
        const c = computeSession([p.time], shift, { graceMinutes: shift.grace });
        await d365.create(ATT, {
          'hr_hremployee@odata.bind': `/hr_hremployees(${emp.hr_hremployeeid})`,
          hr_date: p.date,
          hr_deviceid: deviceId || 'etime-agent',
          hr_source: toValue('hr_attendance_source', 'etime_device'),
          ...payloadFromSession(c),
        });
        stats.created++;
        // Best-effort auto comp-off (holiday/weekly-off worked). Never blocks ingestion.
        try {
          require('./comp-off.service').maybeAutoCompOff({
            employeeId: emp.hr_hremployeeid, employeeName: emp.hr_hremployee1,
            date: p.date, statusLabel: c.status, workedHours: c.effectiveHours,
          });
        } catch (_) {}
      }
      stats.lastPunch = { etimeCode: code, date: p.date, time: p.time };
    } catch (err) {
      stats.failed++;
      stats.errors.push({ etimeCode: code, reason: 'ingest failed' });   // never leak internal/Dataverse detail to the client
      global.logger?.error?.(`[etime-ingest] ${code} ${p.date} ${p.time}: ${err.message}`);
    }
  }
  return stats;
}

module.exports = { ingestPunches, validatePunch, mergePunch, resolveByEtimeCode, payloadFromSession };
