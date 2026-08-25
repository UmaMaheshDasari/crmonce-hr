import { useQuery } from '@tanstack/react-query';
import { celebrationsApi } from '../../api/endpoints';
import Avatar from '../../components/Avatar';

// Privacy: shows ONLY photo, name, employee id, department, designation — never the
// underlying Date of Birth / Marriage Date (the API doesn't return them).

function Person({ p, accent }) {
  return (
    <div className="flex items-center gap-3 rounded-xl border border-gray-100 bg-white px-3 py-2.5">
      <Avatar emp={p} name={p.name} className={`w-10 h-10 rounded-full flex-shrink-0 ${accent.bg}`} initialsClassName={`font-bold text-sm ${accent.text}`} />
      <div className="min-w-0">
        <p className="text-sm font-semibold text-gray-900 truncate">{p.name}
          {p.years ? <span className={`ml-1.5 text-[10px] font-bold px-1.5 py-0.5 rounded-full ${accent.bg} ${accent.text}`}>{p.years} yr{p.years === 1 ? '' : 's'}</span> : null}
        </p>
        <p className="text-[11px] text-gray-400 truncate">
          {p.employeeId ? `${p.employeeId} · ` : ''}{[p.department, p.designation].filter(Boolean).join(' · ') || '—'}
        </p>
      </div>
    </div>
  );
}

function Group({ emoji, title, people, accent }) {
  return (
    <div className="min-w-0">
      <div className="flex items-center gap-2 mb-2.5">
        <span className="text-lg">{emoji}</span>
        <h3 className="text-sm font-bold text-gray-800">{title}</h3>
        <span className="text-[11px] font-semibold text-gray-400">{people.length}</span>
      </div>
      {people.length === 0 ? (
        <p className="text-xs text-gray-300 py-2">None today</p>
      ) : (
        <div className="space-y-2">{people.map(p => <Person key={`${title}-${p.id}`} p={p} accent={accent} />)}</div>
      )}
    </div>
  );
}

export default function TodaysCelebrations() {
  const { data } = useQuery({
    queryKey: ['celebrations-today'],
    queryFn: () => celebrationsApi.today().then(r => r.data),
    staleTime: 5 * 60 * 1000,
  });
  const birthdays = data?.birthdays || [];
  const marriages = data?.marriageAnniversaries || [];
  const works = data?.workAnniversaries || [];
  const total = birthdays.length + marriages.length + works.length;

  return (
    <div className="bg-white rounded-2xl border border-gray-200/70 shadow-sm p-5 h-full">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-base font-bold text-gray-900">Today's Celebrations</h2>
        {total > 0 && <span className="text-[11px] font-semibold px-2 py-0.5 rounded-full bg-indigo-50 text-indigo-700">{total}</span>}
      </div>
      {total === 0 ? (
        <p className="text-sm text-gray-400 py-2">No celebrations today. 🎉</p>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">
          <Group emoji="🎂" title="Birthdays" people={birthdays} accent={{ bg: 'bg-rose-50', text: 'text-rose-700' }} />
          <Group emoji="💐" title="Marriage Anniversaries" people={marriages} accent={{ bg: 'bg-pink-50', text: 'text-pink-700' }} />
          <Group emoji="🏆" title="Work Anniversaries" people={works} accent={{ bg: 'bg-amber-50', text: 'text-amber-700' }} />
        </div>
      )}
    </div>
  );
}
