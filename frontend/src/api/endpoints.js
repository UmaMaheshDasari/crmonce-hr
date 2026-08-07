import api from './client';

// ── Auth ─────────────────────────────────────────────────────────
export const authApi = {
  login: (email, password) => api.post('/auth/login', { email, password }),
  azureLogin: () => api.get('/auth/azure/login'),
  azureCallback: (code) => api.post('/auth/azure/callback', { code }),
  refresh: (refreshToken) => api.post('/auth/refresh', { refreshToken }),
  me: () => api.get('/auth/me'),
  logout: () => api.post('/auth/logout'),
};

// ── Employees ────────────────────────────────────────────────────
export const employeeApi = {
  list: (params) => api.get('/employees', { params }),
  get: (id) => api.get(`/employees/${id}`),
  create: (data) => api.post('/employees', data),
  update: (id, data) => api.patch(`/employees/${id}`, data),
  delete: (id) => api.delete(`/employees/${id}`),
  departments: () => api.get('/employees/meta/departments'),
  verify: (id, data) => api.patch(`/employees/${id}/verify`, data),   // HR: approve/reject/request_changes
  profileAudit: (id) => api.get(`/employees/${id}/profile-audit`),
  pendingVerifications: () => api.get('/employees/verifications/pending'),
  backfillCodes: () => api.post('/employees/meta/backfill-codes'),
  syncEtime: (employees) => api.post('/employees/meta/sync-etime', { employees }),
};

// ── Attendance ───────────────────────────────────────────────────
export const attendanceApi = {
  list: (params) => api.get('/attendance', { params }),
  summary: (params) => api.get('/attendance/summary', { params }),
  sync: (from, to) => api.post('/attendance/sync', { from, to }),
  update: (id, data) => api.patch(`/attendance/${id}`, data),
  edit: (id, data) => api.put(`/attendance/${id}/edit`, data),          // HR full edit + recompute + audit
  historical: (data) => api.post('/attendance/historical', data),       // HR manual historical entry
  audit: (params) => api.get('/attendance/audit', { params }),          // attendance edit history
  checkin: () => api.post('/attendance/checkin'),
  checkout: () => api.post('/attendance/checkout'),
  myStatus: () => api.get('/attendance/my-status'),
  firstDate: (params) => api.get('/attendance/first-date', { params }),   // dynamic Attendance Start Date
  correction: (attendanceId, actualCheckout, reason) =>
    api.post('/attendance/correction', { attendanceId, actualCheckout, reason }),
  summaryMonthly: (params) => api.get('/attendance/summary/monthly', { params }),
  stats: (params) => api.get('/attendance/stats', { params }),
  absentees: (params) => api.get('/attendance/absentees', { params }),
  weekly: () => api.get('/attendance/weekly'),
  hrOverview: () => api.get('/attendance/hr/overview'),
  exportExcel: (params) => api.get('/attendance/export', { params, responseType: 'blob' }),
};

// ── Attendance Requests (Missing Punch workflow) ─────────────────
export const attendanceRequestApi = {
  submit: (data) => api.post('/attendance-requests', data),
  list: (params) => api.get('/attendance-requests', { params }),
  approve: (id, comment) => api.patch(`/attendance-requests/${id}/approve`, { comment }),
  reject: (id, comment) => api.patch(`/attendance-requests/${id}/reject`, { comment }),
  emailAction: (id, action, token, comment) => api.post(`/attendance-requests/${id}/email-action`, { action, token, comment }),
  setup: () => api.post('/attendance-requests/setup'),   // super-admin: provision the Dataverse table
};

