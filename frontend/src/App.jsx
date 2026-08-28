import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { Toaster } from 'react-hot-toast';
import { AuthProvider, useAuth } from './context/AuthContext';
import useVersionCheck from './hooks/useVersionCheck';
import AppShell from './layouts/AppShell';
import LoginPage from './modules/auth/LoginPage';
import AzureCallback from './modules/auth/AzureCallback';
import Dashboard from './modules/dashboard/Dashboard';
import EmployeesHome from './modules/employees/EmployeesHome';
import EmployeeDetail from './modules/employees/EmployeeDetail';
import EmployeeForm from './modules/employees/EmployeeForm';
import AttendancePage from './modules/attendance/AttendancePage';
import AttendanceRequestsPage from './modules/attendance/AttendanceRequestsPage';
import HolidaysPage from './modules/attendance/HolidaysPage';
import LeavePage from './modules/attendance/LeavePage';
import CompOffPage from './modules/attendance/CompOffPage';
import LateLoginPage from './modules/attendance/LateLoginPage';
import LeaveOpeningBalancePage from './modules/attendance/LeaveOpeningBalancePage';
import ShiftHistoryPage from './modules/attendance/ShiftHistoryPage';
import HistoricalAttendancePage from './modules/attendance/HistoricalAttendancePage';
import PayrollPage from './modules/payroll/PayrollPage';
import RecruitmentPage from './modules/recruitment/RecruitmentPage';
import PerformancePage from './modules/performance/PerformancePage';
import DocumentsPage from './modules/documents/DocumentsPage';
import TaxDeclarationPage from './modules/payroll/TaxDeclarationPage';
import PayrollSettingsPage from './modules/payroll/PayrollSettingsPage';
import PTMasterPage from './modules/payroll/PTMasterPage';
import CelebrationsPage from './modules/celebrations/CelebrationsPage';
import HistoricalAttendanceRequestsPage from './modules/attendance/HistoricalAttendanceRequestsPage';
import CancellationRequestsPage from './modules/shared/CancellationRequestsPage';
import SalaryStructurePage from './modules/payroll/SalaryStructurePage';
import AdvanceSalaryPage from './modules/payroll/AdvanceSalaryPage';
import PayrollDashboardPage from './modules/payroll/PayrollDashboardPage';
import AutomationPage from './modules/payroll/AutomationPage';
import GoalsPage from './modules/performance/GoalsPage';
import ApprovalAction from './modules/attendance/ApprovalAction';
// ActivitiesPage is intentionally not imported — the /activities route is
// redirected for every role (see below). The module is left in the tree so the
// route can be restored once the backend feed is scoped. Not importing it also
// keeps it out of the bundle.
import CompanySettingsPage from './modules/company/CompanySettingsPage';
import WebCheckInAccessPage from './modules/attendance/WebCheckInAccessPage';
import ImportExportPage from './modules/shared/ImportExportPage';
import ProfilePage from './modules/employees/ProfilePage';
import HRVerificationPage from './modules/employees/HRVerificationPage';
import UsersPage from './modules/admin/UsersPage';
import RolesPermissionsPage from './modules/admin/RolesPermissionsPage';
import AuditLogsPage from './modules/admin/AuditLogsPage';

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, staleTime: 300000, refetchOnWindowFocus: false } },
});

function ProtectedRoute({ children, roles, permission }) {
  const { user, loading, hasPermission } = useAuth();
  if (loading) return (
    <div className="flex items-center justify-center h-screen bg-gray-50">
      <div className="w-8 h-8 border-4 border-indigo-600 border-t-transparent rounded-full animate-spin" />
    </div>
  );
  if (!user) return <Navigate to="/login" replace />;
  if (roles && !roles.includes(user.role)) return <Navigate to="/" replace />;
  // RBAC Phase E: optional granular gate (backend still enforces — this is UX only).
  if (permission && !hasPermission(permission)) return <Navigate to="/" replace />;
  return children;
}

