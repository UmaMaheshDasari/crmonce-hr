import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { useNavigate, useParams, Link } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { employeeApi, documentApi } from '../../api/endpoints';
import { ChevronRightIcon, ArrowUpTrayIcon, CheckCircleIcon } from '@heroicons/react/24/outline';
import Button from '../../components/Button';
import toast from 'react-hot-toast';
import { useAuth } from '../../context/AuthContext';
import { BLOOD_GROUPS, upper, panRule, aadhaarRule, ifscRule, accountRule, uanRule, esicRule, phoneRule } from '../../utils/validators';

const ROLES = ['employee', 'hr_manager', 'recruiter', 'super_admin'];
const SHIFTS = ['Morning Shift', 'General Shift', 'Noon Shift', 'Evening Shift'];
const DESIGNATIONS = ['Employee', 'Senior Employee', 'Team Lead', 'Manager', 'HR', 'Admin'];
const EMPLOYMENT_TYPES = ['Full-time', 'Part-time', 'Contract', 'Intern', 'Probation'];
const DEPARTMENTS = ['ADM', 'HR', 'IT', 'Finance', 'Sales', 'Marketing', 'Support'];

// NOTE: These field components are declared at module scope on purpose.
// Defining them inside the parent recreated their identity on every render,
// which remounted the underlying <input> DOM nodes. On the re-render that
// reset() triggers, react-hook-form repoints its ref to a fresh, empty DOM
// node without re-applying the stored value — so the Edit form appeared empty
// even though the API returned data. Stable components keep the inputs mounted.
function Field({ label, name, type = 'text', required, register, errors, rules, ...props }) {
  const registerOpts = { ...(required ? { required: `${label} is required` } : {}), ...(rules || {}) };
  return (
    <div className="space-y-1.5">
      <label className="block text-sm font-semibold text-gray-700">
        {label}
        {required && <span className="text-red-500 ml-0.5">*</span>}
      </label>
      <input
        type={type}
        className={`w-full h-11 px-4 bg-gray-50 border ${errors[name] ? 'border-red-300 ring-2 ring-red-100' : 'border-gray-200'} rounded-xl text-sm text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-400 focus:bg-white transition-all duration-200`}
        {...register(name, registerOpts)}
        {...props}
      />
      {errors[name] && <p className="text-xs text-red-500 font-medium">{errors[name].message}</p>}
    </div>
  );
}

