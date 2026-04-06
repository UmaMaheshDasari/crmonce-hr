import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { employeeApi } from '../../api/endpoints';
import { MagnifyingGlassIcon, PlusIcon, EyeIcon, PencilSquareIcon, UserGroupIcon } from '@heroicons/react/24/outline';
import { useAuth } from '../../context/AuthContext';
import { format } from 'date-fns';

const AVATAR_GRADIENTS = [
  'from-indigo-500 to-purple-500',
  'from-emerald-500 to-teal-500',
  'from-amber-500 to-orange-500',
  'from-rose-500 to-pink-500',
  'from-blue-500 to-cyan-500',
  'from-violet-500 to-fuchsia-500',
  'from-lime-500 to-green-500',
  'from-red-500 to-rose-500',
];

const STATUS_DOT = {
  active: 'bg-emerald-500',
  inactive: 'bg-gray-400',
  on_leave: 'bg-amber-500',
};

const STATUS_LABEL = {
  active: 'text-emerald-700 bg-emerald-50',
  inactive: 'text-gray-600 bg-gray-100',
  on_leave: 'text-amber-700 bg-amber-50',
};

function getAvatarGradient(name) {
  if (!name) return AVATAR_GRADIENTS[0];
  const hash = name.split('').reduce((acc, c) => acc + c.charCodeAt(0), 0);
  return AVATAR_GRADIENTS[hash % AVATAR_GRADIENTS.length];
}

