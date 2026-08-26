const express = require('express');
const router = express.Router();
const multer = require('multer');
const ExcelJS = require('exceljs');
const d365 = require('../../services/d365.service');
const { requireRole, requireAnyPermission } = require('../../middleware/auth.middleware');
const { toValue } = require('../../services/picklist');
const ie = require('../../services/import-export.service');
const salaryStructure = require('../../services/salary-structure.service');
const leaveEngine = require('../../services/leave-engine.service');
const leaveOpening = require('../../services/leave-opening.service');
const { computeSession } = require('../../services/attendance.util');
const attnCfg = require('../../services/attendance.config');
const { buildReport } = require('../../services/payroll-reports.service');
const activity = require('../../services/activity.service');

const E = d365.constructor.entities;
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });
const HR = ['super_admin', 'hr_manager'];
const today = () => new Date().toISOString().slice(0, 10);

// ── Employee code → GUID index (built once per request) ──
async function employeeIndex() {
  const { data } = await d365.getListOptional(E.employee, {
    select: 'hr_hremployeeid,hr_hremployee1', optionalSelect: 'hr_employeeid,hr_etimecode,hr_employeecode', top: 5000,
  });
  const byCode = new Map(), codeByGuid = new Map();
  for (const e of data || []) {
    const codes = [e.hr_employeeid, e.hr_etimecode, e.hr_employeecode].filter(Boolean).map(c => String(c).toLowerCase());
    for (const c of codes) if (!byCode.has(c)) byCode.set(c, { guid: e.hr_hremployeeid, name: e.hr_hremployee1 });
    const primary = String(e.hr_employeeid || e.hr_etimecode || e.hr_employeecode || '').toLowerCase();
    if (primary) codeByGuid.set(e.hr_hremployeeid, primary);
  }
  return { byCode, codeByGuid };
}

// Resolve the employeeKey column to a GUID; unknown employees become row errors.
function resolveEmployees(type, preview, empIndex) {
  const meta = ie.typeMeta(type);
  if (!meta.employeeKey) return;
  for (const r of preview.rows) {
    if (r.status === 'error') continue;
    const code = String(r.data[meta.employeeKey] || '').toLowerCase();
    const hit = empIndex.byCode.get(code);
    if (!hit) { r.status = 'error'; r.errors.push(`Unknown employee "${r.data[meta.employeeKey]}"`); }
    else { r._guid = hit.guid; r._empName = hit.name; }
  }
  preview.summary.valid = preview.rows.filter(r => r.status === 'valid').length;
  preview.summary.errors = preview.rows.filter(r => r.status === 'error').length;
}

// Existing natural keys already in Dataverse (for duplicate detection).
async function existingKeys(type, empIndex) {
  const keys = new Set();
  try {
    if (type === 'holidays') {
      const { data } = await d365.getList(E.holiday, { select: 'hr_date', top: 2000 });
      for (const h of data || []) keys.add(String(h.hr_date || '').slice(0, 10));
    } else if (type === 'employees') {
      const { data } = await d365.getListOptional(E.employee, { select: 'hr_hremployeeid', optionalSelect: 'hr_employeeid,hr_etimecode,hr_employeecode', top: 5000 });
      for (const e of data || []) for (const c of [e.hr_employeeid, e.hr_etimecode, e.hr_employeecode].filter(Boolean)) keys.add(String(c).toLowerCase());
    } else if (type === 'salarystructure') {
      const { data } = await d365.getListOptional(E.salaryStructure, { select: 'hr_employeeid,hr_effectivefrom', top: 5000 });
      for (const s of data || []) { const code = empIndex.codeByGuid.get(s.hr_employeeid); if (code) keys.add(`${code}|${String(s.hr_effectivefrom).slice(0, 10)}`); }
    } else if (type === 'payroll') {
      const { data } = await d365.getList(E.payroll, { select: 'hr_month,hr_year,_hr_hremployee_value', top: 5000 });
      for (const p of data || []) { const code = empIndex.codeByGuid.get(p._hr_hremployee_value); if (code) keys.add(`${code}|${p.hr_month}|${p.hr_year}`); }
    } else if (type === 'leaveopening') {
      // One opening balance per employee per year.
      try {
        const { data } = await d365.getList(E.leaveOpening, { select: 'hr_employeeid,hr_year', top: 5000 });
        for (const o of data || []) { const code = empIndex.codeByGuid.get(o.hr_employeeid); if (code) keys.add(`${code}|${o.hr_year}`); }
      } catch { /* table not provisioned yet → no existing keys */ }
    }
  } catch { /* best-effort */ }
  return keys;
}

