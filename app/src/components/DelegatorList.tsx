"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { VotesClient, RegistryDelegatorInfo, Network } from "@nebgov/sdk";
import { AddressDisplay } from "./AddressDisplay";
import { formatVotingPower } from "../lib/utils";

interface DelegatorListProps {
  /** Address to list current delegators for. */
  delegatee: string;
  pageSize?: number;
  className?: string;
}

/**
 * Paginated list of all current delegators for a delegatee, backed by the
 * on-chain delegation registry (issue #769) via
 * {@link VotesClient.getRegistryDelegators}.
 */
export function DelegatorList({ delegatee, pageSize = 10, className = "" }: DelegatorListProps) {
  const [offset, setOffset] = useState(0);
  const [delegators, setDelegators] = useState<RegistryDelegatorInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchPage = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const governorAddress = process.env.NEXT_PUBLIC_GOVERNOR_ADDRESS;
      const timelockAddress = process.env.NEXT_PUBLIC_TIMELOCK_ADDRESS;
      const votesAddress = process.env.NEXT_PUBLIC_VOTES_ADDRESS;
      const network = (process.env.NEXT_PUBLIC_NETWORK || "testnet") as Network;
      const rpcUrl = process.env.NEXT_PUBLIC_RPC_URL;

      if (!governorAddress || !timelockAddress || !votesAddress) {
        throw new Error("Missing required environment variables for VotesClient");
      }

      const votesClient = new VotesClient({
        governorAddress,
        timelockAddress,
        votesAddress,
        network,
        ...(rpcUrl && { rpcUrl }),
      });

      const page = await votesClient.getRegistryDelegators(delegatee, offset, pageSize);
      setDelegators(page);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load delegators");
    } finally {
      setLoading(false);
    }
  }, [delegatee, offset, pageSize]);

  useEffect(() => {
    fetchPage();
  }, [fetchPage]);

  if (loading) {
    return (
      <div className={`space-y-2 ${className}`}>
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="h-6 bg-gray-200 dark:bg-gray-700 animate-pulse rounded" />
        ))}
      </div>
    );
  }

  if (error) {
    return <p className="text-sm text-red-600 dark:text-red-400">{error}</p>;
  }

  if (delegators.length === 0 && offset === 0) {
    return <p className="text-sm text-gray-500 dark:text-gray-400">No current delegators.</p>;
  }

  return (
    <div className={className}>
      <div className="space-y-2">
        {delegators.map((d) => (
          <div
            key={d.address}
            className="flex items-center justify-between text-sm border-b border-gray-100 dark:border-gray-800 pb-2 last:border-0"
          >
            <Link
              href={`/profile/${d.address}`}
              className="font-mono text-indigo-600 dark:text-indigo-400 hover:text-indigo-700 dark:hover:text-indigo-300"
            >
              <AddressDisplay address={d.address} />
            </Link>
            <div className="text-right text-gray-500 dark:text-gray-400">
              <span>{formatVotingPower(d.delegatedPower)}</span>
              <span className="mx-1">·</span>
              <span>ledger #{d.delegatedAtLedger}</span>
              {d.chainDepth > 1 && (
                <>
                  <span className="mx-1">·</span>
                  <span>depth {d.chainDepth}</span>
                </>
              )}
            </div>
          </div>
        ))}
      </div>

      <div className="flex items-center justify-between mt-4">
        <button
          onClick={() => setOffset((o) => Math.max(0, o - pageSize))}
          disabled={offset === 0}
          className="text-xs px-3 py-1 rounded border border-gray-300 dark:border-gray-600 disabled:opacity-40 disabled:cursor-not-allowed hover:bg-gray-50 dark:hover:bg-gray-800"
        >
          ← Previous
        </button>
        <span className="text-xs text-gray-500 dark:text-gray-400">
          Showing {offset + 1}–{offset + delegators.length}
        </span>
        <button
          onClick={() => setOffset((o) => o + pageSize)}
          disabled={delegators.length < pageSize}
          className="text-xs px-3 py-1 rounded border border-gray-300 dark:border-gray-600 disabled:opacity-40 disabled:cursor-not-allowed hover:bg-gray-50 dark:hover:bg-gray-800"
        >
          Next →
        </button>
      </div>
    </div>
  );
}
