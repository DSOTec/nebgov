import { Skeleton } from "./Skeleton";

export function TreasuryBalanceSkeleton() {
  return (
    <div className="grid grid-cols-2 gap-4 mb-8">
      <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl p-6">
        <Skeleton className="h-4 w-20 mb-2" />
        <Skeleton className="h-8 w-24 mt-1" />
      </div>
      <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl p-6">
        <Skeleton className="h-4 w-16 mb-2" />
        <Skeleton className="h-8 w-28 mt-1" />
      </div>
    </div>
  );
}

export function TreasuryPendingSkeleton() {
  return (
    <>
      {[1, 2].map((i) => (
        <div
          key={i}
          className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl p-5 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4"
        >
          <div className="flex-1 min-w-0">
            <Skeleton className="h-4 w-3/4 mb-2" />
            <Skeleton className="h-3 w-20 mb-3" />
            <div className="flex items-center gap-3">
              <Skeleton className="h-4 w-8" />
              <Skeleton className="h-2 w-48 rounded-full" />
            </div>
          </div>
          <Skeleton className="h-9 w-24 rounded-lg shrink-0" />
        </div>
      ))}
    </>
  );
}
