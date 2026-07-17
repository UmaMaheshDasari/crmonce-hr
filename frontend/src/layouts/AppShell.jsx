import { useState } from 'react';
import { Outlet, NavLink, useNavigate, useLocation } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import NotificationBell from '../components/NotificationBell';
import {
  HomeIcon, UsersIcon, ClockIcon, CurrencyDollarIcon,
  BriefcaseIcon, ChartBarIcon, DocumentTextIcon,
  Bars3Icon, XMarkIcon, ArrowRightOnRectangleIcon,
  CalendarDaysIcon, FlagIcon, ChevronDoubleLeftIcon, ChevronDoubleRightIcon,
} from '@heroicons/react/24/outline';

const NAV = [
  { to: '/',            label: 'Dashboard',    icon: HomeIcon,            exact: true },
  { to: '/employees',   label: 'Employees',    icon: UsersIcon },
  { to: '/attendance',  label: 'Attendance',    icon: ClockIcon },
  { to: '/leave',       label: 'Leave',        icon: CalendarDaysIcon },
  { to: '/payroll',     label: 'Payroll',      icon: CurrencyDollarIcon },
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

function NavItem({ item, collapsed, onClick }) {
  return (
    <NavLink
      to={item.to}
      end={item.exact}
      onClick={onClick}
      title={collapsed ? item.label : undefined}
      aria-label={item.label}
      className={({ isActive }) =>
        `group relative flex items-center h-11 rounded-lg text-[14px] transition-colors duration-200 cursor-pointer ` +
        `outline-none focus-visible:ring-2 focus-visible:ring-[#E84C88]/50 focus-visible:ring-inset ` +
        `${collapsed ? 'justify-center px-0' : 'gap-3 px-4'} ` +
        (isActive
          ? 'bg-[#E84C88]/[0.12] text-white font-semibold'
          : 'text-slate-300/80 font-medium hover:bg-white/[0.06] hover:text-white')
      }
    >
      {({ isActive }) => (
        <>
          {isActive && (
            <span className="absolute left-0 top-1/2 -translate-y-1/2 h-6 w-[3px] rounded-r-full bg-[#E84C88]" aria-hidden />
          )}
          <item.icon
            className={`w-[18px] h-[18px] flex-shrink-0 ${isActive ? 'text-[#E84C88]' : 'text-slate-400 group-hover:text-slate-200'}`}
            aria-hidden
          />
          {!collapsed && <span className="truncate">{item.label}</span>}
        </>
      )}
    </NavLink>
  );
}

export default function AppShell() {
  const { user, logout, hasRole } = useAuth();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem('sidebarCollapsed') === '1');
  const toggleCollapsed = () => setCollapsed(c => { localStorage.setItem('sidebarCollapsed', c ? '0' : '1'); return !c; });
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

  const Sidebar = ({ mobile = false }) => {
    const isCollapsed = collapsed && !mobile;   // collapse only on desktop; drawer is always full
    const initials = user?.name?.split(' ').map(n => n[0]).join('').slice(0, 2).toUpperCase();
    return (
    <nav
      aria-label="Primary"
      className={`relative flex flex-col h-full transition-[width] duration-200 ${mobile ? 'w-[250px]' : (isCollapsed ? 'w-[68px]' : 'lg:w-[220px] xl:w-[250px] w-[250px]')}`}
      style={{ background: 'linear-gradient(180deg, #1B4F72 0%, #0E2F44 100%)' }}
    >
      {/* Company header */}
      <div className={`flex items-center h-16 flex-shrink-0 ${isCollapsed ? 'justify-center px-0' : 'gap-3 px-4'}`}>
        <div className="w-10 h-10 flex-shrink-0 rounded-xl bg-gradient-to-br from-[#E84C88] to-[#D81B60] flex items-center justify-center" style={{ boxShadow: '0 4px 12px rgba(232, 76, 136, 0.3)' }}>
          <span className="text-white text-base font-bold tracking-tight">C</span>
        </div>
        {!isCollapsed && (
          <div className="min-w-0 leading-tight">
            <span className="block font-semibold text-white text-[16px] tracking-tight truncate">CRMONCE</span>
            <span className="block text-[11px] text-slate-400 font-medium tracking-wide uppercase truncate">(OPC) LTD</span>
          </div>
        )}
        {mobile && (
          <button onClick={() => setSidebarOpen(false)} aria-label="Close menu" className="ml-auto text-slate-400 hover:text-white transition-colors">
            <XMarkIcon className="w-5 h-5" />
          </button>
        )}
        {/* Desktop collapse toggle */}
        {!mobile && (
          <button
            onClick={toggleCollapsed}
            aria-label={isCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            title={isCollapsed ? 'Expand' : 'Collapse'}
            className={`${isCollapsed ? 'absolute -right-3 top-5 z-30 bg-[#0E2F44] border border-white/10 shadow-md' : 'ml-auto'} w-6 h-6 rounded-full flex items-center justify-center text-slate-400 hover:text-white hover:bg-white/10 transition-colors`}
          >
            {isCollapsed ? <ChevronDoubleRightIcon className="w-3.5 h-3.5" /> : <ChevronDoubleLeftIcon className="w-3.5 h-3.5" />}
          </button>
        )}
      </div>

      <div className="mx-3 h-px bg-white/[0.06]" />

      {/* Navigation */}
      <div className="flex-1 sidebar-scroll overflow-y-auto px-3 py-3">
        {!isCollapsed && (
          <p className="px-2 pb-1.5 text-[10px] font-semibold text-slate-500 uppercase tracking-widest">Menu</p>
        )}
        <div className="space-y-1">
          {visibleNav.map(item => (
            <NavItem key={item.to} item={item} collapsed={isCollapsed} onClick={() => mobile && setSidebarOpen(false)} />
          ))}
        </div>
      </div>

      {/* User profile + sign out */}
      <div className="flex-shrink-0 border-t border-white/[0.06] px-3 py-3 space-y-1">
        <div className={`flex items-center rounded-lg ${isCollapsed ? 'justify-center px-0 py-1' : 'gap-3 px-2 py-1.5'}`} title={isCollapsed ? `${user?.name} · ${user?.role?.replace('_', ' ')}` : undefined}>
          <div className="w-10 h-10 flex-shrink-0 bg-gradient-to-br from-[#E84C88] to-[#D81B60] rounded-full flex items-center justify-center" style={{ boxShadow: '0 4px 12px rgba(232, 76, 136, 0.25)' }}>
            <span className="text-white text-xs font-bold">{initials}</span>
          </div>
          {!isCollapsed && (
            <div className="min-w-0">
              <p className="text-[14px] font-semibold text-white truncate">{user?.name}</p>
              <p className="text-[12px] text-slate-400 capitalize truncate">{user?.role?.replace('_', ' ')}</p>
            </div>
          )}
        </div>
        <button
          onClick={handleLogout}
          title={isCollapsed ? 'Sign out' : undefined}
          aria-label="Sign out"
          className={`group flex items-center h-11 w-full rounded-lg text-[14px] font-medium text-slate-300/80 hover:bg-white/[0.06] hover:text-white transition-colors duration-200 cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-[#E84C88]/50 focus-visible:ring-inset ${isCollapsed ? 'justify-center px-0' : 'gap-3 px-4'}`}
        >
          <ArrowRightOnRectangleIcon className="w-[18px] h-[18px] flex-shrink-0 text-slate-400 group-hover:text-rose-400 transition-colors" aria-hidden />
          {!isCollapsed && <span>Sign out</span>}
        </button>
      </div>
    </nav>
    );
  };

  return (
    <div className="flex h-[100dvh] bg-gray-50 overflow-hidden">
      {/* Desktop sidebar */}
      <div className="hidden lg:flex flex-shrink-0">
        <Sidebar />
      </div>

      {/* Mobile sidebar overlay */}
      {sidebarOpen && (
        <div className="fixed inset-0 z-50 lg:hidden animate-fade-in">
          <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={() => setSidebarOpen(false)} />
          <div className="relative flex h-full w-[250px] animate-slide-up">
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
        <main className="flex-1 overflow-y-auto overscroll-contain p-4 sm:p-6 bg-gray-50/80">
          <div className="animate-fade-in">
            <Outlet />
          </div>
        </main>
      </div>
    </div>
  );
}
