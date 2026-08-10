import { useState, useEffect } from 'react';
import { Outlet, NavLink, useNavigate, useLocation } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useAuth } from '../context/AuthContext';
import { companyApi } from '../api/endpoints';
import NotificationBell from '../components/NotificationBell';
import {
  HomeIcon, UsersIcon, ClockIcon, CurrencyDollarIcon,
  BriefcaseIcon, ChartBarIcon, DocumentTextIcon,
  Bars3Icon, XMarkIcon, ArrowRightOnRectangleIcon,
  CalendarDaysIcon, FlagIcon, ChevronDoubleLeftIcon, ChevronDoubleRightIcon, ChevronDownIcon, PencilSquareIcon,
  BuildingOffice2Icon, UserCircleIcon, ShieldCheckIcon, BanknotesIcon, TableCellsIcon, BoltIcon, ScaleIcon,
  Squares2X2Icon, ArrowPathIcon, GiftIcon, XCircleIcon,
} from '@heroicons/react/24/outline';

// Grouped navigation. Standalone items have `to`; groups have `group` + `children`.
// Routes, icons and per-item `roles` are unchanged — only the organisation differs.
// (The existing "Payroll" page is kept as the first Payroll child so its route
//  stays reachable from the sidebar.)
const NAV = [
  { to: '/',        label: 'Dashboard',  icon: HomeIcon, exact: true },
  { to: '/profile', label: 'My Profile', icon: UserCircleIcon },
  {
    group: 'Employees', icon: UsersIcon, children: [
      { to: '/employees',       label: 'Employees',       icon: UsersIcon, roles: ['super_admin', 'hr_manager'] },
      { to: '/hr-verification', label: 'HR Verification', icon: ShieldCheckIcon, roles: ['super_admin', 'hr_manager'] },
      { to: '/cancellation-requests', label: 'Cancellation Requests', icon: XCircleIcon, roles: ['super_admin', 'hr_manager'] },
      { to: '/celebrations',    label: 'Celebrations',    icon: GiftIcon, roles: ['super_admin', 'hr_manager'] },
      { to: '/documents',       label: 'Documents',       icon: DocumentTextIcon, roles: ['super_admin', 'hr_manager'] },
      { to: '/leave-opening-balance', label: 'Leave Opening Balance', icon: TableCellsIcon, roles: ['super_admin', 'hr_manager'] },
      { to: '/recruitment',     label: 'Recruitment',     icon: BriefcaseIcon },
    ],
  },
  {
    group: 'Attendance', icon: ClockIcon, children: [
      { to: '/attendance',          label: 'Attendance',          icon: ClockIcon },
      { to: '/historical-attendance', label: 'Historical Attendance', icon: TableCellsIcon, roles: ['super_admin', 'hr_manager'] },
      { to: '/attendance-requests', label: 'Attendance Requests', icon: PencilSquareIcon },
      { to: '/historical-attendance-requests', label: 'Historical Requests', icon: ClockIcon },
    ],
  },
  {
    group: 'Leave', icon: CalendarDaysIcon, children: [
      { to: '/leave',               label: 'Leave',               icon: CalendarDaysIcon },
      { to: '/late-login',          label: 'Late Login',          icon: ClockIcon },
      { to: '/comp-off',            label: 'Comp Off',            icon: ArrowPathIcon },
      { to: '/holidays',            label: 'Holidays',            icon: CalendarDaysIcon },
    ],
  },
  {
    group: 'Payroll', icon: CurrencyDollarIcon, children: [
      { to: '/payroll',            label: 'Payroll',            icon: CurrencyDollarIcon },
      { to: '/payroll-dashboard',  label: 'Payroll Dashboard',  icon: ChartBarIcon, roles: ['super_admin', 'hr_manager'] },
      { to: '/payroll-automation', label: 'Payroll Automation', icon: BoltIcon, roles: ['super_admin', 'hr_manager'] },
      { to: '/salary-structure',   label: 'Salary Structure',   icon: BanknotesIcon },
      { to: '/advance-salary',     label: 'Advance Salary',     icon: BanknotesIcon },
      { to: '/pt-master',          label: 'Professional Tax',   icon: ScaleIcon, roles: ['super_admin', 'hr_manager'] },
      // 'Payroll Settings' is intentionally NOT a standalone entry — it lives inside
      // Company Settings → Payroll & Policies (Super Admin), so it has ONE nav home.
      // Its /payroll-settings route is preserved for deep links / backward compat.
      { to: '/tax-declarations',   label: 'Tax Declarations',   icon: DocumentTextIcon },
    ],
  },
  {
    group: 'Performance', icon: ChartBarIcon, children: [
      { to: '/performance', label: 'Performance', icon: ChartBarIcon },
      { to: '/goals',       label: 'Goals',       icon: FlagIcon },
    ],
  },
  {
    group: 'Administration', icon: Squares2X2Icon, children: [
      { to: '/import-export',    label: 'Import / Export',  icon: TableCellsIcon, roles: ['super_admin', 'hr_manager'] },
      { to: '/company-settings', label: 'Company Settings', icon: BuildingOffice2Icon, roles: ['super_admin'] },
    ],
  },
];

