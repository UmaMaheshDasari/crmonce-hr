const express = require('express');
const perfRouter = express.Router();
const docRouter = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');

// Content-Type by extension — used to serve/label EVERY file type correctly
// (never hardcoded to application/pdf). The stored mime type wins; this is the
// fallback for older records or a missing/generic browser mime.
const MIME_BY_EXT = {
  '.pdf': 'application/pdf',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp', '.svg': 'image/svg+xml', '.tiff': 'image/tiff',
  '.txt': 'text/plain', '.csv': 'text/csv', '.html': 'text/html', '.htm': 'text/html', '.json': 'application/json', '.xml': 'application/xml', '.md': 'text/markdown',
  '.doc': 'application/msword', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint', '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.odt': 'application/vnd.oasis.opendocument.text', '.ods': 'application/vnd.oasis.opendocument.spreadsheet', '.odp': 'application/vnd.oasis.opendocument.presentation',
  '.zip': 'application/zip', '.rar': 'application/vnd.rar', '.7z': 'application/x-7z-compressed', '.gz': 'application/gzip',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4',
};
const mimeFromName = (name) => MIME_BY_EXT[path.extname(name || '').toLowerCase()] || 'application/octet-stream';
// Executable / script types are refused for safety; every other document type is
// accepted (the earlier .pdf/.doc/.docx/.jpg-only filter was blocking most types).
const BLOCKED_EXT = new Set(['.exe', '.msi', '.dll', '.scr', '.com', '.bat', '.cmd', '.sh', '.php', '.php5', '.phtml', '.cgi', '.pl', '.py', '.rb', '.js', '.jar', '.vbs', '.ps1']);
const d365 = require('../../services/d365.service');
const { requireRole, requirePermission, requireAnyPermission } = require('../../middleware/auth.middleware');
const { toValue, labelsForList, labelsForEntity } = require('../../services/picklist');
let activity; try { activity = require('../../services/activity.service'); } catch (_) { activity = null; }
const audit = (payload) => { try { activity?.record?.(payload); } catch (_) {} };

// ── PERFORMANCE ───────────────────────────────────────────────────
perfRouter.get('/', requireAnyPermission('performance.view'), async (req, res, next) => {
  try {
    const { employeeId, cycle } = req.query;
    const targetId = req.user.role === 'employee' ? req.user.id : employeeId;
    const filters = [];
    if (targetId) filters.push(`_hr_hremployee_value eq '${targetId}'`);
    if (cycle) filters.push(`hr_cycle eq '${cycle}'`);
    const result = await d365.getList(d365.constructor.entities.performance, {
      // Include the employee lookup so the review card can show the employee NAME
      // (labelsForList adds its OData formatted value). Additive — no contract break.
      select: 'hr_hrperformanceid,hr_cycle,hr_rating,hr_kpis,hr_goals,hr_reviewernotes,hr_status,_hr_hremployee_value',
      filter: filters.join(' and ') || undefined,
      orderby: 'createdon desc',
    });
    res.json(labelsForList('hr_hrperformances', result));
  } catch (err) { next(err); }
});

perfRouter.post('/', requireAnyPermission('performance.create'), async (req, res, next) => {
  try {
    // Bind the review to the SELECTED employee (employeeId from the form) so the review
    // is attributed to the person being reviewed — not the creator. `employeeId` is a
    // control field, never a Dataverse column, so it is stripped from the body. Falls
    // back to the creator only when none is provided (backward compatible).
    const { employeeId, ...body } = req.body || {};
    const target = employeeId || req.user.id;
    const perf = await d365.create(d365.constructor.entities.performance, {
      ...body,
      'hr_hremployee@odata.bind': `/hr_hremployees(${target})`,
      hr_status: toValue('hr_performance_status', 'draft'),
    });
    res.status(201).json(labelsForEntity('hr_hrperformances', perf));
  } catch (err) { next(err); }
});

perfRouter.patch('/:id', requireAnyPermission('performance.edit'), async (req, res, next) => {
  try {
    const body = { ...req.body };
    if (body.hr_status) body.hr_status = toValue('hr_performance_status', body.hr_status);
    const perf = await d365.update(d365.constructor.entities.performance, req.params.id, body);
    res.json(labelsForEntity('hr_hrperformances', perf));
  } catch (err) { next(err); }
});

// DELETE a performance review — HR / Super Admin only (same authority as create).
perfRouter.delete('/:id', requireAnyPermission('performance.delete'), async (req, res, next) => {
  try {
    await d365.delete(d365.constructor.entities.performance, req.params.id);
    res.json({ deleted: true, id: req.params.id });
  } catch (err) { next(err); }
});

