const express = require('express');
const perfRouter = express.Router();
const docRouter = express.Router();
const multer = require('multer');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const d365 = require('../../services/d365.service');
const { requireRole, requirePermission } = require('../../middleware/auth.middleware');
const { toValue, labelsForList, labelsForEntity } = require('../../services/picklist');

// ── PERFORMANCE ───────────────────────────────────────────────────
perfRouter.get('/', requirePermission('performance:read'), async (req, res, next) => {
  try {
    const { employeeId, cycle } = req.query;
    const targetId = req.user.role === 'employee' ? req.user.id : employeeId;
    const filters = [];
    if (targetId) filters.push(`_hr_hremployee_value eq '${targetId}'`);
    if (cycle) filters.push(`hr_cycle eq '${cycle}'`);
    const result = await d365.getList(d365.constructor.entities.performance, {
      select: 'hr_hrperformanceid,hr_cycle,hr_rating,hr_kpis,hr_goals,hr_reviewernotes,hr_status',
      filter: filters.join(' and ') || undefined,
      orderby: 'createdon desc',
    });
    res.json(labelsForList('hr_hrperformances', result));
  } catch (err) { next(err); }
});

perfRouter.post('/', requireRole('super_admin', 'hr_manager'), async (req, res, next) => {
  try {
    const perf = await d365.create(d365.constructor.entities.performance, {
      ...req.body,
      'hr_hremployee@odata.bind': `/hr_hremployees(${req.user.id})`,
      hr_status: toValue('hr_performance_status', 'draft'),
    });
    res.status(201).json(labelsForEntity('hr_hrperformances', perf));
  } catch (err) { next(err); }
});

perfRouter.patch('/:id', requirePermission('performance:write'), async (req, res, next) => {
  try {
    const body = { ...req.body };
    if (body.hr_status) body.hr_status = toValue('hr_performance_status', body.hr_status);
    const perf = await d365.update(d365.constructor.entities.performance, req.params.id, body);
    res.json(labelsForEntity('hr_hrperformances', perf));
  } catch (err) { next(err); }
});

// ── DOCUMENTS ─────────────────────────────────────────────────────
const storage = multer.diskStorage({
  destination: process.env.UPLOAD_DIR || './uploads',
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `${uuidv4()}${ext}`);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: parseInt(process.env.MAX_FILE_SIZE || '10485760') },
  fileFilter: (req, file, cb) => {
    const allowed = ['.pdf', '.doc', '.docx', '.jpg', '.jpeg', '.png'];
    if (allowed.includes(path.extname(file.originalname).toLowerCase())) cb(null, true);
    else cb(new Error('File type not allowed'));
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
  id: d.hr_hrdocumentid, name: d.hr_name, type: d.hr_documenttype || d.hr_name, fileUrl: d.hr_fileurl,
  fileSize: d.hr_filesize, originalName: d.hr_originalname, contentType: d.hr_contenttype,
  remarks: d.hr_remarks || '', status: d.hr_status || 'pending', uploadedBy: d.hr_uploadedby || '',
  verifiedBy: d.hr_verifiedby || '', verifiedOn: d.hr_verifiedon || '', hrRemarks: d.hr_hrremarks || '',
  uploadedOn: d.createdon, employeeId: d._hr_hremployee_value,
  employeeName: d['_hr_hremployee_value@OData.Community.Display.V1.FormattedValue'] || '',
  version: d.hr_version || 1, docGroup: d.hr_docgroup || d.hr_hrdocumentid,   // group = version chain
});

// GET /  — list documents (employee sees own; HR passes ?employeeId=)
docRouter.get('/', requirePermission('document:read'), async (req, res, next) => {
  try {
    const targetId = isHR(req.user) ? req.query.employeeId : req.user.id;
    const filter = targetId ? `_hr_hremployee_value eq '${targetId}'` : undefined;
    const result = await d365.getListOptional(DOC, { select: DOC_SELECT, optionalSelect: DOC_OPT, filter, orderby: 'createdon desc' });
    res.json({ data: (result.data || []).map(shape) });
  } catch (err) { next(err); }
});

// GET /pending  — HR queue of documents awaiting verification
docRouter.get('/pending', requireRole('super_admin', 'hr_manager'), async (req, res, next) => {
  try {
    const result = await d365.getListOptional(DOC, { select: DOC_SELECT, optionalSelect: DOC_OPT, orderby: 'createdon desc', top: 2000 });
    const rows = (result.data || []).map(shape).filter(d => (d.status || 'pending') === 'pending' || d.status === 'reupload');
    res.json({ data: rows, count: rows.length });
  } catch (err) { next(err); }
});

// POST /upload  — upload a document (any type). Status → pending; HR notified.
docRouter.post('/upload', requirePermission('document:write'), upload.single('file'), async (req, res, next) => {
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
    res.status(201).json(shape({ ...doc, _hr_hremployee_value: empId }));
  } catch (err) { next(err); }
});

// POST /:id/replace  — replace the file (owner or HR; only while NOT verified). Resets to pending.
docRouter.post('/:id/replace', requirePermission('document:write'), upload.single('file'), async (req, res, next) => {
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
    res.json({ message: 'Document replaced — pending verification' });
  } catch (err) { next(err); }
});

// POST /:id/new-version  — upload a NEW VERSION of a document (typically a verified
// one). The previous version is KEPT; the new version starts as pending → HR
// notified. Owner or HR.
docRouter.post('/:id/new-version', requirePermission('document:write'), upload.single('file'), async (req, res, next) => {
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
docRouter.patch('/:id/verify', requireRole('super_admin', 'hr_manager'), async (req, res, next) => {
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
    res.json({ message: `Document ${status}` });
  } catch (err) {
    console.error('[document/verify] FAILED:', err.message);
    res.status(err.status || 400).json({ error: err.message || 'Verification failed' });
  }
});

// DELETE /:id  — HR always; employee only their OWN and only while NOT verified.
docRouter.delete('/:id', requirePermission('document:read'), async (req, res, next) => {
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

module.exports = { perfRouter, docRouter };
