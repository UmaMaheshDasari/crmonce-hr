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

docRouter.get('/', requirePermission('document:read'), async (req, res, next) => {
  try {
    const { employeeId, type } = req.query;
    const targetId = req.user.role === 'employee' ? req.user.id : employeeId;
    const filters = [];
    if (targetId) filters.push(`_hr_hremployee_value eq '${targetId}'`);
    if (type) filters.push(`hr_type eq ${toValue('hr_document_type', type)}`);
    const result = await d365.getList(d365.constructor.entities.document, {
      select: 'hr_hrdocumentid,hr_name,hr_type,hr_fileurl,hr_filesize,hr_originalname,createdon',
      filter: filters.join(' and ') || undefined,
      orderby: 'createdon desc',
    });
    res.json(labelsForList('hr_hrdocuments', result));
  } catch (err) { next(err); }
});

docRouter.post('/upload', requirePermission('document:write'), upload.single('file'), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const { employeeId, type, name } = req.body;
    const fileUrl = `/uploads/${req.file.filename}`;
    const doc = await d365.create(d365.constructor.entities.document, {
      'hr_hremployee@odata.bind': `/hr_hremployees(${employeeId})`,
      hr_name: name || req.file.originalname,
      hr_type: toValue('hr_document_type', type),
      hr_fileurl: fileUrl,
      hr_filesize: req.file.size,
      hr_originalname: req.file.originalname,
    });
    res.status(201).json(labelsForEntity('hr_hrdocuments', doc));
  } catch (err) { next(err); }
});

docRouter.delete('/:id', requireRole('super_admin', 'hr_manager'), async (req, res, next) => {
  try {
    await d365.delete(d365.constructor.entities.document, req.params.id);
    res.json({ message: 'Document deleted' });
  } catch (err) { next(err); }
});

module.exports = { perfRouter, docRouter };