const LABEL_MAP = {
  '/':            'Dashboard',
  '/profile':     'My Profile',
  '/employees':   'Employees',
  '/hr-verification': 'HR Verification',
  '/cancellation-requests': 'Cancellation Requests',
  '/celebrations': 'Celebrations',
  '/attendance':  'Attendance',
  '/attendance-requests': 'Attendance Requests',
  '/historical-attendance-requests': 'Historical Requests',
  '/leave':       'Leave',
  '/late-login':  'Late Login',
  '/historical-attendance': 'Historical Attendance',
  '/comp-off':    'Comp Off',
  '/leave-opening-balance': 'Leave Opening Balance',
  '/holidays':    'Holidays',
  '/payroll':     'Payroll',
  '/payroll-dashboard': 'Payroll Dashboard',
  '/payroll-automation': 'Payroll Automation',
  '/salary-structure': 'Salary Structure',
  '/advance-salary': 'Advance Salary',
  '/pt-master': 'Professional Tax',
  '/payroll-settings': 'Payroll Settings',
  '/tax-declarations': 'Tax Declarations',
  '/recruitment': 'Recruitment',
  '/performance': 'Performance',
  '/goals':       'Goals',
  '/documents':   'Documents',
  '/activities':  'Activity',
  '/import-export': 'Import / Export',
  '/company-settings': 'Company Settings',
};