// ── Leave ────────────────────────────────────────────────────────
export const leaveApi = {
  list: (params) => api.get('/attendance/leave', { params }),
  apply: (data) => api.post('/attendance/leave', data),
  approve: (id, status, remarks) => api.patch(`/attendance/leave/${id}`, { status, remarks }),
  approveL1: (id, action, remarks) => api.patch(`/attendance/leave/${id}/l1`, { action, remarks }),
  approveL2: (id, action, remarks) => api.patch(`/attendance/leave/${id}/l2`, { action, remarks }),
  pendingApprovals: () => api.get('/attendance/leave/pending-approvals'),
  summary: (params) => api.get('/attendance/leave/summary', { params }),
  approvers: () => api.get('/attendance/leave/approvers'),
  ccCandidates: () => api.get('/attendance/leave/cc-candidates'),
  // Approve/Reject from an email button (carries the signed link token).
  emailAction: (id, action, token, remarks) =>
    api.post(`/attendance/leave/${id}/email-action`, { action, token, remarks }),
  // ── Leave Engine (balances, comp-off, adjustments) ──
  balance: (params) => api.get('/attendance/leave/balance', { params }),
  ledger: (params) => api.get('/attendance/leave/ledger', { params }),
  compOff: (data) => api.post('/attendance/leave/compoff', data),
  adjust: (data) => api.post('/attendance/leave/adjust', data),
  // Sick-leave Medical Certificate policy (configurable; not hardcoded in the UI).
  medCertPolicy: () => api.get('/attendance/leave/medcert-policy'),
  // Dynamic per-request check: is a certificate required for THESE dates given the
  // employee's consecutive Sick-Leave run (across history, ignoring offs/holidays)?
  medCertCheck: (params) => api.get('/attendance/leave/medcert-check', { params }),
};

// ── Comp Off ─────────────────────────────────────────────────────
export const compOffApi = {
  list: (params) => api.get('/attendance/comp-off', { params }),
  balance: (params) => api.get('/attendance/comp-off/balance', { params }),
  policy: () => api.get('/attendance/comp-off/policy'),
  create: (data) => api.post('/attendance/comp-off', data),
  approve: (id) => api.patch(`/attendance/comp-off/${id}/approve`),
  reject: (id, remarks) => api.patch(`/attendance/comp-off/${id}/reject`, { remarks }),
  cancel: (id, remarks) => api.patch(`/attendance/comp-off/${id}/cancel`, { remarks }),
  expire: (id) => api.patch(`/attendance/comp-off/${id}/expire`),
  edit: (id, data) => api.patch(`/attendance/comp-off/${id}`, data),
  scan: (data) => api.post('/attendance/comp-off/scan', data),
};

// ── Late Login ───────────────────────────────────────────────────
export const lateLoginApi = {
  list: (params) => api.get('/attendance/late-login', { params }),
  policy: () => api.get('/attendance/late-login/policy'),
  summary: (params) => api.get('/attendance/late-login/summary', { params }),
  create: (data) => api.post('/attendance/late-login', data),
  managerDecide: (id, action, remarks) => api.patch(`/attendance/late-login/${id}/manager`, { action, remarks }),
  hrDecide: (id, action, remarks) => api.patch(`/attendance/late-login/${id}/hr`, { action, remarks }),
  cancel: (id) => api.patch(`/attendance/late-login/${id}/cancel`),
  export: (params) => api.get('/attendance/late-login/export', { params, responseType: 'blob' }),
};

// ── Leave Opening Balance (historical migration) ─────────────────
export const leaveOpeningApi = {
  list: (params) => api.get('/leave-opening', { params }),
  audit: (params) => api.get('/leave-opening/audit', { params }),
  create: (data) => api.post('/leave-opening', data),
  update: (data) => api.put('/leave-opening', data),
  remove: (id) => api.delete(`/leave-opening/${id}`),
};

// ── Holiday Calendar (HR-managed) ────────────────────────────────
export const holidayApi = {
  list: () => api.get('/holidays'),
  add: (data) => api.post('/holidays', data),
  update: (id, data) => api.put(`/holidays/${id}`, data),
  remove: (id) => api.delete(`/holidays/${id}`),
};

