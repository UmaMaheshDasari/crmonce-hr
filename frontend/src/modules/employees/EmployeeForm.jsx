import { useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { useNavigate, useParams, Link } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { employeeApi } from '../../api/endpoints';
import { ChevronRightIcon } from '@heroicons/react/24/outline';
import toast from 'react-hot-toast';

const ROLES = ['employee', 'hr_manager', 'recruiter', 'super_admin'];

export default function EmployeeForm() {
  const { id } = useParams();
  const isEdit = Boolean(id);
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { register, handleSubmit, reset, formState: { errors, isSubmitting } } = useForm();

  const { data: empData } = useQuery({
    queryKey: ['employee', id],
    queryFn: () => employeeApi.get(id),
    enabled: isEdit,
  });

  const { data: deptData } = useQuery({
    queryKey: ['departments'],
    queryFn: () => employeeApi.departments(),
  });

  useEffect(() => {
    if (empData?.data) {
      const e = empData.data;
      reset({ hr_hremployee1: e.hr_hremployee1, hr_email: e.hr_email, hr_phone: e.hr_phone,
        hr_department: e.hr_department, hr_designation: e.hr_designation,
        hr_role: e.hr_role, hr_salary: e.hr_salary, hr_joiningdate: e.hr_joiningdate?.split('T')[0],
        hr_status: e.hr_status, hr_address: e.hr_address });
    }
  }, [empData, reset]);

  const mutation = useMutation({
    mutationFn: (data) => isEdit ? employeeApi.update(id, data) : employeeApi.create(data),
    onSuccess: () => {
      toast.success(isEdit ? 'Employee updated!' : 'Employee created!');
      qc.invalidateQueries(['employees']);
      navigate('/employees');
    },
    onError: (err) => toast.error(err.response?.data?.error || 'Something went wrong'),
  });

  const Field = ({ label, name, type = 'text', required, ...props }) => (
    <div className="space-y-1.5">
      <label className="block text-sm font-semibold text-gray-700">
        {label}
        {required && <span className="text-red-500 ml-0.5">*</span>}
      </label>
      <input
        type={type}
        className={`w-full h-11 px-4 bg-gray-50 border ${errors[name] ? 'border-red-300 ring-2 ring-red-100' : 'border-gray-200'} rounded-xl text-sm text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-400 focus:bg-white transition-all duration-200`}
        {...register(name, required ? { required: `${label} is required` } : {})}
        {...props}
      />
      {errors[name] && <p className="text-xs text-red-500 font-medium">{errors[name].message}</p>}
    </div>
  );

  const SelectField = ({ label, name, children }) => (
    <div className="space-y-1.5">
      <label className="block text-sm font-semibold text-gray-700">{label}</label>
      <select
        className="w-full h-11 px-4 bg-gray-50 border border-gray-200 rounded-xl text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-400 focus:bg-white transition-all duration-200 cursor-pointer appearance-none"
        {...register(name)}
      >
        {children}
      </select>
    </div>
  );

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      {/* Breadcrumb */}
      <nav className="flex items-center gap-1.5 text-sm">
        <Link to="/employees" className="text-gray-400 hover:text-indigo-600 transition-colors font-medium">Employees</Link>
        <ChevronRightIcon className="w-3.5 h-3.5 text-gray-300" />
        <span className="text-gray-700 font-semibold">{isEdit ? 'Edit Employee' : 'New Employee'}</span>
      </nav>

      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-gray-900 tracking-tight">{isEdit ? 'Edit Employee' : 'Add New Employee'}</h1>
        <p className="text-gray-400 text-sm mt-1 font-medium">{isEdit ? 'Update the employee information below' : 'Fill in the details to create a new employee record'}</p>
      </div>

      <form onSubmit={handleSubmit(d => mutation.mutate(d))} className="space-y-6">
        {/* Personal Information */}
        <div className="bg-white rounded-xl border border-gray-100 overflow-hidden">
          <div className="px-6 py-4 border-b border-gray-50">
            <h2 className="text-sm font-bold uppercase tracking-wider text-gray-400">Personal Details</h2>
          </div>
          <div className="p-6 space-y-5">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
              <Field label="Full Name" name="hr_hremployee1" required placeholder="John Smith" />
              <Field label="Email Address" name="hr_email" type="email" required placeholder="john@company.com" />
              <Field label="Phone Number" name="hr_phone" placeholder="+91 99999 99999" />
              <Field label="Joining Date" name="hr_joiningdate" type="date" />
            </div>
            <Field label="Address" name="hr_address" placeholder="Street, City, State, PIN" />
          </div>
        </div>

        {/* Employment Information */}
        <div className="bg-white rounded-xl border border-gray-100 overflow-hidden">
          <div className="px-6 py-4 border-b border-gray-50">
            <h2 className="text-sm font-bold uppercase tracking-wider text-gray-400">Employment Details</h2>
          </div>
          <div className="p-6">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
              <SelectField label="Department" name="hr_department">
                <option value="">Select department</option>
                {deptData?.data?.data?.map(d => <option key={d.hr_hrdepartmentid} value={d.hr_hrdepartment1}>{d.hr_hrdepartment1}</option>)}
              </SelectField>
              <Field label="Designation" name="hr_designation" placeholder="Software Engineer" />
              <SelectField label="Role" name="hr_role">
                {ROLES.map(r => <option key={r} value={r}>{r.replace('_',' ')}</option>)}
              </SelectField>
              <SelectField label="Status" name="hr_status">
                <option value="active">Active</option>
                <option value="inactive">Inactive</option>
                <option value="on_leave">On Leave</option>
              </SelectField>
            </div>
          </div>
        </div>

        {/* Compensation */}
        <div className="bg-white rounded-xl border border-gray-100 overflow-hidden">
          <div className="px-6 py-4 border-b border-gray-50">
            <h2 className="text-sm font-bold uppercase tracking-wider text-gray-400">Compensation & System</h2>
          </div>
          <div className="p-6">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
              <Field label="Basic Salary" name="hr_salary" type="number" placeholder="50000" />
              <Field label="eTime Office Code" name="hr_etime_code" placeholder="EMP001" />
            </div>
          </div>
        </div>

        {/* Password (new employee only) */}
        {!isEdit && (
          <div className="bg-white rounded-xl border border-gray-100 overflow-hidden">
            <div className="px-6 py-4 border-b border-gray-50">
              <h2 className="text-sm font-bold uppercase tracking-wider text-gray-400">Account Setup</h2>
            </div>
            <div className="p-6">
              <div className="max-w-sm">
                <Field label="Password" name="password" type="password" required placeholder="Min 8 characters" />
              </div>
            </div>
          </div>
        )}

        {/* Action Buttons - Sticky Footer */}
        <div className="sticky bottom-0 bg-white/80 backdrop-blur-sm border-t border-gray-100 -mx-6 px-6 py-4 flex gap-3 justify-end rounded-b-xl">
          <button
            type="button"
            onClick={() => navigate('/employees')}
            className="px-6 py-2.5 text-sm font-semibold text-gray-600 bg-white border border-gray-200 rounded-xl hover:bg-gray-50 hover:border-gray-300 transition-all duration-200"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={isSubmitting || mutation.isLoading}
            className="inline-flex items-center gap-2 px-6 py-2.5 bg-indigo-600 text-white text-sm font-semibold rounded-xl hover:bg-indigo-700 shadow-md shadow-indigo-200 hover:shadow-lg hover:shadow-indigo-200 disabled:opacity-50 disabled:cursor-not-allowed transition-all duration-200"
          >
            {(isSubmitting || mutation.isLoading) && (
              <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
            )}
            {isEdit ? 'Save Changes' : 'Create Employee'}
          </button>
        </div>
      </form>
    </div>
  );
}