// ── DOCUMENTS ─────────────────────────────────────────────────────
// Multer writes to disk here. A CUSTOM UPLOAD_DIR is not created anywhere else
// (server.js only ensures the default ./uploads), so on a fresh/custom path the
// disk write fails → 500 "upload failed". Ensure the directory exists up front.
const UPLOAD_DIR = process.env.UPLOAD_DIR || './uploads';
try { fs.mkdirSync(UPLOAD_DIR, { recursive: true }); }
catch (e) { (global.logger || console).warn?.(`[documents] could not ensure upload dir ${UPLOAD_DIR}: ${e.message}`); }
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    // Re-ensure per request too, in case the dir was removed at runtime.
    try { fs.mkdirSync(UPLOAD_DIR, { recursive: true }); } catch { /* ignore — cb still points at it */ }
    cb(null, UPLOAD_DIR);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `${uuidv4()}${ext}`);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: parseInt(process.env.MAX_FILE_SIZE || '10485760') },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (BLOCKED_EXT.has(ext)) return cb(new Error(`For security, ${ext || 'this'} files are not allowed.`));
    cb(null, true);   // accept all document/image/archive/text types
  },
});

const DOC = d365.constructor.entities.document;
const EMP = d365.constructor.entities.employee;
const { notifyUser, broadcast } = require('../../services/notification.service');
const DOC_SELECT = 'hr_hrdocumentid,hr_name,hr_fileurl,hr_filesize,hr_originalname,createdon,modifiedon,_hr_hremployee_value';
const DOC_OPT = 'hr_documenttype,hr_remarks,hr_status,hr_uploadedby,hr_verifiedby,hr_verifiedon,hr_hrremarks,hr_contenttype,hr_version,hr_docgroup';
const isHR = (u) => ['super_admin', 'hr_manager'].includes(u.role);

// create/update that strips a not-yet-provisioned column and retries.
async function docWrite(op, id, data) {
  let payload = { ...data };
  for (let i = 0; i < 12; i++) {
    try { return op === 'create' ? await d365.create(DOC, payload) : await d365.update(DOC, id, payload); }
    catch (err) {
      if (!d365._isMissingProperty(err)) throw err;
      const prop = d365._missingPropertyName(err);
      if (prop && Object.prototype.hasOwnProperty.call(payload, prop)) { delete payload[prop]; continue; }
      throw err;
    }
  }
  throw new Error('document write failed');
}

// Notify active HR / Super Admins that a document needs verification.
async function notifyHRDocument(employeeName, docName) {
  try {
    const { data } = await d365.getList(EMP, {
      select: 'hr_hremployeeid',
      filter: `(hr_role eq ${toValue('hr_role', 'super_admin')} or hr_role eq ${toValue('hr_role', 'hr_manager')}) and hr_status eq ${toValue('hr_employee_status', 'active')}`,
    });
    for (const hr of data || []) notifyUser(hr.hr_hremployeeid, 'document:pending', { employeeName, docName });
    broadcast('document:pending', { employeeName, docName });
  } catch (e) { global.logger?.warn?.(`[document] HR notify failed: ${e.message}`); }
}

const shape = (d) => ({
  id: d.hr_hrdocumentid, name: d.hr_name || d.hr_originalname || 'Document', type: d.hr_documenttype || 'Other', fileUrl: d.hr_fileurl,
  fileSize: d.hr_filesize, originalName: d.hr_originalname, contentType: d.hr_contenttype,
  remarks: d.hr_remarks || '', status: d.hr_status || 'pending', uploadedBy: d.hr_uploadedby || '',
  verifiedBy: d.hr_verifiedby || '', verifiedOn: d.hr_verifiedon || '', hrRemarks: d.hr_hrremarks || '',
  uploadedOn: d.createdon, employeeId: d._hr_hremployee_value,
  employeeName: d['_hr_hremployee_value@OData.Community.Display.V1.FormattedValue'] || '',
  employeeCode: '', department: '',   // enriched below from the employee record
  version: d.hr_version || 1, docGroup: d.hr_docgroup || d.hr_hrdocumentid,   // group = version chain
});

