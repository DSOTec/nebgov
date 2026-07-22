"use client";

import { AllTimeStats, GovernanceSnapshot } from "@nebgov/sdk";
import { Skeleton } from "./ui/Skeleton";

interface GovernanceHealthScoreProps {
  stats: AllTimeStats | null;
  snapshot: GovernanceSnapshot | null;
  loading?: boolean;
}

/**
 * Composite governance health score (0-100), issue #765: an equal-weighted
 * blend of quorum-hit rate, proposal pass rate, and the most recent
 * snapshot's participation rate. All three inputs come straight from the
 * on-chain analytics module — see contracts/governor/src/analytics.rs.
 */
function computeHealthScore(stats: AllTimeStats, snapshot: GovernanceSnapshot | null): number {
  const totalResolved = stats.quorumHitCount + stats.quorumMissCount;
  const quorumScore = totalResolved > 0n ? Number(stats.quorumHitCount) / Number(totalResolved) : 0;
  const passScore = stats.passRateBps / 10_000;
  const participationScore = snapshot ? snapshot.participationBps / 10_000 : 0;
  const blended = (quorumScore + passScore + participationScore) / 3;
  return Math.round(Math.min(1, Math.max(0, blended)) * 100);
}

function scoreColor(score: number): string {
  if (score >= 66) return "text-green-600 dark:text-green-400";
  if (score >= 33) return "text-yellow-600 dark:text-yellow-400";
  return "text-red-600 dark:text-red-400";
}

export function GovernanceHealthScore({ stats, snapshot, loading }: GovernanceHealthScoreProps) {
  if (loading || !stats) {
    return (
      <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl p-4">
        <Skeleton className="h-4 w-32 mb-3" />
        <Skeleton className="h-10 w-20" />
      </div>
    );
  }

  const score = computeHealthScore(stats, snapshot);

  return (
    <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl p-4">
      <p className="text-sm text-gray-500 dark:text-gray-400">Governance health score</p>
      <p className={`text-3xl font-bold mt-1 ${scoreColor(score)}`}>{score}</p>
      <div className="mt-3 space-y-1 text-xs text-gray-500 dark:text-gray-400">
        <div className="flex justify-between">
          <span>Pass rate</span>
          <span>{(stats.passRateBps / 100).toFixed(1)}%</span>
        </div>
        <div className="flex justify-between">
          <span>Quorum hits</span>
          <span>
            {String(stats.quorumHitCount)} / {String(stats.quorumHitCount + stats.quorumMissCount)}
          </span>
        </div>
        <div className="flex justify-between">
          <span>Latest participation</span>
          <span>{snapshot ? (snapshot.participationBps / 100).toFixed(1) : "0.0"}%</span>
        </div>
      </div>
    </div>
  );
}
