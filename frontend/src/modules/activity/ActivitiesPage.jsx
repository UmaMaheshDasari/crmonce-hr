import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { ArrowLeftIcon } from '@heroicons/react/24/outline';
import { activityApi } from '../../api/endpoints';
import ActivityFeed from '../../components/ActivityFeed';

export default function ActivitiesPage() {
  const { data, isLoading, isFetching } = useQuery({
    queryKey: ['activities-all'],
    queryFn: () => activityApi.list(100),
    refetchInterval: 30000,          // auto-refresh every 30s
    refetchOnWindowFocus: true,
  });

  const items = data?.data?.data ?? [];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <Link to="/" className="inline-flex items-center gap-1.5 text-sm text-gray-500 hover:text-indigo-600 mb-2">
            <ArrowLeftIcon className="w-4 h-4" /> Back to Dashboard
          </Link>
          <h1 className="text-2xl font-bold text-gray-900">All Activities</h1>
          <p className="text-sm text-gray-400 mt-0.5">
            Important system events across attendance, leave, employees, payroll and documents
            {isFetching && !isLoading ? ' · refreshing…' : ''}
          </p>
        </div>
      </div>

      <div className="bg-white rounded-xl border border-gray-100 p-6">
        <ActivityFeed items={items} loading={isLoading} emptyText="No system activity recorded yet." />
      </div>
    </div>
  );
}
