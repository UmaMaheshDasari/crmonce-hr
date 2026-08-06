import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { Toaster } from 'react-hot-toast';
import { AuthProvider, useAuth } from './context/AuthContext';
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
import PayrollPage from './modules/payroll/PayrollPage';
import RecruitmentPage from './modules/recruitment/RecruitmentPage';
import PerformancePage from './modules/performance/PerformancePage';
import DocumentsPage from './modules/documents/DocumentsPage';
import TaxDeclarationPage from './modules/payroll/TaxDeclarationPage';
import PayrollSettingsPage from './modules/payroll/PayrollSettingsPage';
import SalaryStructurePage from './modules/payroll/SalaryStructurePage';
import AdvanceSalaryPage from './modules/payroll/AdvanceSalaryPage';
import PayrollDashboardPage from './modules/payroll/PayrollDashboardPage';
import GoalsPage from './modules/performance/GoalsPage';
import ApprovalAction from './modules/attendance/ApprovalAction';
import ActivitiesPage from './modules/activity/ActivitiesPage';
import CompanySettingsPage from './modules/company/CompanySettingsPage';
import ProfilePage from './modules/employees/ProfilePage';
import HRVerificationPage from './modules/employees/HRVerificationPage';

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, staleTime: 300000, refetchOnWindowFocus: false } },
});

function ProtectedRoute({ children, roles }) {
  const { user, loading } = useAuth();
  if (loading) return (
    <div className="flex items-center justify-center h-screen bg-gray-50">
      <div className="w-8 h-8 border-4 border-indigo-600 border-t-transparent rounded-full animate-spin" />
    </div>
  );
  if (!user) return <Navigate to="/login" replace />;
  if (roles && !roles.includes(user.role)) return <Navigate to="/" replace />;
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
        <Route path="attendance" element={<AttendancePage />} />
        <Route path="attendance-requests" element={<AttendanceRequestsPage />} />
        <Route path="holidays" element={<HolidaysPage />} />
        <Route path="leave" element={<LeavePage />} />
        <Route path="payroll" element={<PayrollPage />} />
        <Route path="payroll-dashboard" element={<ProtectedRoute roles={['super_admin','hr_manager']}><PayrollDashboardPage /></ProtectedRoute>} />
        <Route path="salary-structure" element={<SalaryStructurePage />} />
        <Route path="advance-salary" element={<AdvanceSalaryPage />} />
        <Route path="payroll-settings" element={<ProtectedRoute roles={['super_admin']}><PayrollSettingsPage /></ProtectedRoute>} />
        <Route path="recruitment" element={<RecruitmentPage />} />
        <Route path="performance" element={<PerformancePage />} />
        <Route path="goals" element={<GoalsPage />} />
        <Route path="tax-declarations" element={<TaxDeclarationPage />} />
        <Route path="documents" element={<DocumentsPage />} />
        <Route path="activities" element={<ActivitiesPage />} />
        <Route path="company-settings" element={<ProtectedRoute roles={['super_admin']}><CompanySettingsPage /></ProtectedRoute>} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

export default function App() {
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
