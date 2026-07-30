import { useAuth } from '../../context/AuthContext';
import AdminDashboard from './AdminDashboard';
import EmployeeDashboard from './EmployeeDashboard';

// Thin router: HR / super-admins get the operational admin dashboard; everyone
// else gets the employee dashboard. Each is powered by a single summary API.
export default function Dashboard() {
  const { isHR } = useAuth();
  return isHR() ? <AdminDashboard /> : <EmployeeDashboard />;
}