// Enrich shaped docs with the employee's code + department + name (not stored on
// the document row). One lookup for a single-employee view; all employees for HR.
async function enrichEmployees(rows, targetId) {
  try {
    const empMap = new Map();
    if (targetId) {
      const e = await d365.getByIdOptional(EMP, targetId, { select: 'hr_hremployeeid,hr_hremployee1', optionalSelect: 'hr_employeeid,hr_department' });
      if (e?.hr_hremployeeid) empMap.set(e.hr_hremployeeid, e);
    } else {
      const { data } = await d365.getListOptional(EMP, { select: 'hr_hremployeeid,hr_hremployee1', optionalSelect: 'hr_employeeid,hr_department', top: 5000 });
      (data || []).forEach(e => empMap.set(e.hr_hremployeeid, e));
    }
    for (const r of rows) {
      const e = empMap.get(r.employeeId);
      if (e) { r.employeeCode = e.hr_employeeid || ''; r.department = e.hr_department || ''; if (!r.employeeName) r.employeeName = e.hr_hremployee1 || ''; }
    }
  } catch (_) { /* enrichment is best-effort */ }
  return rows;
}

// GET /  — list documents (employee sees own; HR passes ?employeeId=)
docRouter.get('/', requireAnyPermission('documents.view'), async (req, res, next) => {
  try {
    const targetId = isHR(req.user) ? req.query.employeeId : req.user.id;
    const filter = targetId ? `_hr_hremployee_value eq '${targetId}'` : undefined;
    const result = await d365.getListOptional(DOC, { select: DOC_SELECT, optionalSelect: DOC_OPT, filter, orderby: 'createdon desc' });
    const rows = await enrichEmployees((result.data || []).map(shape), targetId);
    res.json({ data: rows });
  } catch (err) { next(err); }
});

// GET /pending  — HR queue of documents awaiting verification
docRouter.get('/pending', requireAnyPermission('documents.verify'), async (req, res, next) => {
  try {
    const result = await d365.getListOptional(DOC, { select: DOC_SELECT, optionalSelect: DOC_OPT, orderby: 'createdon desc', top: 2000 });
    const rows = (result.data || []).map(shape).filter(d => (d.status || 'pending') === 'pending' || d.status === 'reupload');
    res.json({ data: rows, count: rows.length });
  } catch (err) { next(err); }
});

// GET /:id  — single document metadata (owner or HR). Used by the Leave module to
// show a linked Medical Certificate's current verification status/actions.
docRouter.get('/:id', requireAnyPermission('documents.view'), async (req, res, next) => {
  try {
    const doc = await d365.getByIdOptional(DOC, req.params.id, { select: DOC_SELECT, optionalSelect: DOC_OPT });
    if (!doc || !doc.hr_hrdocumentid) return res.status(404).json({ error: 'Document not found' });
    if (!isHR(req.user) && doc._hr_hremployee_value !== req.user.id) return res.status(403).json({ error: 'Access denied' });
    res.json(shape(doc));
  } catch (err) { next(err); }
});

// POST /upload  — upload a document (any type). Status → pending; HR notified.
docRouter.post('/upload', requireAnyPermission('documents.upload'), upload.single('file'), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const { employeeId, documentType, name, remarks } = req.body;
    const empId = isHR(req.user) ? (employeeId || req.user.id) : req.user.id;   // employees upload only to themselves
    const doc = await docWrite('create', null, {
      'hr_hremployee@odata.bind': `/hr_hremployees(${empId})`,
      hr_name: name || documentType || req.file.originalname,
      hr_documenttype: documentType || 'Other',
      hr_fileurl: `/uploads/${req.file.filename}`,
      hr_filesize: req.file.size,
      hr_originalname: req.file.originalname,
      hr_contenttype: req.file.mimetype,
      hr_remarks: remarks || '',
      hr_status: 'pending',
      hr_uploadedby: req.user.name || req.user.email || '',
      hr_version: 1,
      hr_docgroup: uuidv4(),   // start a new version chain
    });
    let empName = '';
    try { const e = await d365.getById(EMP, empId, { select: 'hr_hremployee1' }); empName = e.hr_hremployee1 || ''; } catch {}
    notifyHRDocument(empName, name || documentType || req.file.originalname);
    audit({ category: 'document', type: 'uploaded', title: `${documentType || 'Document'} uploaded`,
      name: name || documentType || req.file.originalname, meta: { documentType: documentType || 'Other', employeeId: empId, by: req.user.name || req.user.email } });
    res.status(201).json(shape({ ...doc, _hr_hremployee_value: empId }));
  } catch (err) { next(err); }
});

