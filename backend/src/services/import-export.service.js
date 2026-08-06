/**
 * Import / Export Center.
 *
 * Import is a safe two-step flow: PREVIEW (parse + validate + duplicate-check, no
 * writes) → COMMIT (re-parse + re-validate server-side, then write only the good
 * rows). The pure validation core (validateRows) is unit-tested with no I/O; the
 * route supplies DB lookups (existing keys, employee index) and the per-row
 * writers reuse the existing services so no feature can break.
 */
const ExcelJS = require('exceljs');

// ── coercion / validators (pure) ──
const S = (v) => (v == null ? '' : String(v).trim());
const toDateStr = (v) => {
  if (v == null || v === '') return '';
  if (v instanceof Date && !isNaN(v)) return v.toISOString().slice(0, 10);
  const s = String(v).trim();
  const m = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/.exec(s) || /^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/.exec(s);
  if (!m) return s.slice(0, 10);
  if (m[1].length === 4) return `${m[1]}-${String(m[2]).padStart(2, '0')}-${String(m[3]).padStart(2, '0')}`;
  return `${m[3]}-${String(m[2]).padStart(2, '0')}-${String(m[1]).padStart(2, '0')}`;   // DD-MM-YYYY
};
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s);
const toNum = (v) => { const n = Number(String(v).replace(/[₹,\s]/g, '')); return Number.isFinite(n) ? n : NaN; };
const toBool = (v) => /^(y|yes|true|1)$/i.test(S(v));

// ── Type registry ──────────────────────────────────────────────────
// Each column: { key, header, required, kind, enum }. Optional per-type:
//   employeeKey  — a column whose value is an employee code to resolve to a GUID
//   dedupe(row)  — the natural key (for within-file + DB duplicate detection)
//   dupePolicy   — 'skip' | 'update' | 'allow'
const TYPES = {
  employees: {
    label: 'Employees',
    columns: [
      { key: 'employeeId', header: 'Employee ID', required: true },
      { key: 'name', header: 'Name', required: true },
      { key: 'email', header: 'Email' },
      { key: 'phone', header: 'Phone' },
      { key: 'department', header: 'Department' },
      { key: 'designation', header: 'Designation' },
      { key: 'joiningDate', header: 'Joining Date', kind: 'date' },
      { key: 'basic', header: 'Basic Salary', kind: 'number' },
    ],
    dedupe: (r) => S(r.employeeId).toLowerCase(),
    dupePolicy: 'update',
  },
  salarystructure: {
    label: 'Salary Structure', employeeKey: 'employeeCode',
    columns: [
      { key: 'employeeCode', header: 'Employee ID', required: true },
      { key: 'effectiveFrom', header: 'Effective From', required: true, kind: 'date' },
      { key: 'basic', header: 'Basic', required: true, kind: 'number' },
      { key: 'hra', header: 'HRA', kind: 'number' }, { key: 'special', header: 'Special', kind: 'number' },
      { key: 'medical', header: 'Medical', kind: 'number' }, { key: 'conveyance', header: 'Conveyance', kind: 'number' },
      { key: 'otherAllowance', header: 'Other Allowance', kind: 'number' },
      { key: 'pfApplicable', header: 'PF Applicable', kind: 'bool' }, { key: 'pfAmount', header: 'PF Amount', kind: 'number' },
      // Professional Tax is auto-calculated by slab — not imported.
      { key: 'incomeTax', header: 'Income Tax', kind: 'number' },
      { key: 'otherDeductions', header: 'Other Deductions', kind: 'number' },
    ],
    dedupe: (r) => `${S(r.employeeCode).toLowerCase()}|${toDateStr(r.effectiveFrom)}`,
    dupePolicy: 'skip',
  },
  attendance: {
    label: 'Attendance', employeeKey: 'employeeCode',
    columns: [
      { key: 'employeeCode', header: 'Employee ID', required: true },
      { key: 'date', header: 'Date', required: true, kind: 'date' },
      { key: 'inTime', header: 'In Time' }, { key: 'outTime', header: 'Out Time' },
      { key: 'status', header: 'Status', enum: ['present', 'absent', 'half_day', 'holiday', 'incomplete'] },
    ],
    dedupe: (r) => `${S(r.employeeCode).toLowerCase()}|${toDateStr(r.date)}`,
    dupePolicy: 'skip',
  },
  leavebalance: {
    label: 'Leave Balance', employeeKey: 'employeeCode',
    columns: [
      { key: 'employeeCode', header: 'Employee ID', required: true },
      { key: 'category', header: 'Category', required: true, enum: ['casual', 'sick', 'compoff'] },
      { key: 'days', header: 'Days', required: true, kind: 'number' },
      { key: 'reason', header: 'Reason' },
    ],
    dedupe: (r) => `${S(r.employeeCode).toLowerCase()}|${S(r.category)}|${S(r.days)}`,
    dupePolicy: 'allow',
  },
  compoff: {
    label: 'Comp Off', employeeKey: 'employeeCode',
    columns: [
      { key: 'employeeCode', header: 'Employee ID', required: true },
      { key: 'days', header: 'Days', required: true, kind: 'number' },
      { key: 'date', header: 'Date', kind: 'date' },
      { key: 'reason', header: 'Reason' },
    ],
    dedupe: (r) => `${S(r.employeeCode).toLowerCase()}|${toDateStr(r.date)}|${S(r.days)}`,
    dupePolicy: 'allow',
  },
  holidays: {
    label: 'Holiday Calendar',
    columns: [
      { key: 'date', header: 'Date', required: true, kind: 'date' },
      { key: 'name', header: 'Holiday Name', required: true },
      { key: 'description', header: 'Description' },
    ],
    dedupe: (r) => toDateStr(r.date),
    dupePolicy: 'skip',
  },
  payroll: {
    label: 'Payroll', employeeKey: 'employeeCode',
    columns: [
      { key: 'employeeCode', header: 'Employee ID', required: true },
      { key: 'month', header: 'Month', required: true, kind: 'number' },
      { key: 'year', header: 'Year', required: true, kind: 'number' },
      { key: 'basic', header: 'Basic', kind: 'number' }, { key: 'gross', header: 'Gross', kind: 'number' },
      { key: 'deductions', header: 'Deductions', kind: 'number' }, { key: 'net', header: 'Net Pay', kind: 'number' },
      { key: 'status', header: 'Status', enum: ['draft', 'processed', 'paid'] },
    ],
    dedupe: (r) => `${S(r.employeeCode).toLowerCase()}|${S(r.month)}|${S(r.year)}`,
    dupePolicy: 'skip',
  },
};

