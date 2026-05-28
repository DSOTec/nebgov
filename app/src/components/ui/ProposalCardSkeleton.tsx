import { Skeleton } from "./Skeleton";

export function ProposalCardSkeleton() {
  return (
    <div className="block bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl p-6">
      <div className="flex items-start justify-between">
        <div className="flex-1 min-w-0">
          <Skeleton className="h-3 w-24 mb-2" />
          <Skeleton className="h-5 w-3/4 mb-3" />
          <div className="flex items-center gap-4">
            <Skeleton className="h-4 w-20" />
            <Skeleton className="h-4 w-20" />
          </div>
        </div>
        <Skeleton className="ml-4 h-6 w-20 rounded-full" />
      </div>
    </div>
  );
}
