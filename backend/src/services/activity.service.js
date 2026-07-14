/**
 * System activity feed — real events only (no hardcoded/placeholder data).
 *
 * Two sources, merged + sorted (newest first):
 *  1. DERIVED from D365 records via createdon/modifiedon (attendance web/manual,
 *     leave applied/approved/rejected/cancelled, new employees, payroll, documents).
 *  2. RUNTIME ring buffer for events not stored in D365 (eTime sync completed/
 *     failed, device connect/disconnect). record() is called where they happen.
 *
 * Individual biometric fingerprint punches are intentionally NOT surfaced
 * (hundreds/day) — only the aggregate sync result is.
 */
const d365 = require('./d365.service');
const { toLabel, toValue } = require('./picklist');
const E = d365.constructor.entities;

// ── runtime ring buffer ──────────────────────────────────────────────────────
const buf = [];
let seq = 0;
function record(a) {
  buf.unshift({ id: `rt-${++seq}`, category: 'System', ...a, time: a.time || new Date().toISOString() });
  if (buf.length > 200) buf.length = 200;
}
function runtime() { return buf.slice(); }

const nameOf = (r) => r['_hr_hremployee_value@OData.Community.Display.V1.FormattedValue'] || 'Employee';
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "HH:MM" or ISO datetime → "3:44 PM" (unambiguous 12-hour). */
function fmtTime(v) {
  if (!v) return '';
  const s = String(v);
  let hh, mm;
  if (s.includes('T')) { const d = new Date(s); if (!isNaN(d)) { hh = d.getHours(); mm = d.getMinutes(); } }
  if (hh === undefined) { const m = s.match(/(\d{1,2}):(\d{2})/); if (m) { hh = +m[1]; mm = +m[2]; } }
  if (hh === undefined) return s;
  const ap = hh >= 12 ? 'PM' : 'AM';
  const h12 = hh % 12 === 0 ? 12 : hh % 12;
  return `${h12}:${String(mm).padStart(2, '0')} ${ap}`;
}

/** "2026-07-08" → "08 Jul 2026". */
function fmtDate(v) {
  const s = String(v || '').slice(0, 10);
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return s;
  return `${m[3]} ${MONTHS[(+m[2]) - 1] || ''} ${m[1]}`;
}

async function fromAttendance() {
  try {
    const web = toValue('hr_attendance_source', 'web_checkin');
    const man = toValue('hr_attendance_source', 'manual_correction');
    const { data } = await d365.getList(E.attendance, {
      select: 'hr_hrattendanceid,hr_source,hr_intime,hr_outtime,hr_date,_hr_hremployee_value,createdon,modifiedon',
      filter: `hr_source eq ${web} or hr_source eq ${man}`,
      orderby: 'modifiedon desc', top: 12,
    });
    return (data || []).map(r => {
      let type, title, meta;
      if (r.hr_source === man) { type = 'attendance_correction'; title = 'Manual Attendance Correction'; meta = `edited ${fmtDate(r.hr_date)}`; }
      else if (r.hr_outtime) { type = 'web_checkout'; title = 'Web Check Out'; meta = `checked out ${fmtTime(r.hr_outtime)}`; }
      else { type = 'web_checkin'; title = 'Web Check In'; meta = `checked in ${fmtTime(r.hr_intime)}`; }
      return { id: 'att-' + r.hr_hrattendanceid, category: 'Attendance', type, title, name: nameOf(r), meta, time: r.modifiedon || r.createdon };
    });
  } catch (_) { return []; }
}

async function fromLeaves() {
  try {
    const { data } = await d365.getList(E.leave, {
      select: 'hr_hrleaveid,hr_status,hr_leavetype,_hr_hremployee_value,createdon,modifiedon',
      orderby: 'modifiedon desc', top: 12,
    });
    const map = { pending: 'Leave Applied', approved: 'Leave Approved', rejected: 'Leave Rejected', cancelled: 'Leave Cancelled' };
    return (data || []).map(r => {
      const st = toLabel('hr_leave_status', r.hr_status);
      return { id: 'lv-' + r.hr_hrleaveid, category: 'Leave', type: 'leave_' + st, title: map[st] || 'Leave Updated',
        name: nameOf(r), meta: toLabel('hr_leave_type', r.hr_leavetype), time: r.modifiedon || r.createdon };
    });
  } catch (_) { return []; }
}

async function fromEmployees() {
  try {
    const { data } = await d365.getList(E.employee, {
      select: 'hr_hremployeeid,hr_hremployee1,createdon', orderby: 'createdon desc', top: 6,
    });
    return (data || []).map(r => ({ id: 'emp-' + r.hr_hremployeeid, category: 'Employee', type: 'employee_added',
      title: 'New Employee Added', name: r.hr_hremployee1 || 'Employee', meta: '', time: r.createdon }));
  } catch (_) { return []; }
}

async function fromPayroll() {
  try {
    const { data } = await d365.getList(E.payroll, {
      select: 'hr_hrpayrollid,hr_month,hr_year,_hr_hremployee_value,createdon', orderby: 'createdon desc', top: 6,
    });
    return (data || []).map(r => ({ id: 'pay-' + r.hr_hrpayrollid, category: 'Payroll', type: 'payroll_generated',
      title: 'Payroll Generated', name: nameOf(r), meta: `${MONTHS[(r.hr_month || 1) - 1] || ''} ${r.hr_year || ''}`.trim(), time: r.createdon }));
  } catch (_) { return []; }
}

async function fromDocuments() {
  try {
    const { data } = await d365.getList(E.document, {
      select: 'hr_hrdocumentid,hr_name,_hr_hremployee_value,createdon', orderby: 'createdon desc', top: 6,
    });
    return (data || []).map(r => ({ id: 'doc-' + r.hr_hrdocumentid, category: 'Documents', type: 'document_uploaded',
      title: 'Document Uploaded', name: nameOf(r), meta: r.hr_name || '', time: r.createdon }));
  } catch (_) { return []; }
}

let cache = null, cacheAt = 0;
async function recent(limit = 20) {
  const now = Date.now();
  if (cache && now - cacheAt < 15000) return cache.slice(0, limit);   // short TTL (30s polling)
  const parts = await Promise.all([fromAttendance(), fromLeaves(), fromEmployees(), fromPayroll(), fromDocuments()]);
  const all = [...runtime(), ...parts.flat()]
    .filter(a => a.time)
    .sort((a, b) => new Date(b.time) - new Date(a.time));
  cache = all; cacheAt = now;
  return all.slice(0, limit);
}

module.exports = { record, runtime, recent };
