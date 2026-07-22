"use client";

import { useEffect, useState } from "react";
import { AllTimeStats, AnalyticsClient, GovernanceSnapshot, Network } from "@nebgov/sdk";

export interface TopVoter {
  rank: number;
  voter: string;
  proposalsVoted: number;
  totalWeightCast: bigint;
}

interface UseAnalyticsResult {
  allTimeStats: AllTimeStats | null;
  latestSnapshot: GovernanceSnapshot | null;
  topVoters: TopVoter[];
  loading: boolean;
  error: string | null;
}

/**
 * Governance analytics module (issue #765): all-time stats and the latest
 * snapshot are read directly on-chain via {@link AnalyticsClient} (the
 * authoritative source); the top-voters ranking comes from the indexer,
 * since ranking across every voter isn't something the contract tracks.
 */
export function useAnalytics(): UseAnalyticsResult {
  const [allTimeStats, setAllTimeStats] = useState<AllTimeStats | null>(null);
  const [latestSnapshot, setLatestSnapshot] = useState<GovernanceSnapshot | null>(null);
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

        const [stats, snapshot, topVotersResp] = await Promise.all([
          client.getAllTimeStats(),
          client.getLatestSnapshot(),
          indexerUrl
            ? fetch(`${indexerUrl}/analytics/top-voters?limit=10`, { cache: "no-store" })
            : Promise.resolve(null),
        ]);

        if (cancelled) return;

        setAllTimeStats(stats);
        setLatestSnapshot(snapshot);

        if (topVotersResp && topVotersResp.ok) {
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

  return { allTimeStats, latestSnapshot, topVoters, loading, error };
}
