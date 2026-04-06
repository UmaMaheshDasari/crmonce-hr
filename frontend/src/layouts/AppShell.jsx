import { useState } from 'react';
import { Outlet, NavLink, useNavigate, useLocation } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import NotificationBell from '../components/NotificationBell';
import {
  HomeIcon, UsersIcon, ClockIcon, CurrencyDollarIcon,
  BriefcaseIcon, ChartBarIcon, DocumentTextIcon,
  Bars3Icon, XMarkIcon, ArrowRightOnRectangleIcon,
  CalendarDaysIcon, FlagIcon,
} from '@heroicons/react/24/outline';

const NAV = [
  { to: '/',            label: 'Dashboard',    icon: HomeIcon,            exact: true },
  { to: '/employees',   label: 'Employees',    icon: UsersIcon },
  { to: '/attendance',  label: 'Attendance',    icon: ClockIcon },
  { to: '/leave',       label: 'Leave',        icon: CalendarDaysIcon },
  { to: '/payroll',     label: 'Payroll',      icon: CurrencyDollarIcon,  roles: ['super_admin','hr_manager'] },
  { to: '/tax-declarations', label: 'Tax Declarations', icon: DocumentTextIcon },
  { to: '/recruitment', label: 'Recruitment',  icon: BriefcaseIcon },
  { to: '/performance', label: 'Performance',  icon: ChartBarIcon },
  { to: '/goals',       label: 'Goals',        icon: FlagIcon },
  { to: '/documents',   label: 'Documents',    icon: DocumentTextIcon },
];

const LABEL_MAP = {
  '/':            'Dashboard',
  '/employees':   'Employees',
  '/attendance':  'Attendance',
  '/leave':       'Leave',
  '/payroll':     'Payroll',
  '/tax-declarations': 'Tax Declarations',
  '/recruitment': 'Recruitment',
  '/performance': 'Performance',
  '/goals':       'Goals',
  '/documents':   'Documents',
};

function NavItem({ item, onClick }) {
  return (
    <NavLink
      to={item.to}
      end={item.exact}
      onClick={onClick}
      className={({ isActive }) =>
        `group flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-all duration-200 relative ${
          isActive
            ? 'bg-[#E84C88]/10 text-white'
            : 'text-slate-400 hover:bg-white/10 hover:text-slate-200'
        }`
      }
    >
      {({ isActive }) => (
        <>
          {/* Active left accent */}
          {isActive && (
            <span className="absolute left-0 top-1/2 -translate-y-1/2 w-[3px] h-5 bg-[#E84C88] rounded-r-full" />
          )}
          <item.icon className={`w-5 h-5 flex-shrink-0 ${isActive ? 'text-[#E84C88]' : 'text-slate-500 group-hover:text-slate-300'}`} />
          <span>{item.label}</span>
        </>
      )}
    </NavLink>
  );
}

