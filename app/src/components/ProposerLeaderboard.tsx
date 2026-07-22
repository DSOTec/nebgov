"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import Link from "next/link";
import { ReputationClient, ProposerLeaderboardEntry, Network } from "@nebgov/sdk";
import { AddressDisplay } from "./AddressDisplay";

type SortKey =
  | "rank"
  | "reputationScore"
  | "totalProposals"
  | "successRateBps"
  | "avgParticipationBps";

interface ProposerLeaderboardProps {
  className?: string;
}

/**
 * Sortable table of the top proposers by reputation score (Issue #771),
 * backed by the on-chain leaderboard cache via
 * {@link ReputationClient.getLeaderboard}.
 */
export function ProposerLeaderboard({ className = "" }: ProposerLeaderboardProps) {
  const [entries, setEntries] = useState<ProposerLeaderboardEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sortKey, setSortKey] = useState<SortKey>("rank");
  const [sortAsc, setSortAsc] = useState(true);

  const fetchLeaderboard = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const governorAddress = process.env.NEXT_PUBLIC_GOVERNOR_ADDRESS;
      const timelockAddress = process.env.NEXT_PUBLIC_TIMELOCK_ADDRESS;
      const votesAddress = process.env.NEXT_PUBLIC_VOTES_ADDRESS;
      const network = (process.env.NEXT_PUBLIC_NETWORK || "testnet") as Network;
      const rpcUrl = process.env.NEXT_PUBLIC_RPC_URL;

      if (!governorAddress || !timelockAddress || !votesAddress) {
        throw new Error("Missing required environment variables for ReputationClient");
      }

      const client = new ReputationClient({
        governorAddress,
        timelockAddress,
        votesAddress,
        network,
        ...(rpcUrl && { rpcUrl }),
      });

      setEntries(await client.getLeaderboard());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load leaderboard");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchLeaderboard();
  }, [fetchLeaderboard]);

  function toggleSort(key: SortKey) {
    if (key === sortKey) {
      setSortAsc((a) => !a);
    } else {
      setSortKey(key);
      setSortAsc(key === "rank");
    }
  }

  const sorted = useMemo(() => {
    const copy = [...entries];
    copy.sort((a, b) => (sortAsc ? a[sortKey] - b[sortKey] : b[sortKey] - a[sortKey]));
    return copy;
  }, [entries, sortKey, sortAsc]);

  const columns: { key: SortKey; label: string }[] = [
    { key: "rank", label: "Rank" },
    { key: "reputationScore", label: "Score" },
    { key: "totalProposals", label: "Proposals" },
    { key: "successRateBps", label: "Success Rate" },
    { key: "avgParticipationBps", label: "Avg Participation" },
  ];

  if (loading) {
    return (
      <div className={`space-y-2 ${className}`}>
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="h-8 bg-gray-200 dark:bg-gray-700 animate-pulse rounded" />
        ))}
      </div>
    );
  }

  if (error) {
    return <p className="text-sm text-red-600 dark:text-red-400">{error}</p>;
  }

  if (entries.length === 0) {
    return <p className="text-sm text-gray-500 dark:text-gray-400">No ranked proposers yet.</p>;
  }

  return (
    <div className={`overflow-x-auto ${className}`}>
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-gray-200 dark:border-gray-700 text-left">
            <th className="pb-2 pr-4 font-medium text-gray-500 dark:text-gray-400">
              Proposer
            </th>
            {columns.map((col) => (
              <th
                key={col.key}
                onClick={() => toggleSort(col.key)}
                className="pb-2 px-4 font-medium text-gray-500 dark:text-gray-400 cursor-pointer select-none hover:text-gray-900 dark:hover:text-white"
              >
                {col.label}
                {sortKey === col.key && (sortAsc ? " ▲" : " ▼")}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sorted.map((entry) => (
            <tr
              key={entry.proposer}
              className="border-b border-gray-100 dark:border-gray-800 last:border-0"
            >
              <td className="py-2 pr-4">
                <Link
                  href={`/profile/${entry.proposer}`}
                  className="font-mono text-indigo-600 dark:text-indigo-400 hover:text-indigo-700 dark:hover:text-indigo-300"
                >
                  <AddressDisplay address={entry.proposer} />
                </Link>
              </td>
              <td className="py-2 px-4">{entry.rank}</td>
              <td className="py-2 px-4">{entry.reputationScore}</td>
              <td className="py-2 px-4">{entry.totalProposals}</td>
              <td className="py-2 px-4">{(entry.successRateBps / 100).toFixed(1)}%</td>
              <td className="py-2 px-4">{(entry.avgParticipationBps / 100).toFixed(1)}%</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
