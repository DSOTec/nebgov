"use client";

import { useEffect, useState } from "react";
import { AllTimeStats, AnalyticsClient, Network } from "@nebgov/sdk";

export interface TopVoter {
  rank: number;
  voter: string;
  proposalsVoted: number;
  totalWeightCast: bigint;
}

interface UseAnalyticsResult {
  allTimeStats: AllTimeStats | null;
  topVoters: TopVoter[];
  loading: boolean;
  error: string | null;
}

/**
 * Governance analytics (issue #765): entirely indexer-backed — there's no
 * on-chain analytics module (no room in the governor contract's WASM
 * budget alongside proposer reputation).
 */
export function useAnalytics(): UseAnalyticsResult {
  const [allTimeStats, setAllTimeStats] = useState<AllTimeStats | null>(null);
  const [topVoters, setTopVoters] = useState<TopVoter[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function fetchAnalytics() {
      setLoading(true);
      setError(null);
      try {
        const governorAddress = process.env.NEXT_PUBLIC_GOVERNOR_ADDRESS;
        const timelockAddress = process.env.NEXT_PUBLIC_TIMELOCK_ADDRESS;
        const votesAddress = process.env.NEXT_PUBLIC_VOTES_ADDRESS;
        const indexerUrl = process.env.NEXT_PUBLIC_INDEXER_URL;
        const network = (process.env.NEXT_PUBLIC_NETWORK || "testnet") as Network;
        const rpcUrl = process.env.NEXT_PUBLIC_RPC_URL;

        if (!governorAddress || !timelockAddress || !votesAddress || !indexerUrl) {
          throw new Error(
            "Missing required environment variables for AnalyticsClient (including NEXT_PUBLIC_INDEXER_URL)",
          );
        }

        const client = new AnalyticsClient({
          governorAddress,
          timelockAddress,
          votesAddress,
          network,
          indexerUrl,
          ...(rpcUrl && { rpcUrl }),
        });

        const [stats, topVotersResp] = await Promise.all([
          client.getAllTimeStats(),
          fetch(`${indexerUrl}/analytics/top-voters?limit=10`, { cache: "no-store" }),
        ]);

        if (cancelled) return;

        setAllTimeStats(stats);

        if (topVotersResp.ok) {
          const json = await topVotersResp.json();
          const voters = (json.top_voters ?? []).map((v: any) => ({
            rank: Number(v.rank),
            voter: String(v.voter),
            proposalsVoted: Number(v.proposals_voted),
            totalWeightCast: BigInt(v.total_weight_cast ?? 0),
          }));
          if (!cancelled) setTopVoters(voters);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Failed to load governance analytics");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    fetchAnalytics();
    return () => {
      cancelled = true;
    };
  }, []);

  return { allTimeStats, topVoters, loading, error };
}