const isValidType = (t) => Object.prototype.hasOwnProperty.call(TYPES, t);
const typeMeta = (t) => TYPES[t];
const typeList = () => Object.entries(TYPES).map(([id, t]) => ({ id, label: t.label, columns: t.columns.map(c => ({ key: c.key, header: c.header, required: !!c.required, kind: c.kind || 'text', enum: c.enum })) }));

/** Parse the first worksheet: header row → keys, remaining rows → objects. */
async function parseWorkbook(buffer, type) {
  const t = typeMeta(type);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  const ws = wb.worksheets[0];
  if (!ws) return [];
  const headerRow = ws.getRow(1);
  const headerByCol = {};
  headerRow.eachCell((cell, col) => { headerByCol[col] = S(cell.value); });
  // Map each header to a known column key (case-insensitive).
  const keyByCol = {};
  for (const [col, header] of Object.entries(headerByCol)) {
    const c = t.columns.find(c => c.header.toLowerCase() === header.toLowerCase() || c.key.toLowerCase() === header.toLowerCase());
    if (c) keyByCol[col] = c.key;
  }
  const rows = [];
  for (let i = 2; i <= ws.rowCount; i++) {
    const row = ws.getRow(i);
    const obj = { __row: i };
    let any = false;
    row.eachCell({ includeEmpty: false }, (cell, col) => {
      const key = keyByCol[col];
      if (!key) return;
      let v = cell.value;
      if (v && typeof v === 'object' && 'text' in v) v = v.text;       // rich text / hyperlink
      if (v && typeof v === 'object' && 'result' in v) v = v.result;   // formula
      obj[key] = v;
      if (S(v) !== '') any = true;
    });
    if (any) rows.push(obj);
  }
  return rows;
}

/** Validate + normalise parsed rows (PURE). Flags field errors and IN-FILE duplicates. */
function validateRows(type, rows) {
  const t = typeMeta(type);
  const seen = new Map();
  const out = [];
  let valid = 0, errors = 0, duplicates = 0;

  for (const raw of rows || []) {
    const data = {};
    const rowErrors = [];
    for (const c of t.columns) {
      const rawVal = raw[c.key];
      const provided = rawVal != null && !(typeof rawVal === 'string' && rawVal.trim() === '') && rawVal !== '';
      let v;
      if (c.kind === 'date') v = toDateStr(rawVal);
      else if (c.kind === 'number') v = provided ? toNum(rawVal) : '';
      else if (c.kind === 'bool') v = provided ? toBool(rawVal) : '';
      else v = S(rawVal);

      if (c.required && !provided) rowErrors.push(`${c.header} is required`);
      else if (provided) {
        if (c.kind === 'number' && Number.isNaN(v)) rowErrors.push(`${c.header} must be a number`);
        if (c.kind === 'date' && !isDate(v)) rowErrors.push(`${c.header} must be a date (YYYY-MM-DD)`);
        if (c.enum && !c.enum.includes(String(v).toLowerCase())) rowErrors.push(`${c.header} must be one of: ${c.enum.join(', ')}`);
      }
      data[c.key] = v;
    }

    let status = rowErrors.length ? 'error' : 'valid';
    const key = t.dedupe ? t.dedupe(data) : null;
    if (status === 'valid' && key) {
      if (seen.has(key)) { status = 'duplicate'; rowErrors.push(`Duplicate of row ${seen.get(key)} in this file`); }
      else seen.set(key, raw.__row);
    }

    if (status === 'valid') valid++; else if (status === 'duplicate') duplicates++; else errors++;
    out.push({ row: raw.__row, data, key, status, errors: rowErrors });
  }
  return {
    columns: t.columns.map(c => ({ key: c.key, header: c.header, required: !!c.required })),
    rows: out,
    summary: { total: out.length, valid, errors, duplicates },
  };
}

/** Overlay existing-DB keys onto a validated preview (skip → duplicate, update → update). */
function applyExistingKeys(type, preview, existingKeys) {
  const t = typeMeta(type);
  if (!existingKeys || !existingKeys.size || t.dupePolicy === 'allow') return preview;
  let valid = 0, duplicates = 0, updates = 0;
  for (const r of preview.rows) {
    if (r.status === 'valid' && r.key && existingKeys.has(r.key)) {
      if (t.dupePolicy === 'update') { r.status = 'update'; r.errors.push('Existing record — will be updated'); }
      else { r.status = 'duplicate'; r.errors.push('Already exists — will be skipped'); }
    }
  }
  for (const r of preview.rows) { if (r.status === 'valid') valid++; else if (r.status === 'duplicate') duplicates++; else if (r.status === 'update') updates++; }
  preview.summary = { ...preview.summary, valid, duplicates, updates };
  return preview;
}

module.exports = {
  TYPES, isValidType, typeMeta, typeList, parseWorkbook, validateRows, applyExistingKeys,
  _helpers: { toDateStr, toNum, toBool, isDate, S },
};
