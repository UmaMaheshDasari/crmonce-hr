import { Navigate } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import EmployeeList from './EmployeeList';

/**
 * "Employees" landing page.
 *  - HR / admin  → full employee directory (EmployeeList).
 *  - Plain employee → their own profile only (they may not browse the whole
 *    company directory). Prevents the "Employee not found" dead-end and the
 *    directory data leak.
 */
export default function EmployeesHome() {
  const { isHR, user } = useAuth();
  if (!isHR()) {
    return user?.id ? <Navigate to={`/employees/${user.id}`} replace /> : null;
  }
  return <EmployeeList />;
}
