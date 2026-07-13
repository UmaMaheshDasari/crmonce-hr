/**
 * Shared activity renderer for the Dashboard "Recent Activity" card and the
 * full "All Activities" page. Data comes from GET /api/activity (real events —
 * no hardcoded items). Categorized icon + colour by activity type.
 */

// type → { emoji, dot ring/bg colour } ; fall back by category
const STYLE = {
  web_checkin:           { icon: '🟢', dot: 'bg-emerald-500', ring: 'ring-emerald-500/20' },
  web_checkout:          { icon: '🔵', dot: 'bg-blue-500',    ring: 'ring-blue-500/20' },
  attendance_correction: { icon: '✏️', dot: 'bg-amber-500',   ring: 'ring-amber-500/20' },
  sync_completed:        { icon: '🔄', dot: 'bg-indigo-500',  ring: 'ring-indigo-500/20' },
  sync_failed:           { icon: '⚠️', dot: 'bg-red-500',     ring: 'ring-red-500/20' },
  leave_pending:         { icon: '📝', dot: 'bg-amber-500',   ring: 'ring-amber-500/20' },
  leave_approved:        { icon: '✅', dot: 'bg-emerald-500', ring: 'ring-emerald-500/20' },
  leave_rejected:        { icon: '❌', dot: 'bg-red-500',     ring: 'ring-red-500/20' },
  leave_cancelled:       { icon: '⚪', dot: 'bg-gray-400',    ring: 'ring-gray-400/20' },
  employee_added:        { icon: '👤', dot: 'bg-violet-500',  ring: 'ring-violet-500/20' },
  payroll_generated:     { icon: '💰', dot: 'bg-violet-500',  ring: 'ring-violet-500/20' },
  document_uploaded:     { icon: '📄', dot: 'bg-blue-500',    ring: 'ring-blue-500/20' },
};
const CATEGORY_STYLE = {
  Attendance: { icon: '⏱️', dot: 'bg-emerald-500', ring: 'ring-emerald-500/20' },
  Biometric:  { icon: '🔄', dot: 'bg-indigo-500',  ring: 'ring-indigo-500/20' },
  Leave:      { icon: '📝', dot: 'bg-amber-500',   ring: 'ring-amber-500/20' },
  Employee:   { icon: '👤', dot: 'bg-violet-500',  ring: 'ring-violet-500/20' },
  Payroll:    { icon: '💰', dot: 'bg-violet-500',  ring: 'ring-violet-500/20' },
  Documents:  { icon: '📄', dot: 'bg-blue-500',    ring: 'ring-blue-500/20' },
  System:     { icon: '⚙️', dot: 'bg-gray-400',    ring: 'ring-gray-400/20' },
};
const styleFor = (a) => STYLE[a.type] || CATEGORY_STYLE[a.category] || CATEGORY_STYLE.System;

function timeAgo(iso) {
  if (!iso) return '';
  const then = new Date(iso).getTime();
  if (isNaN(then)) return '';
  const s = Math.floor((Date.now() - then) / 1000);
  if (s < 45) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} hr ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  return new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
}

const subtitleOf = (a) => [a.name, a.meta].filter(Boolean).join(' · ');

export default function ActivityFeed({ items, loading, emptyText = 'No recent activity yet.' }) {
  if (loading) {
    return (
      <div className="space-y-5">
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="flex items-start gap-4 animate-pulse">
            <div className="w-[15px] h-[15px] rounded-full bg-gray-100 mt-0.5" />
            <div className="flex-1 space-y-2">
              <div className="h-3.5 w-48 bg-gray-100 rounded-full" />
              <div className="h-3 w-32 bg-gray-50 rounded-full" />
            </div>
          </div>
        ))}
      </div>
    );
  }

  if (!items?.length) {
    return <p className="text-sm text-gray-400 py-6 text-center">{emptyText}</p>;
  }

  return (
    <div className="relative">
      <div className="absolute left-[7px] top-2 bottom-2 w-px bg-gray-100" />
      <div className="space-y-5">
        {items.map((item) => {
          const s = styleFor(item);
          const sub = subtitleOf(item);
          return (
            <div key={item.id} className="flex items-start gap-4 relative group">
              <div className={`relative z-10 w-[15px] h-[15px] rounded-full ${s.dot} ring-4 ${s.ring} flex-shrink-0 mt-1 group-hover:scale-125 transition-transform duration-200`} />
              <div className="flex-1 flex items-start justify-between min-w-0 gap-4">
                <div className="min-w-0">
                  <p className="text-sm text-gray-800 font-semibold leading-snug flex items-center gap-1.5">
                    <span aria-hidden>{s.icon}</span>{item.title}
                  </p>
                  {sub && <p className="text-xs text-gray-500 mt-0.5 truncate">{sub}</p>}
                </div>
                <span className="text-xs text-gray-400 flex-shrink-0 mt-0.5 tabular-nums whitespace-nowrap">{timeAgo(item.time)}</span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
