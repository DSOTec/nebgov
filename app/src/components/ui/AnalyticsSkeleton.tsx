import { Skeleton } from "./Skeleton";

export function AnalyticsStatCardsSkeleton() {
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
      <div key="stat-card-1" className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl p-6">
        <Skeleton className="h-4 w-20 mb-2" />
        <Skeleton className="h-8 w-24 mb-2" />
        <Skeleton className="h-3 w-16" />
      </div>
      <div key="stat-card-2" className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl p-6">
        <Skeleton className="h-4 w-20 mb-2" />
        <Skeleton className="h-8 w-24 mb-2" />
        <Skeleton className="h-3 w-16" />
      </div>
      <div key="stat-card-3" className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl p-6">
        <Skeleton className="h-4 w-20 mb-2" />
        <Skeleton className="h-8 w-24 mb-2" />
        <Skeleton className="h-3 w-16" />
      </div>
      <div key="stat-card-4" className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl p-6">
        <Skeleton className="h-4 w-20 mb-2" />
        <Skeleton className="h-8 w-24 mb-2" />
        <Skeleton className="h-3 w-16" />
      </div>
    </div>
  );
}

export function AnalyticsChartSkeleton() {
  return (
    <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl p-6">
      <Skeleton className="h-4 w-32 mb-4" />
      <div className="h-64 flex items-center justify-center">
        <div className="w-full h-48 bg-gray-100 dark:bg-gray-700 rounded-lg">
          <Skeleton className="h-full w-full rounded-lg" />
        </div>
      </div>
    </div>
  );
}
