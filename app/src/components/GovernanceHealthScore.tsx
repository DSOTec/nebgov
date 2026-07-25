"use client";

import { AllTimeStats } from "@nebgov/sdk";
import { Skeleton } from "./ui/Skeleton";

interface GovernanceHealthScoreProps {
  stats: AllTimeStats | null;
  loading?: boolean;
}

/**
 * Governance activity summary (issue #765). Entirely indexer-derived —
 * there's no on-chain analytics module, so quorum-hit/pass-rate figures
 * aren't available (they'd need the eligible supply, and for dynamic
 * quorum a live oracle price, at each proposal's start ledger). This
 * shows what the indexer *can* compute live from its own indexed data.
 */
export function GovernanceHealthScore({ stats, loading }: GovernanceHealthScoreProps) {
  if (loading || !stats) {
    return (
      <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl p-4">
        <Skeleton className="h-4 w-32 mb-3" />
        <Skeleton className="h-10 w-20" />
      </div>
    );
  }

  return (
    <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl p-4">
      <p className="text-sm text-gray-500 dark:text-gray-400">Governance activity</p>
      <p className="text-3xl font-bold mt-1 text-gray-900 dark:text-white">
        {String(stats.totalProposals)}
      </p>
      <p className="text-xs text-gray-500 dark:text-gray-400">total proposals</p>
      <div className="mt-3 space-y-1 text-xs text-gray-500 dark:text-gray-400">
        <div className="flex justify-between">
          <span>Total votes cast</span>
          <span>{String(stats.totalVotesCast)}</span>
        </div>
        <div className="flex justify-between">
          <span>Unique voters</span>
          <span>{String(stats.uniqueVoters)}</span>
        </div>
      </div>
    </div>
  );
}