export default function AppShell() {
  const { user, logout, hasRole } = useAuth();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const navigate = useNavigate();
  const location = useLocation();

  const visibleNav = NAV.filter(item => !item.roles || hasRole(...item.roles));

  const handleLogout = async () => {
    await logout();
    navigate('/login');
  };

  /* Determine current page label for breadcrumb */
  const currentPath = '/' + location.pathname.split('/')[1];
  const pageLabel = LABEL_MAP[currentPath] || 'Page';

  const Sidebar = ({ mobile = false }) => (
    <div className={`flex flex-col h-full ${mobile ? 'w-64' : 'w-64'}`} style={{ background: 'linear-gradient(180deg, #1B4F72 0%, #0E2F44 100%)' }}>
      {/* Logo area */}
      <div className="flex items-center gap-3 px-5 py-5">
        <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-[#E84C88] to-[#D81B60] flex items-center justify-center shadow-lg" style={{ boxShadow: '0 4px 12px rgba(232, 76, 136, 0.3)' }}>
          <span className="text-white text-sm font-bold tracking-tight">C</span>
        </div>
        <div>
          <span className="font-semibold text-white text-[15px] tracking-tight">CRMONCE</span>
          <span className="block text-[10px] text-slate-400 font-medium tracking-wide uppercase">(OPC) LTD</span>
        </div>
        {mobile && (
          <button onClick={() => setSidebarOpen(false)} className="ml-auto text-slate-500 hover:text-slate-300 transition-colors">
            <XMarkIcon className="w-5 h-5" />
          </button>
        )}
      </div>

      {/* Accent bar */}
      <div className="mx-5 h-px bg-gradient-to-r from-[#E84C88]/40 via-slate-700/50 to-transparent" />

      {/* Nav */}
      <nav className="flex-1 px-3 py-4 space-y-0.5 overflow-y-auto">
        <p className="px-3 pt-1 pb-2 text-[10px] font-semibold text-slate-500 uppercase tracking-widest">Menu</p>
        {visibleNav.map(item => (
          <NavItem key={item.to} item={item} onClick={() => mobile && setSidebarOpen(false)} />
        ))}
      </nav>

      {/* User section */}
      <div className="mx-3 h-px bg-slate-700/50" />
      <div className="px-3 py-4">
        <div className="flex items-center gap-3 px-3 py-2 mb-2">
          <div className="w-9 h-9 bg-gradient-to-br from-[#E84C88] to-[#D81B60] rounded-full flex items-center justify-center flex-shrink-0 shadow-lg" style={{ boxShadow: '0 4px 12px rgba(232, 76, 136, 0.25)' }}>
            <span className="text-white text-xs font-bold">
              {user?.name?.split(' ').map(n => n[0]).join('').slice(0,2).toUpperCase()}
            </span>
          </div>
          <div className="overflow-hidden">
            <p className="text-sm font-medium text-slate-200 truncate">{user?.name}</p>
            <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-slate-800/50 text-slate-400 capitalize mt-0.5">
              {user?.role?.replace('_', ' ')}
            </span>
          </div>
        </div>
        <button
          onClick={handleLogout}
          className="flex items-center gap-2 w-full px-3 py-2 text-sm text-slate-500 hover:text-rose-400 hover:bg-white/[0.04] rounded-lg transition-all duration-200"
        >
          <ArrowRightOnRectangleIcon className="w-4 h-4" />
          Sign out
        </button>
      </div>
    </div>
  );

  return (
    <div className="flex h-screen bg-gray-50 overflow-hidden">
      {/* Desktop sidebar */}
      <div className="hidden lg:flex flex-shrink-0">
        <Sidebar />
      </div>

      {/* Mobile sidebar overlay */}
      {sidebarOpen && (
        <div className="fixed inset-0 z-50 lg:hidden animate-fade-in">
          <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={() => setSidebarOpen(false)} />
          <div className="relative flex h-full w-64 animate-slide-up">
            <Sidebar mobile />
          </div>
        </div>
      )}

      {/* Main content */}
      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
        {/* Top bar */}
        <header className="bg-white border-b border-gray-200/60 px-6 py-3.5 flex items-center gap-4 flex-shrink-0">
          <button onClick={() => setSidebarOpen(true)} className="lg:hidden text-gray-400 hover:text-gray-600 transition-colors">
            <Bars3Icon className="w-6 h-6" />
          </button>

          {/* Breadcrumb */}
          <nav className="hidden sm:flex items-center gap-1.5 text-sm">
            <span className="text-gray-400">Home</span>
            <span className="text-gray-300">/</span>
            <span className="font-medium text-gray-700">{pageLabel}</span>
          </nav>

          <div className="flex-1" />

          {/* Right side */}
          <NotificationBell />
          <div className="w-px h-6 bg-gray-200" />
          <div className="w-8 h-8 bg-gradient-to-br from-[#E84C88] to-[#D81B60] rounded-full flex items-center justify-center cursor-pointer shadow-sm">
            <span className="text-white text-xs font-semibold">
              {user?.name?.split(' ').map(n => n[0]).join('').slice(0,2).toUpperCase()}
            </span>
          </div>
        </header>

        {/* Page content */}
        <main className="flex-1 overflow-y-auto p-6 bg-gray-50/80">
          <div className="animate-fade-in">
            <Outlet />
          </div>
        </main>
      </div>
    </div>
  );
}
