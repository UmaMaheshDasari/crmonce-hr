/**
 * Consistent status badge used across the app (employee status, etc.).
 * Active / Inactive / Pending / On Leave — professional colors + dot.
 */
const STATUS = {
  active: { label: 'Active', cls: 'bg-emerald-50 text-emerald-700 ring-emerald-600/20', dot: 'bg-emerald-500' },
  inactive: { label: 'Inactive', cls: 'bg-gray-100 text-gray-600 ring-gray-500/20', dot: 'bg-gray-400' },
  pending: { label: 'Pending', cls: 'bg-amber-50 text-amber-700 ring-amber-600/20', dot: 'bg-amber-500' },
  on_leave: { label: 'On Leave', cls: 'bg-blue-50 text-blue-700 ring-blue-600/20', dot: 'bg-blue-500' },
  terminated: { label: 'Terminated', cls: 'bg-red-50 text-red-700 ring-red-600/20', dot: 'bg-red-500' },
};

export default function StatusBadge({ status, className = '' }) {
  const key = String(status || '').toLowerCase().replace(/\s+/g, '_');
  const c = STATUS[key] || { label: status ? String(status).replace(/_/g, ' ') : '—', cls: 'bg-gray-100 text-gray-600 ring-gray-500/20', dot: 'bg-gray-400' };
  return (
    <span className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-semibold ring-1 ring-inset ${c.cls} ${className}`}>
      <span className={`w-1.5 h-1.5 rounded-full ${c.dot}`} />
      {c.label}
    </span>
  );
}
