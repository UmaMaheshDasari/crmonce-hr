/**
 * D365 Picklist value mappings
 * Maps string labels ↔ numeric D365 option set values
 */

const PICKLISTS = {
  // hr_hremployee
  hr_role: {
    employee: 123140000,
    hr_manager: 123140001,
    recruiter: 123140002,
    super_admin: 123140003,
  },
  hr_employee_status: {
    active: 123140000,
    inactive: 123140001,
    on_leave: 123140002,
  },
  // hr_hrattendance
  hr_attendance_source: {
    etime_device: 123140000,
    manual_correction: 123140001,
    web_checkin: 123140002,
  },
  hr_attendance_status: {
    present: 123140000,
    absent: 123140001,
    half_day: 123140002,
    incomplete: 123140003,
    holiday: 123140004,
  },
  // hr_hrleave
  hr_leave_status: {
    pending: 123140000,
    approved: 123140001,
    rejected: 123140002,
    cancelled: 123140003,
  },
  hr_leave_type: {
    'Casual Leave': 123140000,
    'Sick Leave': 123140001,
    'Earned Leave': 123140002,
    'Maternity Leave': 123140003,
    'Paternity Leave': 123140004,
    'LOP': 123140005,
  },
  // hr_hrjob
  hr_job_status: {
    open: 123140000,
    closed: 123140001,
    on_hold: 123140002,
  },
  // hr_hrapplication
  hr_application_stage: {
    applied: 123140000,
    screening: 123140001,
    interview: 123140002,
    offer: 123140003,
    hired: 123140004,
    rejected: 123140005,
  },
  // hr_hrperformance
  hr_performance_status: {
    draft: 123140000,
    'in-review': 123140001,
    completed: 123140002,
  },
  // hr_hrdocument
  hr_document_type: {
    'Offer Letter': 123140000,
    'Contract': 123140001,
    'ID Proof': 123140002,
    'Payslip': 123140003,
    'Certificate': 123140004,
    'Other': 123140005,
  },
  // hr_hrpayroll
  hr_payroll_status: {
    draft: 123140000,
    processed: 123140001,
    paid: 123140002,
  },
  // hr_hrtaxdeclaration
  hr_declaration_status: {
    draft: 123140000,
    submitted: 123140001,
    verified: 123140002,
    rejected: 123140003,
  },
  hr_tax_regime: {
    old: 123140000,
    new: 123140001,
  },
  // hr_hrgoals
  hr_goal_status: {
    not_started: 123140000,
    in_progress: 123140001,
    completed: 123140002,
    exceeded: 123140003,
    missed: 123140004,
  },
  hr_goal_priority: {
    low: 123140000,
    medium: 123140001,
    high: 123140002,
    critical: 123140003,
  },
  hr_quarter: {
    Q1: 123140000,
    Q2: 123140001,
    Q3: 123140002,
    Q4: 123140003,
  },
};

// Build reverse maps (numeric → string)
const REVERSE = {};
for (const [key, map] of Object.entries(PICKLISTS)) {
  REVERSE[key] = {};
  for (const [label, value] of Object.entries(map)) {
    REVERSE[key][value] = label;
  }
}

/** Convert string label to D365 numeric value */
function toValue(picklistName, label) {
  if (typeof label === 'number') return label;
  return PICKLISTS[picklistName]?.[label] ?? label;
}

/** Convert D365 numeric value to string label */
function toLabel(picklistName, value) {
  if (typeof value === 'string') return value;
  return REVERSE[picklistName]?.[value] ?? value;
}

/** Map of D365 field names → picklist names for auto-conversion */
const FIELD_TO_PICKLIST = {
  hr_role: 'hr_role',
  hr_status: null, // ambiguous — resolved per entity
  hr_source: 'hr_attendance_source',
  hr_stage: 'hr_application_stage',
  hr_leavetype: 'hr_leave_type',
  hr_type: 'hr_document_type',
  hr_regime: 'hr_tax_regime',
  hr_priority: 'hr_goal_priority',
  hr_quarter: 'hr_quarter',
};

/** Entity-specific hr_status mappings */
const STATUS_PICKLISTS = {
  hr_hremployees: 'hr_employee_status',
  hr_hrattendances: 'hr_attendance_status',
  hr_hrleaves: 'hr_leave_status',
  hr_hrjobs: 'hr_job_status',
  hr_hrpayrolls: 'hr_payroll_status',
  hr_hrperformances: 'hr_performance_status',
  hr_hrtaxdeclarations: 'hr_declaration_status',
  hr_hrgoals: 'hr_goal_status',
};

/** Convert numeric picklist values in a record to string labels */
function labelsForEntity(entity, record) {
  if (!record || typeof record !== 'object') return record;
  const out = { ...record };
  const statusPicklist = STATUS_PICKLISTS[entity];
  for (const [field, picklistName] of Object.entries(FIELD_TO_PICKLIST)) {
    if (out[field] !== undefined && typeof out[field] === 'number') {
      const pl = field === 'hr_status' ? statusPicklist : picklistName;
      if (pl) out[field] = toLabel(pl, out[field]);
    }
  }
  return out;
}

/** Convert all records in a D365 list response */
function labelsForList(entity, result) {
  if (result?.data && Array.isArray(result.data)) {
    result.data = result.data.map(r => labelsForEntity(entity, r));
  }
  return result;
}

module.exports = { PICKLISTS, toValue, toLabel, labelsForEntity, labelsForList };
