"use client";

import { AddressDisplay } from "./AddressDisplay";
import { Skeleton } from "./ui/Skeleton";
import type { TopVoter } from "../hooks/useAnalytics";

interface TopVotersTableProps {
  voters: TopVoter[];
  loading?: boolean;
}

/**
 * Top-voters ranking (issue #765), sourced from the indexer's
 * `/analytics/top-voters` endpoint (aggregated from indexed `VoteCast`
 * events — the contract itself has no global voter ranking).
 */
export function TopVotersTable({ voters, loading }: TopVotersTableProps) {
  return (
    <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl p-4">
      <h3 className="text-sm font-semibold text-gray-600 dark:text-gray-400 mb-4">Top Voters</h3>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-gray-500 dark:text-gray-400 border-b border-gray-200 dark:border-gray-700">
              <th className="py-2 pr-4 font-medium">#</th>
              <th className="py-2 pr-4 font-medium">Voter</th>
              <th className="py-2 pr-4 font-medium">Proposals voted</th>
              <th className="py-2 font-medium">Total weight cast</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              Array.from({ length: 5 }).map((_, i) => (
                <tr key={i} className="border-b border-gray-100 dark:border-gray-800">
                  <td className="py-2 pr-4">
                    <Skeleton className="h-4 w-4" />
                  </td>
                  <td className="py-2 pr-4">
                    <Skeleton className="h-4 w-32" />
                  </td>
                  <td className="py-2 pr-4">
                    <Skeleton className="h-4 w-10" />
                  </td>
                  <td className="py-2">
                    <Skeleton className="h-4 w-20" />
                  </td>
                </tr>
              ))
            ) : voters.length === 0 ? (
              <tr>
                <td colSpan={4} className="py-4 text-center text-gray-400 dark:text-gray-500">
                  No votes recorded yet.
                </td>
              </tr>
            ) : (
              voters.map((v) => (
                <tr
                  key={v.voter}
                  className="border-b border-gray-100 dark:border-gray-800 text-gray-900 dark:text-white"
                >
                  <td className="py-2 pr-4 text-gray-500 dark:text-gray-400">{v.rank}</td>
                  <td className="py-2 pr-4">
                    <AddressDisplay address={v.voter} />
                  </td>
                  <td className="py-2 pr-4">{v.proposalsVoted}</td>
                  <td className="py-2">{v.totalWeightCast.toString()}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
