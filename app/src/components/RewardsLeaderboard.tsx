"use client";

import { useEpochLeaderboard } from "../hooks/useVotingRewards";
import { Skeleton } from "./ui/Skeleton";

function formatAddress(address: string): string {
  return `${address.slice(0, 4)}...${address.slice(-4)}`;
}

function formatAmount(amount: bigint): string {
  const n = Number(amount);
  if (!Number.isFinite(n)) return amount.toString();
  return new Intl.NumberFormat("en").format(n);
}

interface RewardsLeaderboardProps {
  epochId: bigint | null;
  /** Highlighted in the table when it appears — the connected wallet. */
  highlightAddress?: string | null;
  limit?: number;
}

/** Top earners for one reward epoch (Issue #1011). */
export function RewardsLeaderboard({
  epochId,
  highlightAddress,
  limit = 10,
}: RewardsLeaderboardProps) {
  const { rows, loading, error } = useEpochLeaderboard(epochId, limit);

  if (epochId === null) {
    return (
      <p className="text-sm text-gray-500 dark:text-gray-400">
        No published epoch to rank yet.
      </p>
    );
  }

  if (loading) {
    return (
      <div className="space-y-2">
        <Skeleton className="h-6 w-full" />
        <Skeleton className="h-6 w-full" />
        <Skeleton className="h-6 w-full" />
      </div>
    );
  }

  if (error) {
    return <p className="text-sm text-red-600 dark:text-red-400">{error}</p>;
  }

  if (rows.length === 0) {
    return (
      <p className="text-sm text-gray-500 dark:text-gray-400">
        Nobody voted during epoch {epochId.toString()}.
      </p>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="min-w-full text-sm">
        <caption className="sr-only">
          Top voting-reward earners for epoch {epochId.toString()}
        </caption>
        <thead>
          <tr className="text-left text-xs uppercase tracking-wide text-gray-500 dark:text-gray-400">
            <th scope="col" className="py-2 pr-4">
              #
            </th>
            <th scope="col" className="py-2 pr-4">
              Voter
            </th>
            <th scope="col" className="py-2 pr-4 text-right">
              Reward
            </th>
            <th scope="col" className="py-2 text-right">
              Status
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => {
            const isYou = highlightAddress !== null && highlightAddress === row.address;
            return (
              <tr
                key={row.address}
                className={`border-t border-gray-100 dark:border-gray-800 ${
                  isYou ? "bg-indigo-50/60 dark:bg-indigo-900/20" : ""
                }`}
              >
                <td className="py-2 pr-4 text-gray-500 dark:text-gray-400">{index + 1}</td>
                <td className="py-2 pr-4 font-mono text-gray-900 dark:text-gray-100">
                  {formatAddress(row.address)}
                  {isYou && (
                    <span className="ml-2 text-xs font-sans text-indigo-600 dark:text-indigo-300">
                      you
                    </span>
                  )}
                </td>
                <td className="py-2 pr-4 text-right text-gray-900 dark:text-gray-100">
                  {formatAmount(row.amount)}
                </td>
                <td className="py-2 text-right text-xs text-gray-500 dark:text-gray-400">
                  {row.claimed ? "Claimed" : "Unclaimed"}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
