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
};

// ── Holiday Calendar (HR-managed) ────────────────────────────────
export const holidayApi = {
  list: () => api.get('/holidays'),
  add: (data) => api.post('/holidays', data),
  remove: (id) => api.delete(`/holidays/${id}`),
};

// ── Payroll ──────────────────────────────────────────────────────
export const payrollApi = {
  list: (params) => api.get('/payroll', { params }),
  generate: (data) => api.post('/payroll/generate', data),
  process: (data) => api.post('/payroll/process', data),   // alias (backward-compat)
  approve: (id) => api.patch(`/payroll/${id}/approve`),
  release: (id) => api.patch(`/payroll/${id}/release`),
  downloadPayslip: (id) => api.get(`/payroll/${id}/payslip`, { responseType: 'blob' }),
  report: (type, params) => api.get(`/payroll/reports/${type}`, { params, responseType: 'blob' }),
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

// ── Company Settings ─────────────────────────────────────────────
export const companyApi = {
  get: () => api.get('/company'),
  update: (data) => api.patch('/company', data),
};

// ── Documents ────────────────────────────────────────────────────
export const documentApi = {
  list: (params) => api.get('/documents', { params }),
  pending: () => api.get('/documents/pending'),
  upload: (formData, onUploadProgress) => api.post('/documents/upload', formData, {
    headers: { 'Content-Type': 'multipart/form-data' }, onUploadProgress,
  }),
  replace: (id, formData, onUploadProgress) => api.post(`/documents/${id}/replace`, formData, {
    headers: { 'Content-Type': 'multipart/form-data' }, onUploadProgress,
  }),
  verify: (id, data) => api.patch(`/documents/${id}/verify`, data),
  delete: (id) => api.delete(`/documents/${id}`),
};
