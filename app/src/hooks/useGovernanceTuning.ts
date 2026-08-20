"use client";

import { useCallback, useEffect, useState } from "react";
import { GovernanceTuningClient, type Network, type TuningRecommendation } from "@nebgov/sdk";
import { backendBaseUrl } from "../lib/backend";

interface UseGovernanceTuningResult {
  latest: TuningRecommendation | null;
  history: TuningRecommendation[];
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

/**
 * Governance tuning recommender (issue #998): backend-sourced, not indexer
 * or on-chain — see `GovernanceTuningClient`'s doc comment for why this
 * hook's data source differs from every other governance hook in this app.
 */
export function useGovernanceTuning(): UseGovernanceTuningResult {
  const [latest, setLatest] = useState<TuningRecommendation | null>(null);
  const [history, setHistory] = useState<TuningRecommendation[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshToken, setRefreshToken] = useState(0);

  const refresh = useCallback(() => setRefreshToken((t) => t + 1), []);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setLoading(true);
      setError(null);
      try {
        const governorAddress = process.env.NEXT_PUBLIC_GOVERNOR_ADDRESS;
        const timelockAddress = process.env.NEXT_PUBLIC_TIMELOCK_ADDRESS;
        const votesAddress = process.env.NEXT_PUBLIC_VOTES_ADDRESS;
        const network = (process.env.NEXT_PUBLIC_NETWORK || "testnet") as Network;

        if (!governorAddress || !timelockAddress || !votesAddress) {
          throw new Error("Missing required environment variables for GovernanceTuningClient");
        }

        const client = new GovernanceTuningClient({
          governorAddress,
          timelockAddress,
          votesAddress,
          network,
          backendUrl: backendBaseUrl(),
        });

        const [latestRec, historyRecs] = await Promise.all([
          client.getLatestRecommendation(),
          client.getRecommendationHistory(20),
        ]);

        if (cancelled) return;
        setLatest(latestRec);
        setHistory(historyRecs);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Failed to load governance tuning data");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, [refreshToken]);

  return { latest, history, loading, error, refresh };
}