// GET /:id/file  — stream the actual file for View/Download. Serves EVERY type
// with the correct Content-Type (from the stored mime, else by extension — never
// hardcoded), Content-Length and Content-Disposition (inline for view, attachment
// for download) preserving the ORIGINAL filename. Auth + owner/HR scoped, so it
// does not depend on public static/nginx serving of /uploads.
docRouter.get('/:id/file', requireAnyPermission('documents.view'), async (req, res, next) => {
  try {
    const doc = await d365.getByIdOptional(DOC, req.params.id, {
      select: 'hr_fileurl,hr_name,_hr_hremployee_value', optionalSelect: 'hr_contenttype,hr_originalname,hr_filesize',
    });
    if (!isHR(req.user) && doc._hr_hremployee_value !== req.user.id) return res.status(403).json({ error: 'Access denied' });

    const filename = path.basename(doc.hr_fileurl || '');   // strips /uploads/ + any traversal
    if (!filename) return res.status(404).json({ error: 'No file is associated with this document.' });
    const dir = path.resolve(process.env.UPLOAD_DIR || './uploads');
    const filePath = path.join(dir, filename);
    if (filePath !== dir && !filePath.startsWith(dir + path.sep)) return res.status(400).json({ error: 'Invalid file path.' });
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found on the server — it may have been removed.' });

    const stat = fs.statSync(filePath);
    const original = doc.hr_originalname || filename;
    const contentType = doc.hr_contenttype || mimeFromName(original);   // stored mime wins; never assume PDF
    const disposition = (req.query.download === '1' || req.query.download === 'true') ? 'attachment' : 'inline';
    const safeName = original.replace(/[\r\n"]/g, '');
    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Length', stat.size);
    res.setHeader('Content-Disposition', `${disposition}; filename="${safeName}"; filename*=UTF-8''${encodeURIComponent(original)}`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'private, max-age=0, must-revalidate');
    fs.createReadStream(filePath)
      .on('error', () => { if (!res.headersSent) res.status(500).json({ error: 'Failed to read the file.' }); })
      .pipe(res);
  } catch (err) { res.status(err.status || 404).json({ error: err.message || 'Document not found.' }); }
});

// POST /:id/replace  — replace the file (owner or HR; only while NOT verified). Resets to pending.
docRouter.post('/:id/replace', requireAnyPermission('documents.upload'), upload.single('file'), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const existing = await d365.getByIdOptional(DOC, req.params.id, { select: '_hr_hremployee_value', optionalSelect: 'hr_status' });
    if (!isHR(req.user) && existing._hr_hremployee_value !== req.user.id) return res.status(403).json({ error: 'Access denied' });
    if (!isHR(req.user) && existing.hr_status === 'verified') return res.status(400).json({ error: 'Verified documents cannot be replaced.' });
    await docWrite('update', req.params.id, {
      hr_fileurl: `/uploads/${req.file.filename}`, hr_filesize: req.file.size,
      hr_originalname: req.file.originalname, hr_contenttype: req.file.mimetype,
      hr_status: 'pending', hr_verifiedby: '', hr_verifiedon: '', hr_hrremarks: '',
    });
    // Re-upload restarts verification — notify HR and record it for the audit trail.
    let empName = '';
    try { const e = await d365.getById(EMP, existing._hr_hremployee_value, { select: 'hr_hremployee1' }); empName = e.hr_hremployee1 || ''; } catch {}
    notifyHRDocument(empName, req.file.originalname);
    audit({ category: 'document', type: 're-uploaded', title: 'Document re-uploaded (pending verification)',
      name: req.file.originalname, meta: { employeeId: existing._hr_hremployee_value, by: req.user.name || req.user.email } });
    res.json({ message: 'Document replaced — pending verification' });
  } catch (err) { next(err); }
});