function AppRoutes() {
  const { user } = useAuth();
  return (
    <Routes>
      <Route path="/login" element={user ? <Navigate to="/" replace /> : <LoginPage />} />
      <Route path="/auth/callback" element={<AzureCallback />} />
      <Route path="/approve" element={<ApprovalAction />} />
      <Route path="/" element={<ProtectedRoute><AppShell /></ProtectedRoute>}>
        <Route index element={<Dashboard />} />
        <Route path="profile" element={<ProfilePage />} />
        {/* Employees = HR/Admin management only. Employees use My Profile (ESS). */}
        <Route path="employees" element={<ProtectedRoute roles={['super_admin','hr_manager']}><EmployeesHome /></ProtectedRoute>} />
        <Route path="employees/new" element={<ProtectedRoute roles={['super_admin','hr_manager']}><EmployeeForm /></ProtectedRoute>} />
        <Route path="employees/:id" element={<ProtectedRoute roles={['super_admin','hr_manager']}><EmployeeDetail /></ProtectedRoute>} />
        <Route path="employees/:id/edit" element={<ProtectedRoute roles={['super_admin','hr_manager']}><EmployeeForm /></ProtectedRoute>} />
        <Route path="employees/:id/profile" element={<ProtectedRoute roles={['super_admin','hr_manager']}><ProfilePage /></ProtectedRoute>} />
        <Route path="hr-verification" element={<ProtectedRoute roles={['super_admin','hr_manager']}><HRVerificationPage /></ProtectedRoute>} />
        <Route path="celebrations" element={<ProtectedRoute roles={['super_admin','hr_manager']}><CelebrationsPage /></ProtectedRoute>} />
        <Route path="cancellation-requests" element={<ProtectedRoute roles={['super_admin','hr_manager']}><CancellationRequestsPage /></ProtectedRoute>} />
        <Route path="attendance" element={<AttendancePage />} />
        <Route path="historical-attendance" element={<ProtectedRoute roles={['super_admin','hr_manager']}><HistoricalAttendancePage /></ProtectedRoute>} />
        <Route path="attendance-requests" element={<AttendanceRequestsPage />} />
        <Route path="early-logout" element={<AttendanceRequestsPage kind="early_logout" />} />
        <Route path="historical-attendance-requests" element={<HistoricalAttendanceRequestsPage />} />
        <Route path="holidays" element={<HolidaysPage />} />
        <Route path="leave" element={<LeavePage />} />
        <Route path="comp-off" element={<CompOffPage />} />
        <Route path="late-login" element={<LateLoginPage />} />
        <Route path="leave-opening-balance" element={<ProtectedRoute roles={['super_admin','hr_manager']}><LeaveOpeningBalancePage /></ProtectedRoute>} />
        {/* Shift History = HR/Admin only. Effective-dated shift assignments per employee. */}
        <Route path="shift-history" element={<ProtectedRoute roles={['super_admin','hr_manager']}><ShiftHistoryPage /></ProtectedRoute>} />
        <Route path="payroll" element={<PayrollPage />} />
        <Route path="payroll-dashboard" element={<ProtectedRoute roles={['super_admin','hr_manager']}><PayrollDashboardPage /></ProtectedRoute>} />
        <Route path="payroll-automation" element={<ProtectedRoute roles={['super_admin','hr_manager']}><AutomationPage /></ProtectedRoute>} />
        {/* Salary Structure = HR/Admin only. Employees see their pay via My Payslips. */}
        <Route path="salary-structure" element={<ProtectedRoute roles={['super_admin','hr_manager']}><SalaryStructurePage /></ProtectedRoute>} />
        <Route path="advance-salary" element={<AdvanceSalaryPage />} />
        <Route path="payroll-settings" element={<ProtectedRoute roles={['super_admin']}><PayrollSettingsPage /></ProtectedRoute>} />
        <Route path="pt-master" element={<ProtectedRoute roles={['super_admin','hr_manager']}><PTMasterPage /></ProtectedRoute>} />
        <Route path="recruitment" element={<RecruitmentPage />} />
        <Route path="performance" element={<PerformancePage />} />
        <Route path="goals" element={<GoalsPage />} />
        <Route path="tax-declarations" element={<TaxDeclarationPage />} />
        {/* Documents: HR sees all (management); an employee sees ONLY their own —
            the page and the /api/documents backend both self-scope by role. */}
        <Route path="documents" element={<DocumentsPage />} />
        {/* Activities: withdrawn for EVERY role, not gated by one.

            The feed is company-wide and carries payroll_generated events with
            other employees' names, PT and net salary. It was briefly gated to
            super_admin/hr_manager; it is now closed to all while the backend
            exposure is fixed separately.

            A plain redirect rather than ProtectedRoute with an empty role list:
            the redirect does not depend on auth state resolving, so it cannot
            flash the page before a role check completes. ActivitiesPage is the
            only caller of GET /api/activity in the UI, so never mounting it
            also stops that request being made.

            Restoring this later means putting the ProtectedRoute back — the
            page component is untouched. */}
        <Route path="activities" element={<Navigate to="/" replace />} />
        <Route path="company-settings" element={<ProtectedRoute roles={['super_admin']}><CompanySettingsPage /></ProtectedRoute>} />
        <Route path="import-export" element={<ProtectedRoute roles={['super_admin','hr_manager']}><ImportExportPage /></ProtectedRoute>} />
        <Route path="web-checkin-access" element={<ProtectedRoute roles={['super_admin','hr_manager']}><WebCheckInAccessPage /></ProtectedRoute>} />
        {/* RBAC Phase E — Administration RBAC UI (route + granular permission gated; backend enforces) */}
        <Route path="users" element={<ProtectedRoute permission="users.view"><UsersPage /></ProtectedRoute>} />
        <Route path="roles-permissions" element={<ProtectedRoute permission="roles.view"><RolesPermissionsPage /></ProtectedRoute>} />
        <Route path="audit-logs" element={<ProtectedRoute permission="audit.view"><AuditLogsPage /></ProtectedRoute>} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

export default function App() {
  // Reloads this tab when a newer build is deployed, but only while the user
  // is not looking at it. Session-safe: its only effect is location.reload().
  useVersionCheck();

  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <BrowserRouter>
          <AppRoutes />
          <Toaster position="top-right" toastOptions={{ duration: 4000, style: { borderRadius: '10px', fontSize: '14px' } }} />
        </BrowserRouter>
      </AuthProvider>
    </QueryClientProvider>
  );
}