// ── Per-row writers (reuse existing services; never assume — try/catch per row) ──
const WRITERS = {
  holidays: async (d) => { await d365.create(E.holiday, { hr_name: d.name, hr_date: d.date, hr_description: d.description || '' }); return 'created'; },
  compoff: async (d, r) => { await leaveEngine.addLedgerEntry({ employeeId: r._guid, employeeName: r._empName, year: Number((d.date || today()).slice(0, 4)), kind: 'comp_off_earned', category: 'compoff', days: Math.abs(Number(d.days)), effectiveDate: d.date || today(), reason: d.reason || 'Imported', createdBy: 'Import' }); return 'created'; },
  leavebalance: async (d, r) => { await leaveEngine.addLedgerEntry({ employeeId: r._guid, employeeName: r._empName, year: Number(today().slice(0, 4)), kind: 'adjustment', category: d.category, days: Number(d.days), effectiveDate: today(), reason: d.reason || 'Imported', createdBy: 'Import' }); return 'created'; },
  leaveopening: async (d, r) => {
    // One-time opening balance per employee/year. Reject a second one for the same year.
    await leaveOpening.upsert({
      employeeId: r._guid, employeeName: r._empName, year: Number(d.year),
      casualUsed: Number(d.casualUsed) || 0, sickUsed: Number(d.sickUsed) || 0, earnedUsed: Number(d.earnedUsed) || 0,
      lopUsed: Number(d.lopUsed) || 0, compOff: Number(d.compOff) || 0,
      remarks: d.remarks || 'Imported from Excel', updatedBy: 'Import', reason: 'Imported',
    }, { allowUpdate: false });
    return 'created';
  },
  salarystructure: async (d, r) => {
    const { ok, errors, value } = salaryStructure.validate({ ...d, employeeId: r._guid }, { requireEmployee: true });
    if (!ok) throw new Error(errors[0]);
    value.employeeName = r._empName; value.createdBy = 'Import';
    await d365.create(E.salaryStructure, { ...salaryStructure.toDataverse(value), hr_name: `${r._empName} · ${value.effectiveFrom}`.slice(0, 250) });
    return 'created';
  },
  attendance: async (d, r) => {
    const existing = await d365.getList(E.attendance, { select: 'hr_hrattendanceid', filter: `_hr_hremployee_value eq '${r._guid}' and hr_date eq '${d.date}'`, top: 1 });
    // Recompute hours/overtime/status from the in/out so historical imports are
    // consistent with live attendance (not just raw in/out strings).
    const times = [d.inTime, d.outTime].map(t => String(t || '').trim()).filter(Boolean);
    let body = { hr_date: d.date, hr_intime: d.inTime || '', hr_outtime: d.outTime || '' };
    if (times.length) {
      const c = computeSession(times, attnCfg.resolveShift(), { date: d.date });
      body = {
        hr_date: d.date, hr_intime: c.firstPunch || '', hr_outtime: c.state === 'out' ? c.lastPunch : '',
        hr_workedhours: c.totalSpanHours, hr_overtime: c.overtimeHours, hr_breakduration: c.breakHours,
        hr_effectivehours: c.effectiveHours, hr_punchcount: c.count,
        hr_allpunches: JSON.stringify(c.punches.map(p => p.t)), hr_status: toValue('hr_attendance_status', c.status),
      };
    }
    if (d.status) { try { body.hr_status = toValue('hr_attendance_status', String(d.status).toLowerCase()); } catch { /* leave computed */ } }
    if (existing.data?.[0]) { await d365.update(E.attendance, existing.data[0].hr_hrattendanceid, body); return 'updated'; }
    await d365.create(E.attendance, { 'hr_hremployee@odata.bind': `/hr_hremployees(${r._guid})`, ...body }); return 'created';
  },
  employees: async (d, r) => {
    const body = { hr_hremployee1: d.name, hr_email: d.email || '', hr_phone: d.phone || '', hr_department: d.department || '', hr_designation: d.designation || '', hr_joiningdate: d.joiningDate || '', hr_employeeid: d.employeeId };
    // Salary is NOT stored on the Employee record — it lives in the Salary Structure.
    // An employee import never writes pay (import a Salary Structure separately).
    if (r._existingGuid) { await d365.update(E.employee, r._existingGuid, body); return 'updated'; }
    await d365.create(E.employee, { ...body, hr_status: toValue('hr_employee_status', 'active') }); return 'created';
  },
  payroll: async (d, r) => {
    const existing = await d365.getList(E.payroll, { select: 'hr_hrpayrollid', filter: `_hr_hremployee_value eq '${r._guid}' and hr_month eq ${Number(d.month)} and hr_year eq ${Number(d.year)}`, top: 1 });
    const body = { hr_month: Number(d.month), hr_year: Number(d.year), hr_status: toValue('hr_payroll_status', d.status || 'draft') };
    if (d.basic !== '') body.hr_basic = Number(d.basic) || 0;
    if (d.gross !== '') body.hr_gross = Number(d.gross) || 0;
    if (d.deductions !== '') body.hr_deductions = Number(d.deductions) || 0;
    if (d.net !== '') body.hr_netpay = Number(d.net) || 0;
    if (existing.data?.[0]) { await d365.update(E.payroll, existing.data[0].hr_hrpayrollid, body); return 'updated'; }
    await d365.create(E.payroll, { 'hr_hremployee@odata.bind': `/hr_hremployees(${r._guid})`, ...body }); return 'created';
  },
};

