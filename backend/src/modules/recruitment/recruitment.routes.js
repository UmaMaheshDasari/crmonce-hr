const express = require('express');
const router = express.Router();
const d365 = require('../../services/d365.service');
const { requireRole, requirePermission } = require('../../middleware/auth.middleware');
const { notifyNewApplicant, broadcast } = require('../../services/notification.service');
const { toValue, labelsForList, labelsForEntity } = require('../../services/picklist');

// Jobs
router.get('/jobs', async (req, res, next) => {
  try {
    const { status, department } = req.query;
    const filters = [];
    if (status) filters.push(`hr_status eq ${toValue('hr_job_status', status)}`);
    if (department) filters.push(`hr_department eq '${department}'`);
    const result = await d365.getList(d365.constructor.entities.job, {
      select: 'hr_hrjobid,hr_hrjob1,hr_department,hr_openings,hr_status,hr_closingdate,hr_description',
      filter: filters.join(' and ') || undefined,
      orderby: 'createdon desc',
    });
    res.json(labelsForList('hr_hrjobs', result));
  } catch (err) { next(err); }
});

router.post('/jobs', requireRole('super_admin', 'hr_manager'), async (req, res, next) => {
  try {
    const job = await d365.create(d365.constructor.entities.job, { ...req.body, hr_status: toValue('hr_job_status', 'open') });
    res.status(201).json(labelsForEntity('hr_hrjobs', job));
  } catch (err) { next(err); }
});

// Applications
router.get('/applications', requirePermission('recruitment:read'), async (req, res, next) => {
  try {
    const { jobId, stage } = req.query;
    const filters = [];
    if (jobId) filters.push(`_hr_hrjob_value eq '${jobId}'`);
    if (stage) filters.push(`hr_stage eq ${toValue('hr_application_stage', stage)}`);
    const result = await d365.getList(d365.constructor.entities.application, {
      select: 'hr_hrapplicationid,hr_candidatename,hr_email,hr_phone,hr_stage,hr_applieddate,hr_resumeurl,_hr_hrjob_value',
      filter: filters.join(' and ') || undefined,
      orderby: 'hr_applieddate desc',
    });
    res.json(labelsForList('hr_hrapplications', result));
  } catch (err) { next(err); }
});

// POST /api/recruitment/applications — new application
router.post('/applications', async (req, res, next) => {
  try {
    const app = await d365.create(d365.constructor.entities.application, {
      ...req.body,
      hr_stage: toValue('hr_application_stage', 'applied'),
      hr_applieddate: new Date().toISOString(),
    });
    // Notify all connected clients about the new applicant
    broadcast('recruitment:new_applicant', {
      jobTitle: req.body.jobTitle || 'Unknown Position',
      applicantName: req.body.hr_candidatename || 'Unknown',
    });
    res.status(201).json(labelsForEntity('hr_hrapplications', app));
  } catch (err) { next(err); }
});

router.patch('/applications/:id/stage', requirePermission('recruitment:write'), async (req, res, next) => {
  try {
    const { stage, notes } = req.body;
    const app = await d365.update(d365.constructor.entities.application, req.params.id, {
      hr_stage: toValue('hr_application_stage', stage), hr_notes: notes, hr_stageupdatedon: new Date().toISOString(),
    });
    res.json(labelsForEntity('hr_hrapplications', app));
  } catch (err) { next(err); }
});

module.exports = router;