// ── Payroll ──────────────────────────────────────────────────────
export const payrollApi = {
  list: (params) => api.get('/payroll', { params }),
  generate: (data) => api.post('/payroll/generate', data),
  process: (data) => api.post('/payroll/process', data),   // alias (backward-compat)
  validate: (data) => api.post('/payroll/validate', data),
  remindLeave: (data) => api.post('/payroll/remind-leave', data),
  approve: (id) => api.patch(`/payroll/${id}/approve`),
  release: (id) => api.patch(`/payroll/${id}/release`),
  lock: (id) => api.patch(`/payroll/${id}/lock`),
  unlock: (id) => api.patch(`/payroll/${id}/unlock`),
  lockMonth: (data) => api.post('/payroll/lock-month', data),
  downloadPayslip: (id) => api.get(`/payroll/${id}/payslip`, { responseType: 'blob' }),
  payslipData: (id) => api.get(`/payroll/${id}/payslip-data`),
  emailPayslip: (id) => api.post(`/payroll/${id}/email`),
  report: (type, params) => api.get(`/payroll/reports/${type}`, { params, responseType: 'blob' }),
  dashboard: (params) => api.get('/payroll/dashboard', { params }),
};

// ── Payroll Automation ───────────────────────────────────────────
export const automationApi = {
  jobs: (params) => api.get('/payroll/automation/jobs', { params }),
  job: (id) => api.get(`/payroll/automation/jobs/${id}`),
  run: (data) => api.post('/payroll/automation/run', data),
  retry: (id) => api.post(`/payroll/automation/jobs/${id}/retry`),
};

// ── Professional Tax Master (configurable slabs) ─────────────────
export const ptMasterApi = {
  list: () => api.get('/payroll/pt-slabs'),
  create: (data) => api.post('/payroll/pt-slabs', data),
  update: (id, data) => api.patch(`/payroll/pt-slabs/${id}`, data),
  setStatus: (id, status) => api.patch(`/payroll/pt-slabs/${id}/status`, { status }),
  preview: (params) => api.get('/payroll/pt-slabs/preview', { params }),
};

// ── Payroll Settings (admin-configurable payroll parameters) ─────
export const payrollSettingsApi = {
  get: () => api.get('/payroll/settings'),
  update: (data) => api.put('/payroll/settings', data),
};

// ── Advance Salary (request → approve → EMI recovery) ──
export const advanceApi = {
  list: (params) => api.get('/payroll/advances', { params }),
  pending: () => api.get('/payroll/advances/pending'),
  balance: (params) => api.get('/payroll/advances/balance', { params }),
  apply: (data) => api.post('/payroll/advances', data),
  approve: (id, data) => api.patch(`/payroll/advances/${id}/approve`, data),
  reject: (id, data) => api.patch(`/payroll/advances/${id}/reject`, data),
  delete: (id) => api.delete(`/payroll/advances/${id}`),
};

// ── Salary Structure (effective-dated salary revisions per employee) ──
export const salaryStructureApi = {
  list: (params) => api.get('/payroll/salary-structures', { params }),
  history: (employeeId) => api.get(`/payroll/salary-structures/employee/${employeeId}`),
  get: (id) => api.get(`/payroll/salary-structures/${id}`),
  create: (data) => api.post('/payroll/salary-structures', data),
  update: (id, data) => api.patch(`/payroll/salary-structures/${id}`, data),
  delete: (id) => api.delete(`/payroll/salary-structures/${id}`),
};

// ── Recruitment ──────────────────────────────────────────────────
export const recruitmentApi = {
  jobs: (params) => api.get('/recruitment/jobs', { params }),
  createJob: (data) => api.post('/recruitment/jobs', data),
  applications: (params) => api.get('/recruitment/applications', { params }),
  updateStage: (id, stage, notes) => api.patch(`/recruitment/applications/${id}/stage`, { stage, notes }),
};

// ── Performance ──────────────────────────────────────────────────
export const performanceApi = {
  list: (params) => api.get('/performance', { params }),
  create: (data) => api.post('/performance', data),
  update: (id, data) => api.patch(`/performance/${id}`, data),
};

// ── Tax Declarations ────────────────────────────────────────────
export const taxDeclarationApi = {
  list: (params) => api.get('/payroll/tax-declarations', { params }),
  get: (id) => api.get(`/payroll/tax-declarations/${id}`),
  create: (data) => api.post('/payroll/tax-declarations', data),
  update: (id, data) => api.patch(`/payroll/tax-declarations/${id}`, data),
  delete: (id) => api.delete(`/payroll/tax-declarations/${id}`),
};