function NavItem({ item, collapsed, indented, onClick }) {
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
        `${collapsed ? 'justify-center px-0' : (indented ? 'gap-3 pl-11 pr-3' : 'gap-3 px-4')} ` +
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

// A collapsible parent menu with indented children. Stateless: `open`/`onToggle`
// are lifted to AppShell so expansion survives re-renders. Highlights when it
// contains the active route.
function NavGroup({ item, open, onToggle, containsActive, onNavigate }) {
  return (
    <div>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className={`group w-full flex items-center gap-3 h-11 px-4 rounded-lg text-[14px] transition-colors duration-200 cursor-pointer ` +
          `outline-none focus-visible:ring-2 focus-visible:ring-[#E84C88]/50 focus-visible:ring-inset ` +
          (containsActive ? 'text-white font-semibold' : 'text-slate-300/80 font-medium hover:bg-white/[0.06] hover:text-white')}
      >
        <item.icon className={`w-[18px] h-[18px] flex-shrink-0 ${containsActive ? 'text-[#E84C88]' : 'text-slate-400 group-hover:text-slate-200'}`} aria-hidden />
        <span className="truncate flex-1 text-left">{item.group}</span>
        <ChevronDownIcon className={`w-4 h-4 flex-shrink-0 text-slate-400 transition-transform duration-200 ${open ? 'rotate-180' : ''}`} aria-hidden />
      </button>
      {/* Accordion body — smooth 250ms open/close via grid-rows 0fr→1fr. */}
      <div className={`grid transition-all duration-[250ms] ease-in-out ${open ? 'grid-rows-[1fr] opacity-100 mt-1' : 'grid-rows-[0fr] opacity-0'}`}>
        <div className="overflow-hidden space-y-1">
          {item.children.map(child => (
            <NavItem key={child.to} item={child} collapsed={false} indented onClick={onNavigate} />
          ))}
        </div>
      </div>
    </div>
  );
}

export default function AppShell() {
  const { user, logout, hasRole } = useAuth();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem('sidebarCollapsed') === '1');
  const toggleCollapsed = () => setCollapsed(c => { localStorage.setItem('sidebarCollapsed', c ? '0' : '1'); return !c; });
  const [expandedMenu, setExpandedMenu] = useState(null);   // accordion: at most ONE open group
  const navigate = useNavigate();
  const location = useLocation();

  // Company identity comes from Company Settings — never hardcoded.
  const { data: companyRes } = useQuery({ queryKey: ['company'], queryFn: companyApi.get, staleTime: 600000 });
  const company = companyRes?.data;
  const companyName = company?.hr_name || 'CRMONCE (OPC) PRIVATE LIMITED';
  const companyLogo = company?.hr_logourl || '/crmonce-logo.png';

  // Role visibility. Groups keep only the children the user may see; a group with
  // no visible children is hidden entirely. Standalone items filter as before.
  const visibleNav = NAV.map(item => {
    if (item.children) {
      const kids = item.children.filter(c => !c.roles || hasRole(...c.roles));
      return kids.length ? { ...item, children: kids } : null;
    }
    return (!item.roles || hasRole(...item.roles)) ? item : null;
  }).filter(Boolean);
  // Flattened leaf items (icons only) for the collapsed rail.
  const flatNav = visibleNav.flatMap(item => item.children ? item.children : [item]);

  const handleLogout = async () => {
    await logout();
    navigate('/login');
  };

  /* Determine current page label for breadcrumb */
  const currentPath = '/' + location.pathname.split('/')[1];
  const pageLabel = LABEL_MAP[currentPath] || 'Page';

  // Accordion: exactly one group open at a time. On navigation, auto-open the group
  // that holds the active route (and collapse all others). A user toggle switches
  // the single open group; clicking the open one collapses it.
  const groupContainsActive = (item) => item.children.some(c => c.to === currentPath);
  useEffect(() => {
    const active = NAV.find(i => i.children && i.children.some(c => c.to === currentPath));
    setExpandedMenu(active ? active.group : null);
  }, [currentPath]);
  const isGroupOpen = (item) => expandedMenu === item.group;
  const toggleGroup = (item) => setExpandedMenu(cur => (cur === item.group ? null : item.group));

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
        <div className="w-10 h-10 flex-shrink-0 rounded-xl bg-white flex items-center justify-center overflow-hidden" style={{ boxShadow: '0 4px 12px rgba(0,0,0,0.15)' }}>
          <img src={companyLogo} alt={companyName} className="w-full h-full object-contain p-0.5"
            onError={(e) => { e.currentTarget.style.display = 'none'; }} />
        </div>
        {!isCollapsed && (
          <div className="min-w-0 leading-tight">
            <span className="block font-semibold text-white text-[15px] tracking-tight truncate">{companyName.split('(')[0].trim()}</span>
            <span className="block text-[11px] text-slate-400 font-medium tracking-wide uppercase truncate">HR System</span>
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
          {isCollapsed
            ? flatNav.map(item => (
                <NavItem key={item.to} item={item} collapsed onClick={() => mobile && setSidebarOpen(false)} />
              ))
            : visibleNav.map(item => item.children
                ? <NavGroup key={item.group} item={item} open={isGroupOpen(item)} containsActive={groupContainsActive(item)}
                    onToggle={() => toggleGroup(item)} onNavigate={() => mobile && setSidebarOpen(false)} />
                : <NavItem key={item.to} item={item} collapsed={false} onClick={() => mobile && setSidebarOpen(false)} />)}
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
        <main className="flex-1 overflow-y-auto overscroll-contain p-3 sm:p-4 bg-gray-50/80">
          <div className="animate-fade-in">
            <Outlet />
          </div>
        </main>
      </div>
    </div>
  );
}
