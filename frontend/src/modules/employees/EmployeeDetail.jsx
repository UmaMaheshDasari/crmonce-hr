import { useParams, Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { employeeApi, attendanceApi, documentApi } from '../../api/endpoints';
import { PencilIcon, ChevronRightIcon, EnvelopeIcon, PhoneIcon, MapPinIcon, CalendarIcon, BuildingOfficeIcon, BriefcaseIcon, IdentificationIcon, ClockIcon, DocumentTextIcon } from '@heroicons/react/24/outline';
import { useAuth } from '../../context/AuthContext';
import { format } from 'date-fns';

const STATUS_STYLES = {
  active: 'bg-emerald-50 text-emerald-700 ring-emerald-600/10',
  inactive: 'bg-gray-100 text-gray-600 ring-gray-500/10',
  on_leave: 'bg-amber-50 text-amber-700 ring-amber-600/10',
};

const STATUS_DOT = {
  active: 'bg-emerald-500',
  inactive: 'bg-gray-400',
  on_leave: 'bg-amber-500',
};

const AVATAR_GRADIENTS = [
  'from-indigo-500 to-purple-500',
  'from-emerald-500 to-teal-500',
  'from-amber-500 to-orange-500',
  'from-rose-500 to-pink-500',
  'from-blue-500 to-cyan-500',
  'from-violet-500 to-fuchsia-500',
];

function getAvatarGradient(name) {
  if (!name) return AVATAR_GRADIENTS[0];
  const hash = name.split('').reduce((acc, c) => acc + c.charCodeAt(0), 0);
  return AVATAR_GRADIENTS[hash % AVATAR_GRADIENTS.length];
}

export default function EmployeeDetail() {
  const { id } = useParams();
  const { isHR } = useAuth();

  const { data, isLoading } = useQuery({ queryKey: ['employee', id], queryFn: () => employeeApi.get(id) });
  const { data: docsData } = useQuery({ queryKey: ['documents', id], queryFn: () => documentApi.list({ employeeId: id }) });
  const { data: attData } = useQuery({ queryKey: ['attendance', id, 'recent'], queryFn: () => attendanceApi.list({ employeeId: id, limit: 5 }) });

  const emp = data?.data;

  if (isLoading) return (
    <div className="max-w-5xl space-y-6">
      <div className="bg-white rounded-2xl border border-gray-100 p-8 animate-pulse">
        <div className="flex items-center gap-6">
          <div className="w-24 h-24 bg-gray-100 rounded-full" />
          <div className="space-y-3">
            <div className="h-6 w-48 bg-gray-100 rounded-lg" />
            <div className="h-4 w-32 bg-gray-50 rounded-lg" />
          </div>
        </div>
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        <div className="bg-white rounded-xl border border-gray-100 p-6 h-56 animate-pulse" />
        <div className="bg-white rounded-xl border border-gray-100 p-6 h-56 animate-pulse" />
      </div>
    </div>
  );

  if (!emp) return (
    <div className="bg-white rounded-2xl border border-gray-100 p-16 text-center">
      <div className="w-16 h-16 bg-gray-50 rounded-2xl flex items-center justify-center mx-auto mb-4">
        <IdentificationIcon className="w-8 h-8 text-gray-300" />
      </div>
      <p className="text-gray-900 font-semibold mb-1">Employee not found</p>
      <p className="text-gray-400 text-sm">The employee you are looking for does not exist or has been removed.</p>
    </div>
  );

  const initials = emp.hr_hremployee1?.split(' ').map(n=>n[0]).join('').slice(0,2);

  return (
    <div className="space-y-6 max-w-5xl">
      {/* Breadcrumb */}
      <nav className="flex items-center gap-1.5 text-sm">
        <Link to="/employees" className="text-gray-400 hover:text-indigo-600 transition-colors font-medium">Employees</Link>
        <ChevronRightIcon className="w-3.5 h-3.5 text-gray-300" />
        <span className="text-gray-700 font-semibold">{emp.hr_hremployee1}</span>
      </nav>

      {/* Hero Section */}
      <div className="relative bg-white rounded-2xl border border-gray-100 overflow-hidden">
        {/* Subtle gradient header bg */}
        <div className="h-28 bg-gradient-to-br from-indigo-50 via-violet-50 to-purple-50" />
        <div className="px-8 pb-8">
          <div className="flex flex-col sm:flex-row sm:items-end gap-5 -mt-14">
            <div className={`w-24 h-24 bg-gradient-to-br ${getAvatarGradient(emp.hr_hremployee1)} rounded-2xl flex items-center justify-center ring-4 ring-white shadow-lg flex-shrink-0`}>
              <span className="text-white text-2xl font-bold">{initials}</span>
            </div>
            <div className="flex-1 pt-2">
              <div className="flex items-start justify-between flex-wrap gap-3">
                <div>
                  <h1 className="text-2xl font-bold text-gray-900">{emp.hr_hremployee1}</h1>
                  <p className="text-gray-500 text-sm mt-0.5 font-medium">{emp.hr_designation}</p>
                  <div className="flex items-center gap-3 mt-2.5">
                    <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 bg-indigo-50 text-indigo-700 text-xs font-semibold rounded-full">
                      <BuildingOfficeIcon className="w-3.5 h-3.5" />
                      {emp.hr_department || 'No department'}
                    </span>
                    <span className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 text-xs font-semibold rounded-full ring-1 ring-inset ${STATUS_STYLES[emp.hr_status] || 'bg-gray-100 text-gray-600 ring-gray-500/10'}`}>
                      <span className={`w-1.5 h-1.5 rounded-full ${STATUS_DOT[emp.hr_status] || 'bg-gray-400'}`} />
                      {emp.hr_status?.replace('_',' ')}
                    </span>
                  </div>
                </div>
                {isHR() && (
                  <Link to={`/employees/${id}/edit`} className="inline-flex items-center gap-2 px-5 py-2.5 bg-indigo-600 text-white text-sm font-semibold rounded-xl hover:bg-indigo-700 shadow-md shadow-indigo-200 hover:shadow-lg transition-all duration-200">
                    <PencilIcon className="w-4 h-4" /> Edit Employee
                  </Link>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Info Cards Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        {/* Personal Information */}
        <div className="bg-white rounded-xl border border-gray-100 p-6 hover:shadow-md transition-shadow duration-300">
          <h3 className="text-sm font-bold uppercase tracking-wider text-gray-400 mb-5">Personal Information</h3>
          <div className="space-y-4">
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 bg-blue-50 rounded-lg flex items-center justify-center flex-shrink-0">
                <EnvelopeIcon className="w-4 h-4 text-blue-500" />
              </div>
              <div>
                <p className="text-xs text-gray-400 font-medium">Email</p>
                <p className="text-sm text-gray-900 font-medium">{emp.hr_email || <span className="text-gray-300">&mdash;</span>}</p>
              </div>
            </div>
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 bg-emerald-50 rounded-lg flex items-center justify-center flex-shrink-0">
                <PhoneIcon className="w-4 h-4 text-emerald-500" />
              </div>
              <div>
                <p className="text-xs text-gray-400 font-medium">Phone</p>
                <p className="text-sm text-gray-900 font-medium">{emp.hr_phone || <span className="text-gray-300">&mdash;</span>}</p>
              </div>
            </div>
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 bg-violet-50 rounded-lg flex items-center justify-center flex-shrink-0">
                <MapPinIcon className="w-4 h-4 text-violet-500" />
              </div>
              <div>
                <p className="text-xs text-gray-400 font-medium">Address</p>
                <p className="text-sm text-gray-900 font-medium">{emp.hr_address || <span className="text-gray-300">&mdash;</span>}</p>
              </div>
            </div>
          </div>
        </div>

        {/* Employment Information */}
        <div className="bg-white rounded-xl border border-gray-100 p-6 hover:shadow-md transition-shadow duration-300">
          <h3 className="text-sm font-bold uppercase tracking-wider text-gray-400 mb-5">Employment Details</h3>
          <div className="space-y-4">
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 bg-indigo-50 rounded-lg flex items-center justify-center flex-shrink-0">
                <BuildingOfficeIcon className="w-4 h-4 text-indigo-500" />
              </div>
              <div>
                <p className="text-xs text-gray-400 font-medium">Department</p>
                <p className="text-sm text-gray-900 font-medium">{emp.hr_department || <span className="text-gray-300">&mdash;</span>}</p>
              </div>
            </div>
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 bg-amber-50 rounded-lg flex items-center justify-center flex-shrink-0">
                <BriefcaseIcon className="w-4 h-4 text-amber-500" />
              </div>
              <div>
                <p className="text-xs text-gray-400 font-medium">Designation</p>
                <p className="text-sm text-gray-900 font-medium">{emp.hr_designation || <span className="text-gray-300">&mdash;</span>}</p>
              </div>
            </div>
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 bg-rose-50 rounded-lg flex items-center justify-center flex-shrink-0">
                <IdentificationIcon className="w-4 h-4 text-rose-500" />
              </div>
              <div>
                <p className="text-xs text-gray-400 font-medium">Role</p>
                <p className="text-sm text-gray-900 font-medium">{emp.hr_role?.replace('_',' ') || <span className="text-gray-300">&mdash;</span>}</p>
              </div>
            </div>
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 bg-cyan-50 rounded-lg flex items-center justify-center flex-shrink-0">
                <CalendarIcon className="w-4 h-4 text-cyan-500" />
              </div>
              <div>
                <p className="text-xs text-gray-400 font-medium">Joining Date</p>
                <p className="text-sm text-gray-900 font-medium">{emp.hr_joiningdate ? format(new Date(emp.hr_joiningdate), 'dd MMM yyyy') : <span className="text-gray-300">&mdash;</span>}</p>
              </div>
            </div>
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 bg-teal-50 rounded-lg flex items-center justify-center flex-shrink-0">
                <ClockIcon className="w-4 h-4 text-teal-500" />
              </div>
              <div>
                <p className="text-xs text-gray-400 font-medium">eTime Code</p>
                <p className="text-sm text-gray-900 font-medium">{emp.hr_etime_code || <span className="text-gray-300">&mdash;</span>}</p>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Recent Attendance */}
      <div className="bg-white rounded-xl border border-gray-100 overflow-hidden hover:shadow-md transition-shadow duration-300">
        <div className="px-6 py-5 border-b border-gray-50">
          <h3 className="text-sm font-bold uppercase tracking-wider text-gray-400">Recent Attendance</h3>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="border-b border-gray-100">
                <th className="px-6 py-3.5 text-left text-xs font-semibold uppercase tracking-wider text-gray-400">Date</th>
                <th className="px-6 py-3.5 text-left text-xs font-semibold uppercase tracking-wider text-gray-400">In Time</th>
                <th className="px-6 py-3.5 text-left text-xs font-semibold uppercase tracking-wider text-gray-400">Out Time</th>
                <th className="px-6 py-3.5 text-left text-xs font-semibold uppercase tracking-wider text-gray-400">Hours</th>
                <th className="px-6 py-3.5 text-left text-xs font-semibold uppercase tracking-wider text-gray-400">Status</th>
              </tr>
            </thead>
            <tbody>
              {attData?.data?.data?.map(a => (
                <tr key={a.hr_hrattendanceid} className="border-b border-gray-50 hover:bg-gray-50/50 transition-colors">
                  <td className="px-6 py-4 text-sm text-gray-700 font-medium tabular-nums">{a.hr_date}</td>
                  <td className="px-6 py-4 text-sm text-gray-600 tabular-nums">{a.hr_intime || <span className="text-gray-300">&mdash;</span>}</td>
                  <td className="px-6 py-4 text-sm text-gray-600 tabular-nums">{a.hr_outtime || <span className="text-gray-300">&mdash;</span>}</td>
                  <td className="px-6 py-4 text-sm text-gray-600 tabular-nums">{a.hr_workedhours?.toFixed(1) || <span className="text-gray-300">&mdash;</span>}h</td>
                  <td className="px-6 py-4">
                    <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold ${
                      a.hr_status === 'present' ? 'bg-emerald-50 text-emerald-700' :
                      a.hr_status === 'absent' ? 'bg-red-50 text-red-700' : 'bg-amber-50 text-amber-700'
                    }`}>
                      <span className={`w-1.5 h-1.5 rounded-full ${
                        a.hr_status === 'present' ? 'bg-emerald-500' :
                        a.hr_status === 'absent' ? 'bg-red-500' : 'bg-amber-500'
                      }`} />
                      {a.hr_status}
                    </span>
                  </td>
                </tr>
              )) || (
                <tr><td colSpan={5} className="px-6 py-12 text-center text-sm text-gray-400">No attendance records found</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Documents */}
      <div className="bg-white rounded-xl border border-gray-100 p-6 hover:shadow-md transition-shadow duration-300">
        <div className="flex items-center justify-between mb-5">
          <h3 className="text-sm font-bold uppercase tracking-wider text-gray-400">Documents</h3>
          <span className="text-xs font-semibold text-gray-400 bg-gray-100 px-2.5 py-1 rounded-full">{docsData?.data?.data?.length || 0} files</span>
        </div>
        {docsData?.data?.data?.length ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {docsData.data.data.map(doc => (
              <a key={doc.hr_hrdocumentid} href={doc.hr_fileurl} target="_blank" rel="noreferrer"
                className="flex items-center gap-3 p-4 border border-gray-100 rounded-xl hover:bg-gray-50 hover:border-gray-200 hover:shadow-sm transition-all duration-200 group">
                <div className="w-10 h-10 bg-indigo-50 rounded-xl flex items-center justify-center flex-shrink-0 group-hover:bg-indigo-100 transition-colors">
                  <DocumentTextIcon className="w-5 h-5 text-indigo-500" />
                </div>
                <div className="overflow-hidden">
                  <p className="font-semibold text-gray-800 truncate text-sm">{doc.hr_name}</p>
                  <p className="text-xs text-gray-400 mt-0.5">{doc.hr_type}</p>
                </div>
              </a>
            ))}
          </div>
        ) : (
          <div className="text-center py-8">
            <DocumentTextIcon className="w-10 h-10 text-gray-200 mx-auto mb-2" />
            <p className="text-sm text-gray-400">No documents uploaded</p>
          </div>
        )}
      </div>
    </div>
  );
}