// Build a validated preview (parse → validate → resolve employees → DB dupes).
async function buildPreview(type, buffer) {
  const rows = await ie.parseWorkbook(buffer, type);
  const preview = ie.validateRows(type, rows);
  const empIndex = await employeeIndex();
  resolveEmployees(type, preview, empIndex);
  const meta = ie.typeMeta(type);
  const keys = await existingKeys(type, empIndex);
  // For employees, remember the existing GUID so commit updates in place.
  if (type === 'employees') for (const r of preview.rows) { if (r.key && empIndex.byCode.get(r.key)) r._existingGuid = empIndex.byCode.get(r.key).guid; }
  ie.applyExistingKeys(type, preview, keys);
  return { preview, empIndex, meta };
}

// ── GET /types ── list importable types + their columns (for the UI) ──
router.get('/types', requireAnyPermission('reports.export'), (req, res) => res.json({ types: ie.typeList() }));

// ── GET /template/:type ── download a blank template with headers + a sample row ──
router.get('/template/:type', requireAnyPermission('reports.export'), async (req, res, next) => {
  try {
    if (!ie.isValidType(req.params.type)) return res.status(400).json({ error: 'Unknown import type' });
    const meta = ie.typeMeta(req.params.type);
    const wb = new ExcelJS.Workbook(); wb.creator = 'CRMONCE HRMS';
    const ws = wb.addWorksheet(meta.label);
    ws.columns = meta.columns.map(c => ({ header: c.header + (c.required ? ' *' : ''), key: c.key, width: Math.max(14, c.header.length + 4) }));
    ws.getRow(1).font = { bold: true }; ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEEF2FF' } };
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename=${req.params.type}_template.xlsx`);
    await wb.xlsx.write(res); res.end();
  } catch (err) { next(err); }
});

// ── POST /import/:type/preview ── parse + validate + duplicate report (no writes) ──
router.post('/import/:type/preview', requireAnyPermission('reports.export'), upload.single('file'), async (req, res, next) => {
  try {
    if (!ie.isValidType(req.params.type)) return res.status(400).json({ error: 'Unknown import type' });
    if (!req.file) return res.status(400).json({ error: 'Please attach an .xlsx file.' });
    const { preview, meta } = await buildPreview(req.params.type, req.file.buffer);
    res.json({ type: req.params.type, label: meta.label, dupePolicy: meta.dupePolicy, ...preview });
  } catch (err) {
    console.error('[import/preview] FAILED:', err.message);
    res.status(400).json({ error: err.message || 'Could not read the file. Ensure it is a valid .xlsx.' });
  }
});

// ── POST /import/:type/commit ── re-validate server-side, then write good rows ──
router.post('/import/:type/commit', requireAnyPermission('reports.export'), upload.single('file'), async (req, res, next) => {
  try {
    if (!ie.isValidType(req.params.type)) return res.status(400).json({ error: 'Unknown import type' });
    if (!req.file) return res.status(400).json({ error: 'Please attach an .xlsx file.' });
    const { preview } = await buildPreview(req.params.type, req.file.buffer);
    const writer = WRITERS[req.params.type];
    if (!writer) return res.status(400).json({ error: 'This type cannot be imported yet.' });

    let created = 0, updated = 0, skipped = 0, failed = 0; const errors = [];
    for (const r of preview.rows) {
      if (r.status === 'error' || r.status === 'duplicate') { skipped++; continue; }
      try { const action = await writer(r.data, r); if (action === 'updated') updated++; else created++; }
      catch (e) { failed++; errors.push({ row: r.row, message: e.message }); }
    }
    try { activity.record({ category: 'Data', type: 'import', title: `${ie.typeMeta(req.params.type).label} Imported`, name: req.user?.name, meta: `${req.user?.name || 'Admin'} imported ${created} created, ${updated} updated (${skipped} skipped, ${failed} failed)` }); } catch {}
    res.json({ type: req.params.type, created, updated, skipped, failed, errors });
  } catch (err) {
    console.error('[import/commit] FAILED:', err.message);
    res.status(400).json({ error: err.message || 'Import failed' });
  }
});

// ── GET /export/:type ── Excel export (reuses buildReport; adds leave + payslip-register) ──
const EXPORT_ALIAS = { attendance: 'attendance-register', payroll: 'payroll-register', 'salary-register': 'salary-register', 'bank-transfer': 'bank-transfer', leave: 'leave', 'payslip-register': 'payslip-register', 'employee-master': 'employee-master' };
router.get('/export/:type', requireAnyPermission('reports.export'), async (req, res, next) => {
  try {
    const reportType = EXPORT_ALIAS[req.params.type] || req.params.type;
    const wb = await buildReport(reportType, { year: Number(req.query.year) || undefined, month: Number(req.query.month) || undefined });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename=${req.params.type}_${req.query.year || 'all'}.xlsx`);
    await wb.xlsx.write(res); res.end();
  } catch (err) { res.status(err.status || 500).json({ error: err.message || 'Export failed' }); }
});

module.exports = router;