// POST /:id/new-version  — upload a NEW VERSION of a document (typically a verified
// one). The previous version is KEPT; the new version starts as pending → HR
// notified. Owner or HR.
docRouter.post('/:id/new-version', requireAnyPermission('documents.upload'), upload.single('file'), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const existing = await d365.getByIdOptional(DOC, req.params.id, { select: 'hr_name,_hr_hremployee_value', optionalSelect: 'hr_documenttype,hr_docgroup,hr_version' });
    if (!isHR(req.user) && existing._hr_hremployee_value !== req.user.id) return res.status(403).json({ error: 'Access denied' });
    const empId = existing._hr_hremployee_value;
    const group = existing.hr_docgroup || existing.hr_hrdocumentid || req.params.id;
    // Next version = max version in the group + 1.
    let maxV = existing.hr_version || 1;
    try {
      const { data } = await d365.getListOptional(DOC, { select: 'hr_hrdocumentid', optionalSelect: 'hr_version,hr_docgroup', filter: `hr_docgroup eq '${group}'`, top: 100 });
      for (const d of data || []) if ((d.hr_version || 1) > maxV) maxV = d.hr_version || 1;
    } catch { /* column may not exist yet */ }
    const doc = await docWrite('create', null, {
      'hr_hremployee@odata.bind': `/hr_hremployees(${empId})`,
      hr_name: existing.hr_name, hr_documenttype: existing.hr_documenttype,
      hr_fileurl: `/uploads/${req.file.filename}`, hr_filesize: req.file.size,
      hr_originalname: req.file.originalname, hr_contenttype: req.file.mimetype,
      hr_remarks: req.body.remarks || '', hr_status: 'pending',
      hr_uploadedby: req.user.name || req.user.email || '',
      hr_docgroup: group, hr_version: maxV + 1,
    });
    let empName = '';
    try { const e = await d365.getById(EMP, empId, { select: 'hr_hremployee1' }); empName = e.hr_hremployee1 || ''; } catch {}
    notifyHRDocument(empName, `${existing.hr_name} (v${maxV + 1})`);
    res.status(201).json(shape({ ...doc, _hr_hremployee_value: empId, hr_docgroup: group, hr_version: maxV + 1 }));
  } catch (err) { next(err); }
});

// PATCH /:id/verify  — HR approve / reject / request re-upload + HR remarks.
// Approving a NEW version supersedes the previously-verified version in the group.
docRouter.patch('/:id/verify', requireAnyPermission('documents.verify'), async (req, res, next) => {
  try {
    const { action, hrRemarks } = req.body;   // approve | reject | reupload
    const map = { approve: 'verified', reject: 'rejected', reupload: 'reupload' };
    const status = map[action];
    if (!status) return res.status(400).json({ error: 'action must be approve, reject or reupload.' });
    const doc = await d365.getByIdOptional(DOC, req.params.id, { select: 'hr_name,_hr_hremployee_value', optionalSelect: 'hr_documenttype,hr_docgroup' });
    await docWrite('update', req.params.id, {
      hr_status: status, hr_verifiedby: req.user.name || req.user.email || 'HR',
      hr_verifiedon: new Date().toISOString(), hr_hrremarks: hrRemarks || '',
    });
    // On approval: mark any OTHER currently-verified version in the same group as superseded.
    if (status === 'verified' && doc.hr_docgroup) {
      try {
        const { data } = await d365.getListOptional(DOC, { select: 'hr_hrdocumentid', optionalSelect: 'hr_docgroup,hr_status', filter: `hr_docgroup eq '${doc.hr_docgroup}'`, top: 100 });
        for (const other of data || []) {
          if (other.hr_hrdocumentid !== req.params.id && other.hr_status === 'verified') {
            await docWrite('update', other.hr_hrdocumentid, { hr_status: 'superseded' });
          }
        }
      } catch { /* best-effort */ }
    }
    if (doc._hr_hremployee_value) notifyUser(doc._hr_hremployee_value, 'document:verified', { status, docName: doc.hr_name, remarks: hrRemarks || '' });
    audit({ category: 'document', type: status, title: `${doc.hr_documenttype || 'Document'} ${status === 'verified' ? 'verified' : status}`,
      name: doc.hr_name, meta: { documentType: doc.hr_documenttype || '', employeeId: doc._hr_hremployee_value, by: req.user.name || req.user.email, remarks: hrRemarks || '' } });
    res.json({ message: `Document ${status}` });
  } catch (err) {
    console.error('[document/verify] FAILED:', err.message);
    res.status(err.status || 400).json({ error: err.message || 'Verification failed' });
  }
});

// DELETE /:id  — HR always; employee only their OWN and only while NOT verified.
docRouter.delete('/:id', requireAnyPermission('documents.view'), async (req, res, next) => {
  try {
    if (!isHR(req.user)) {
      const existing = await d365.getByIdOptional(DOC, req.params.id, { select: '_hr_hremployee_value', optionalSelect: 'hr_status' });
      if (existing._hr_hremployee_value !== req.user.id) return res.status(403).json({ error: 'Access denied' });
      if (['verified', 'superseded'].includes(existing.hr_status)) return res.status(400).json({ error: 'Verified documents cannot be deleted — upload a new version instead.' });
    }
    await d365.delete(DOC, req.params.id);
    res.json({ message: 'Document deleted' });
  } catch (err) { next(err); }
});

module.exports = { perfRouter, docRouter, _mimeFromName: mimeFromName, _BLOCKED_EXT: BLOCKED_EXT, _MIME_BY_EXT: MIME_BY_EXT };