function SelectField({ label, name, register, children }) {
  return (
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
}

export default function EmployeeForm() {
  const { id } = useParams();
  const isEdit = Boolean(id);
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { user } = useAuth();
  const isHR = ['super_admin', 'hr_manager'].includes(user?.role);
  const isSelf = isEdit && user?.id === id;
  const selfMode = isEdit && !isHR && isSelf;   // employee editing their own record

  // An employee may only reach the edit screen for their OWN record.
  useEffect(() => {
    if (isEdit && !isHR && !isSelf) navigate('/', { replace: true });
  }, [isEdit, isHR, isSelf, navigate]);
  const { register, handleSubmit, reset, setValue, watch, formState: { errors, isSubmitting } } = useForm({
    defaultValues: { hr_shiftname: 'General Shift', hr_shiftstarttime: '09:00', hr_shiftendtime: '18:00' },
  });
  const [uploadingCheque, setUploadingCheque] = useState(false);
  const chequeUrl = watch('hr_chequeurl');

  const { data: empData } = useQuery({
    queryKey: ['employee', id],
    queryFn: () => employeeApi.get(id),
    enabled: isEdit,
  });

  const { data: deptData } = useQuery({
    queryKey: ['departments'],
    queryFn: () => employeeApi.departments(),
  });
  // Active employees for the Reporting Manager lookup.
  const { data: empListData } = useQuery({
    queryKey: ['employees-min'],
    queryFn: () => employeeApi.list({ limit: 500, status: 'active' }),
  });
  const managers = (empListData?.data?.data || []).filter(e => e.hr_hremployeeid !== id);
  const deptOptions = Array.from(new Set([...(deptData?.data?.data || []).map(d => d.hr_hrdepartment1), ...DEPARTMENTS])).filter(Boolean);

  useEffect(() => {
    if (empData?.data) {
      const e = empData.data;
      reset({ hr_hremployee1: e.hr_hremployee1, hr_email: e.hr_email, hr_phone: e.hr_phone,
        hr_department: e.hr_department, hr_designation: e.hr_designation,
        hr_role: e.hr_role, hr_salary: e.hr_salary, hr_joiningdate: e.hr_joiningdate?.split('T')[0],
        hr_status: e.hr_status, hr_address: e.hr_address, hr_etimecode: e.hr_etimecode,
        hr_shiftname: e.hr_shiftname || 'General Shift', hr_shiftstarttime: e.hr_shiftstarttime || '09:00',
        hr_shiftendtime: e.hr_shiftendtime || '18:00',
        // Master
        managerId: e._hr_manager_value || '', hr_employmenttype: e.hr_employmenttype,
        hr_worklocation: e.hr_worklocation, hr_confirmationdate: e.hr_confirmationdate?.split('T')[0],
        hr_relievingdate: e.hr_relievingdate?.split('T')[0],
        // Identity
        hr_aadhaar: e.hr_aadhaar, hr_pan: e.hr_pan, hr_passport: e.hr_passport,
        hr_drivinglicence: e.hr_drivinglicence, hr_uan: e.hr_uan, hr_esic: e.hr_esic,
        hr_pfnumber: e.hr_pfnumber, hr_bloodgroup: e.hr_bloodgroup,
        hr_emergencycontact: e.hr_emergencycontact, hr_emergencyphone: e.hr_emergencyphone,
        // Bank
        hr_bankname: e.hr_bankname, hr_accountholder: e.hr_accountholder,
        hr_accountnumber: e.hr_accountnumber, hr_ifsc: e.hr_ifsc, hr_branch: e.hr_branch,
        hr_chequeurl: e.hr_chequeurl });
    }
  }, [empData, reset]);

  const mutation = useMutation({
    mutationFn: (data) => isEdit ? employeeApi.update(id, data) : employeeApi.create(data),
    onSuccess: () => {
      toast.success(selfMode ? 'Your details were saved!' : isEdit ? 'Employee updated!' : 'Employee created!');
      qc.invalidateQueries({ queryKey: ['employees'] });
      qc.invalidateQueries({ queryKey: ['employee', id] });
      navigate(selfMode ? `/employees/${id}` : '/employees');
    },
    onError: (err) => toast.error(err.response?.data?.error || 'Something went wrong'),
  });

  // Cancelled-cheque upload (edit mode only — needs an employee id to attach to).
  // Reuses the existing document upload; stores the returned URL on hr_chequeurl.
  const onChequeUpload = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploadingCheque(true);
    try {
      const fd = new FormData();
      fd.append('file', file);
      fd.append('employeeId', id);
      fd.append('type', 'Other');
      fd.append('name', 'Cancelled Cheque');
      const res = await documentApi.upload(fd);
      const url = res.data?.hr_fileurl;
      if (url) { setValue('hr_chequeurl', url, { shouldDirty: true }); toast.success('Cancelled cheque uploaded'); }
    } catch (err) {
      toast.error(err.response?.data?.error || 'Cheque upload failed');
    } finally {
      setUploadingCheque(false);
    }
  };

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      {/* Breadcrumb */}
      <nav className="flex items-center gap-1.5 text-sm">
        <Link to="/employees" className="text-gray-400 hover:text-indigo-600 transition-colors font-medium">Employees</Link>
        <ChevronRightIcon className="w-3.5 h-3.5 text-gray-300" />
        <span className="text-gray-700 font-semibold">{selfMode ? 'My Details' : isEdit ? 'Edit Employee' : 'New Employee'}</span>
      </nav>

      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-gray-900 tracking-tight">{selfMode ? 'My Details' : isEdit ? 'Edit Employee' : 'Add New Employee'}</h1>
        <p className="text-gray-400 text-sm mt-1 font-medium">{selfMode ? 'Add or update your personal, identity and bank details' : isEdit ? 'Update the employee information below' : 'Fill in the details to create a new employee record'}</p>
      </div>

      <form onSubmit={handleSubmit(d => mutation.mutate(d))} className="space-y-6">
        {/* Personal Information */}
        <div className="bg-white rounded-xl border border-gray-100 overflow-hidden">
          <div className="px-6 py-4 border-b border-gray-50">
            <h2 className="text-sm font-bold uppercase tracking-wider text-gray-400">Personal Details</h2>
          </div>
          <div className="p-6 space-y-5">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
              <Field label="Full Name" name="hr_hremployee1" required placeholder="John Smith" register={register} errors={errors} readOnly={selfMode} />
              <Field label="Email Address" name="hr_email" type="email" required placeholder="john@company.com" register={register} errors={errors} readOnly={selfMode} />
              <Field label="Phone Number" name="hr_phone" placeholder="+91 99999 99999" register={register} errors={errors} />
              <Field label="Joining Date" name="hr_joiningdate" type="date" register={register} errors={errors} />
            </div>
            <Field label="Address" name="hr_address" placeholder="Street, City, State, PIN" register={register} errors={errors} />
          </div>
        </div>

        {/* Employment Information (HR only) */}
        {!selfMode && (
        <div className="bg-white rounded-xl border border-gray-100 overflow-hidden">
          <div className="px-6 py-4 border-b border-gray-50">
            <h2 className="text-sm font-bold uppercase tracking-wider text-gray-400">Employment Details</h2>
          </div>
          <div className="p-6">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
              <Field label="Employee ID" name="hr_etimecode" placeholder="EMP1044 (eTime code)" register={register} errors={errors} />
              <SelectField label="Reporting Manager" name="managerId" register={register}>
                <option value="">— None —</option>
                {managers.map(m => <option key={m.hr_hremployeeid} value={m.hr_hremployeeid}>{m.hr_hremployee1}</option>)}
              </SelectField>
              <SelectField label="Department" name="hr_department" register={register}>
                <option value="">Select department</option>
                {deptOptions.map(d => <option key={d} value={d}>{d}</option>)}
              </SelectField>
              <SelectField label="Designation" name="hr_designation" register={register}>
                <option value="">Select designation</option>
                {DESIGNATIONS.map(d => <option key={d} value={d}>{d}</option>)}
              </SelectField>
              <SelectField label="Role" name="hr_role" register={register}>
                {ROLES.map(r => <option key={r} value={r}>{r.replace('_',' ')}</option>)}
              </SelectField>
              <SelectField label="Employment Type" name="hr_employmenttype" register={register}>
                <option value="">Select type</option>
                {EMPLOYMENT_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
              </SelectField>
              <SelectField label="Status" name="hr_status" register={register}>
                <option value="active">Active</option>
                <option value="inactive">Inactive</option>
                <option value="on_leave">On Leave</option>
              </SelectField>
              <Field label="Work Location" name="hr_worklocation" placeholder="Nellore" register={register} errors={errors} />
              <Field label="Confirmation Date" name="hr_confirmationdate" type="date" register={register} errors={errors} />
              <Field label="Relieving Date" name="hr_relievingdate" type="date" register={register} errors={errors} />
              <SelectField label="Shift Name" name="hr_shiftname" register={register}>
                {SHIFTS.map(s => <option key={s} value={s}>{s}</option>)}
              </SelectField>
              <Field label="Shift Start Time" name="hr_shiftstarttime" type="time" register={register} errors={errors} />
              <Field label="Shift End Time" name="hr_shiftendtime" type="time" register={register} errors={errors} />
            </div>
            <p className="text-xs text-gray-400 mt-2">Late is measured from Shift Start (+5&nbsp;min grace); Early Exit from Shift End; Overtime beyond 9&nbsp;effective&nbsp;hours.</p>
          </div>
        </div>
        )}

        {/* Compensation (HR only) */}
        {!selfMode && (
        <div className="bg-white rounded-xl border border-gray-100 overflow-hidden">
          <div className="px-6 py-4 border-b border-gray-50">
            <h2 className="text-sm font-bold uppercase tracking-wider text-gray-400">Compensation & System</h2>
          </div>
          <div className="p-6">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
              <Field label="Basic Salary" name="hr_salary" type="number" placeholder="50000" register={register} errors={errors} />
            </div>
          </div>
        </div>
        )}

        {/* Identity */}
        <div className="bg-white rounded-xl border border-gray-100 overflow-hidden">
          <div className="px-6 py-4 border-b border-gray-50">
            <h2 className="text-sm font-bold uppercase tracking-wider text-gray-400">Identity</h2>
          </div>
          <div className="p-6">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
              <Field label="Aadhaar Number" name="hr_aadhaar" required rules={aadhaarRule} placeholder="1234 5678 9012" maxLength={12} register={register} errors={errors} />
              <Field label="PAN Number" name="hr_pan" required rules={panRule} placeholder="ABCDE1234F" maxLength={10} onInput={upper} register={register} errors={errors} />
              <Field label="Passport Number" name="hr_passport" placeholder="A1234567" register={register} errors={errors} />
              <Field label="Driving Licence" name="hr_drivinglicence" placeholder="AP01 20200012345" register={register} errors={errors} />
              <Field label="UAN Number" name="hr_uan" rules={uanRule} placeholder="123456789012" maxLength={12} register={register} errors={errors} />
              <Field label="ESIC Number" name="hr_esic" rules={esicRule} placeholder="10 or 17 digits" register={register} errors={errors} />
              <Field label="PF Number" name="hr_pfnumber" placeholder="AP/HYD/1234567/000/0001234" register={register} errors={errors} />
              <SelectField label="Blood Group" name="hr_bloodgroup" register={register}>
                <option value="">Select</option>
                {BLOOD_GROUPS.map(b => <option key={b} value={b}>{b}</option>)}
              </SelectField>
              <Field label="Emergency Contact" name="hr_emergencycontact" placeholder="Contact name" register={register} errors={errors} />
              <Field label="Emergency Phone" name="hr_emergencyphone" rules={phoneRule} placeholder="+91 99999 99999" register={register} errors={errors} />
            </div>
          </div>
        </div>

        {/* Bank Details */}
        <div className="bg-white rounded-xl border border-gray-100 overflow-hidden">
          <div className="px-6 py-4 border-b border-gray-50">
            <h2 className="text-sm font-bold uppercase tracking-wider text-gray-400">Bank Details</h2>
          </div>
          <div className="p-6 space-y-5">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
              <Field label="Bank Name" name="hr_bankname" placeholder="State Bank of India" register={register} errors={errors} />
              <Field label="Account Holder Name" name="hr_accountholder" placeholder="As per bank records" register={register} errors={errors} />
              <Field label="Account Number" name="hr_accountnumber" rules={accountRule} placeholder="9-18 digits" maxLength={18} register={register} errors={errors} />
              <Field label="IFSC Code" name="hr_ifsc" rules={ifscRule} placeholder="SBIN0001234" maxLength={11} onInput={upper} register={register} errors={errors} />
              <Field label="Branch" name="hr_branch" placeholder="Branch name" register={register} errors={errors} />
            </div>
            {/* Cancelled Cheque upload */}
            <div className="space-y-1.5">
              <label className="block text-sm font-semibold text-gray-700">Cancelled Cheque</label>
              {isEdit ? (
                <div className="flex items-center gap-3 flex-wrap">
                  <label className="inline-flex items-center gap-2 h-11 px-4 bg-gray-50 border border-gray-200 rounded-xl text-sm text-gray-600 cursor-pointer hover:bg-gray-100 transition-colors">
                    <ArrowUpTrayIcon className="w-4 h-4" />
                    {uploadingCheque ? 'Uploading…' : 'Upload cheque (PDF/JPG/PNG)'}
                    <input type="file" accept=".pdf,.jpg,.jpeg,.png" className="hidden" onChange={onChequeUpload} disabled={uploadingCheque} />
                  </label>
                  {chequeUrl && (
                    <a href={chequeUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 text-sm font-medium text-emerald-600 hover:text-emerald-700">
                      <CheckCircleIcon className="w-4 h-4" /> View uploaded cheque
                    </a>
                  )}
                </div>
              ) : (
                <p className="text-xs text-gray-400">Create the employee first, then upload the cancelled cheque from the edit screen.</p>
              )}
              <input type="hidden" {...register('hr_chequeurl')} />
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
                <Field label="Password" name="password" type="password" required placeholder="Min 8 characters" register={register} errors={errors} />
              </div>
            </div>
          </div>
        )}

        {/* Action Buttons - Sticky Footer */}
        <div className="sticky bottom-0 bg-white/80 backdrop-blur-sm border-t border-gray-100 -mx-6 px-6 py-4 flex gap-3 justify-end rounded-b-xl">
          <Button type="button" variant="secondary" onClick={() => navigate(selfMode ? `/employees/${id}` : '/employees')}>Cancel</Button>
          <Button type="submit" loading={isSubmitting || mutation.isPending}>
            {isEdit ? 'Save Changes' : 'Create Employee'}
          </Button>
        </div>
      </form>
    </div>
  );
}
