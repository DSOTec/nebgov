"use client";

import { useEffect, useState } from "react";
import { AnalyticsClient, Network, VoterHistory } from "@nebgov/sdk";
import { useWallet } from "../lib/wallet-context";
import { Skeleton } from "./ui/Skeleton";

/**
 * Connected wallet's lifetime voting participation record (issue #765),
 * read live via `AnalyticsClient.getVoterHistory()`. Renders nothing when no
 * wallet is connected.
 */
export function VoterHistoryCard() {
  const { isConnected, publicKey } = useWallet();
  const [history, setHistory] = useState<VoterHistory | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isConnected || !publicKey) return;

    let cancelled = false;

    async function fetchHistory() {
      setLoading(true);
      setError(null);
      try {
        const governorAddress = process.env.NEXT_PUBLIC_GOVERNOR_ADDRESS;
        const timelockAddress = process.env.NEXT_PUBLIC_TIMELOCK_ADDRESS;
        const votesAddress = process.env.NEXT_PUBLIC_VOTES_ADDRESS;
        const network = (process.env.NEXT_PUBLIC_NETWORK || "testnet") as Network;
        const rpcUrl = process.env.NEXT_PUBLIC_RPC_URL;

        if (!governorAddress || !timelockAddress || !votesAddress) {
          throw new Error("Missing required environment variables for AnalyticsClient");
        }

        const client = new AnalyticsClient({
          governorAddress,
          timelockAddress,
          votesAddress,
          network,
          ...(rpcUrl && { rpcUrl }),
        });

        const result = await client.getVoterHistory(publicKey as string);
        if (!cancelled) setHistory(result);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Failed to load voting history");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    fetchHistory();
    return () => {
      cancelled = true;
    };
  }, [isConnected, publicKey]);

  if (!isConnected) return null;

  return (
    <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl p-4">
      <h3 className="text-sm font-semibold text-gray-600 dark:text-gray-400 mb-4">
        Your Voting History
      </h3>
      {loading ? (
        <Skeleton className="h-16 w-full" />
      ) : error ? (
        <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
      ) : history ? (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 text-sm">
          <div>
            <p className="text-gray-500 dark:text-gray-400">Proposals voted</p>
            <p className="text-lg font-semibold text-gray-900 dark:text-white">
              {history.proposalsVoted}
            </p>
          </div>
          <div>
            <p className="text-gray-500 dark:text-gray-400">Participation rate</p>
            <p className="text-lg font-semibold text-gray-900 dark:text-white">
              {(history.participationRateBps / 100).toFixed(1)}%
            </p>
          </div>
          <div>
            <p className="text-gray-500 dark:text-gray-400">Total weight cast</p>
            <p className="text-lg font-semibold text-gray-900 dark:text-white">
              {history.totalWeightCast.toString()}
            </p>
          </div>
          <div>
            <p className="text-gray-500 dark:text-gray-400">For / Against / Abstain</p>
            <p className="text-lg font-semibold text-gray-900 dark:text-white">
              {history.forCount} / {history.againstCount} / {history.abstainCount}
            </p>
          </div>
        </div>
      ) : null}
    </div>
  );
}