export default function EmployeeList() {
  const { isHR } = useAuth();
  const [search, setSearch] = useState('');
  const [dept, setDept] = useState('');
  const [status, setStatus] = useState('active');
  const [page, setPage] = useState(1);
  const limit = 15;

  const { data, isLoading } = useQuery({
    queryKey: ['employees', search, dept, status, page],
    queryFn: () => employeeApi.list({ search, department: dept, status, page, limit }),
    keepPreviousData: true,
  });

  const { data: deptData } = useQuery({
    queryKey: ['departments'],
    queryFn: () => employeeApi.departments(),
  });

  const employees = data?.data?.data || [];
  const total = data?.data?.count || 0;
  const totalPages = Math.ceil(total / limit);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 tracking-tight">Employees</h1>
          <p className="text-gray-400 text-sm mt-1 font-medium">{total} total employees</p>
        </div>
        {isHR() && (
          <Link to="/employees/new" className="inline-flex items-center gap-2 px-5 py-2.5 bg-indigo-600 text-white text-sm font-semibold rounded-xl hover:bg-indigo-700 shadow-md shadow-indigo-200 hover:shadow-lg hover:shadow-indigo-200 transition-all duration-200">
            <PlusIcon className="w-4 h-4" /> Add Employee
          </Link>
        )}
      </div>

      {/* Search & Filters */}
      <div className="bg-white rounded-xl border border-gray-100 p-4">
        <div className="flex flex-wrap gap-3 items-center">
          <div className="relative flex-1 min-w-[220px]">
            <MagnifyingGlassIcon className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-300" />
            <input
              className="w-full h-11 pl-11 pr-4 bg-gray-50 border border-gray-200 rounded-xl text-sm text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-400 focus:bg-white focus:shadow-lg focus:shadow-indigo-100/30 transition-all duration-200"
              placeholder="Search by name or email..."
              value={search}
              onChange={e => { setSearch(e.target.value); setPage(1); }}
            />
          </div>
          <select
            className="h-11 px-4 bg-gray-50 border border-gray-200 rounded-xl text-sm text-gray-600 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-400 transition-all duration-200 cursor-pointer"
            value={dept}
            onChange={e => { setDept(e.target.value); setPage(1); }}
          >
            <option value="">All Departments</option>
            {deptData?.data?.data?.map(d => <option key={d.hr_hrdepartmentid} value={d.hr_hrdepartment1}>{d.hr_hrdepartment1}</option>)}
          </select>
          <select
            className="h-11 px-4 bg-gray-50 border border-gray-200 rounded-xl text-sm text-gray-600 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-400 transition-all duration-200 cursor-pointer"
            value={status}
            onChange={e => { setStatus(e.target.value); setPage(1); }}
          >
            <option value="">All Status</option>
            <option value="active">Active</option>
            <option value="inactive">Inactive</option>
            <option value="on_leave">On Leave</option>
          </select>
        </div>
      </div>

      {/* Table */}
      <div className="bg-white rounded-xl border border-gray-100 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="border-b border-gray-100">
                <th className="px-6 py-4 text-left text-xs font-semibold uppercase tracking-wider text-gray-400">Employee</th>
                <th className="px-6 py-4 text-left text-xs font-semibold uppercase tracking-wider text-gray-400">Department</th>
                <th className="px-6 py-4 text-left text-xs font-semibold uppercase tracking-wider text-gray-400">Designation</th>
                <th className="px-6 py-4 text-left text-xs font-semibold uppercase tracking-wider text-gray-400">Joining Date</th>
                <th className="px-6 py-4 text-left text-xs font-semibold uppercase tracking-wider text-gray-400">Status</th>
                <th className="px-6 py-4 text-left text-xs font-semibold uppercase tracking-wider text-gray-400">Actions</th>
              </tr>
            </thead>
            <tbody>
              {isLoading ? (
                Array(8).fill(0).map((_, i) => (
                  <tr key={i} className="border-b border-gray-50">
                    {Array(6).fill(0).map((_, j) => (
                      <td key={j} className="px-6 py-5"><div className="h-4 bg-gray-50 rounded-lg animate-pulse" /></td>
                    ))}
                  </tr>
                ))
              ) : employees.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-6 py-20 text-center">
                    <div className="flex flex-col items-center">
                      <div className="w-16 h-16 bg-gray-50 rounded-2xl flex items-center justify-center mb-4">
                        <UserGroupIcon className="w-8 h-8 text-gray-300" />
                      </div>
                      <p className="text-gray-900 font-semibold mb-1">No employees found</p>
                      <p className="text-gray-400 text-sm mb-5">Try adjusting your search or filter criteria</p>
                      {isHR() && (
                        <Link to="/employees/new" className="inline-flex items-center gap-2 px-4 py-2 bg-indigo-600 text-white text-sm font-semibold rounded-lg hover:bg-indigo-700 transition-colors">
                          <PlusIcon className="w-4 h-4" /> Add Employee
                        </Link>
                      )}
                    </div>
                  </td>
                </tr>
              ) : (
                employees.map(emp => (
                  <tr key={emp.hr_hremployeeid} className="border-b border-gray-50 hover:bg-gray-50/50 transition-all duration-150 group">
                    <td className="px-6 py-4">
                      <div className="flex items-center gap-3">
                        <div className={`w-10 h-10 bg-gradient-to-br ${getAvatarGradient(emp.hr_hremployee1)} rounded-full flex items-center justify-center flex-shrink-0 shadow-sm`}>
                          <span className="text-white text-xs font-bold">
                            {emp.hr_hremployee1?.split(' ').map(n=>n[0]).join('').slice(0,2)}
                          </span>
                        </div>
                        <div>
                          <p className="font-semibold text-gray-900 text-sm">{emp.hr_hremployee1}</p>
                          <p className="text-xs text-gray-400 mt-0.5">{emp.hr_email}</p>
                        </div>
                      </div>
                    </td>
                    <td className="px-6 py-4">
                      <span className="text-sm text-gray-600">{emp.hr_department || <span className="text-gray-300">&mdash;</span>}</span>
                    </td>
                    <td className="px-6 py-4">
                      <span className="text-sm text-gray-600">{emp.hr_designation || <span className="text-gray-300">&mdash;</span>}</span>
                    </td>
                    <td className="px-6 py-4">
                      <span className="text-sm text-gray-500 tabular-nums">
                        {emp.hr_joiningdate ? format(new Date(emp.hr_joiningdate), 'dd MMM yyyy') : <span className="text-gray-300">&mdash;</span>}
                      </span>
                    </td>
                    <td className="px-6 py-4">
                      <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold ${STATUS_LABEL[emp.hr_status] || 'text-gray-600 bg-gray-100'}`}>
                        <span className={`w-1.5 h-1.5 rounded-full ${STATUS_DOT[emp.hr_status] || 'bg-gray-400'}`} />
                        {emp.hr_status?.replace('_', ' ')}
                      </span>
                    </td>
                    <td className="px-6 py-4">
                      <div className="flex items-center gap-1">
                        <Link
                          to={`/employees/${emp.hr_hremployeeid}`}
                          className="p-2 rounded-lg text-gray-400 hover:text-indigo-600 hover:bg-indigo-50 transition-all duration-150"
                          title="View details"
                        >
                          <EyeIcon className="w-4 h-4" />
                        </Link>
                        {isHR() && (
                          <Link
                            to={`/employees/${emp.hr_hremployeeid}/edit`}
                            className="p-2 rounded-lg text-gray-400 hover:text-amber-600 hover:bg-amber-50 transition-all duration-150"
                            title="Edit employee"
                          >
                            <PencilSquareIcon className="w-4 h-4" />
                          </Link>
                        )}
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {/* Pagination */}
        {totalPages > 1 && (
          <div className="px-6 py-4 border-t border-gray-100 flex items-center justify-between">
            <span className="text-sm text-gray-400 font-medium">
              Showing <span className="text-gray-700 font-semibold">{((page-1)*limit)+1}</span>&ndash;<span className="text-gray-700 font-semibold">{Math.min(page*limit, total)}</span> of <span className="text-gray-700 font-semibold">{total}</span>
            </span>
            <div className="flex gap-2">
              <button
                onClick={() => setPage(p => p-1)}
                disabled={page === 1}
                className="px-4 py-2 text-sm font-medium text-gray-600 bg-white border border-gray-200 rounded-lg hover:bg-gray-50 hover:border-gray-300 disabled:opacity-40 disabled:cursor-not-allowed transition-all duration-150"
              >
                Previous
              </button>
              <button
                onClick={() => setPage(p => p+1)}
                disabled={page >= totalPages}
                className="px-4 py-2 text-sm font-medium text-gray-600 bg-white border border-gray-200 rounded-lg hover:bg-gray-50 hover:border-gray-300 disabled:opacity-40 disabled:cursor-not-allowed transition-all duration-150"
              >
                Next
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
