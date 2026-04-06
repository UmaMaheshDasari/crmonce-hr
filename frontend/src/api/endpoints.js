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
};

// ── Leave ────────────────────────────────────────────────────────
export const leaveApi = {
  list: (params) => api.get('/attendance/leave', { params }),
  apply: (data) => api.post('/attendance/leave', data),
  approve: (id, status, remarks) => api.patch(`/attendance/leave/${id}`, { status, remarks }),
  approveL1: (id, action, remarks) => api.patch(`/attendance/leave/${id}/l1`, { action, remarks }),
  approveL2: (id, action, remarks) => api.patch(`/attendance/leave/${id}/l2`, { action, remarks }),
  pendingApprovals: () => api.get('/attendance/leave/pending-approvals'),
};

// ── Payroll ──────────────────────────────────────────────────────
export const payrollApi = {
  list: (params) => api.get('/payroll', { params }),
  process: (data) => api.post('/payroll/process', data),
  downloadPayslip: (id) => api.get(`/payroll/${id}/payslip`, { responseType: 'blob' }),
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

// ── Documents ────────────────────────────────────────────────────
export const documentApi = {
  list: (params) => api.get('/documents', { params }),
  upload: (formData) => api.post('/documents/upload', formData, {
    headers: { 'Content-Type': 'multipart/form-data' },
  }),
  delete: (id) => api.delete(`/documents/${id}`),
};