// ── Goals ───────────────────────────────────────────────────────
export const goalsApi = {
  list: (params) => api.get('/performance/goals', { params }),
  get: (id) => api.get(`/performance/goals/${id}`),
  create: (data) => api.post('/performance/goals', data),
  update: (id, data) => api.patch(`/performance/goals/${id}`, data),
  delete: (id) => api.delete(`/performance/goals/${id}`),
};

// ── Activity Feed ────────────────────────────────────────────────
export const activityApi = {
  list: (limit = 20) => api.get('/activity', { params: { limit } }),
};

// ── Dashboard (single aggregated summary — one call powers the whole dashboard) ──
export const dashboardApi = {
  summary: (params) => api.get('/dashboard/summary', { params }),            // employee
  adminSummary: (params) => api.get('/dashboard/admin-summary', { params }), // HR / admin
};

// ── Import / Export Center ───────────────────────────────────────
export const importExportApi = {
  types: () => api.get('/import-export/types'),
  template: (type) => api.get(`/import-export/template/${type}`, { responseType: 'blob' }),
  preview: (type, formData) => api.post(`/import-export/import/${type}/preview`, formData, { headers: { 'Content-Type': 'multipart/form-data' } }),
  commit: (type, formData) => api.post(`/import-export/import/${type}/commit`, formData, { headers: { 'Content-Type': 'multipart/form-data' } }),
  export: (type, params) => api.get(`/import-export/export/${type}`, { params, responseType: 'blob' }),
};

// ── Company Settings ─────────────────────────────────────────────
export const companyApi = {
  get: () => api.get('/company'),
  update: (data) => api.patch('/company', data),
};

// ── Documents ────────────────────────────────────────────────────
export const documentApi = {
  list: (params) => api.get('/documents', { params }),
  get: (id) => api.get(`/documents/${id}`),
  pending: () => api.get('/documents/pending'),
  upload: (formData, onUploadProgress) => api.post('/documents/upload', formData, {
    headers: { 'Content-Type': 'multipart/form-data' }, onUploadProgress,
  }),
  replace: (id, formData, onUploadProgress) => api.post(`/documents/${id}/replace`, formData, {
    headers: { 'Content-Type': 'multipart/form-data' }, onUploadProgress,
  }),
  newVersion: (id, formData, onUploadProgress) => api.post(`/documents/${id}/new-version`, formData, {
    headers: { 'Content-Type': 'multipart/form-data' }, onUploadProgress,
  }),
  verify: (id, data) => api.patch(`/documents/${id}/verify`, data),
  delete: (id) => api.delete(`/documents/${id}`),
  // Stream the actual file (authenticated). download=true → attachment.
  file: (id, download) => api.get(`/documents/${id}/file`, { params: download ? { download: 1 } : {}, responseType: 'blob' }),
};

// ── Shared Request Lifecycle (delete / resubmit / cancellation) ──────
// One API for every request module — pass the module `type` (e.g. 'late_login',
// 'leave', 'comp_off', 'attendance_correction', 'document').
export const requestLifecycleApi = {
  status: (type, id) => api.get(`/requests/${type}/${id}`),
  audit: (type, id) => api.get(`/requests/${type}/${id}/audit`),
  remove: (type, id) => api.delete(`/requests/${type}/${id}`),
  resubmit: (type, id, edits) => api.post(`/requests/${type}/${id}/resubmit`, { edits }),
  requestCancellation: (type, id, reason) => api.post(`/requests/${type}/${id}/cancellation`, { reason }),
  cancellationManager: (type, id, action, remarks) => api.patch(`/requests/${type}/${id}/cancellation/manager`, { action, remarks }),
  cancellationHr: (type, id, action, remarks) => api.patch(`/requests/${type}/${id}/cancellation/hr`, { action, remarks }),
  cancellations: (params) => api.get('/requests/cancellations', { params }),
};

// ── Celebrations (Birthday / Marriage / Work Anniversary) ────────────
export const celebrationsApi = {
  today: () => api.get('/celebrations/today'),
  settings: () => api.get('/celebrations/settings'),
  updateSettings: (data) => api.put('/celebrations/settings', data),
  logs: (params) => api.get('/celebrations/logs', { params }),
  run: () => api.post('/celebrations/run'),
};
