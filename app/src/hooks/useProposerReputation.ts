"use client";

import { useState, useEffect } from "react";
import { ReputationClient, ProposerReputation, Network } from "@nebgov/sdk";

interface UseProposerReputationResult {
  reputation: ProposerReputation | null;
  loading: boolean;
  error: string | null;
}

/**
 * Fetch the on-chain proposer reputation record (Issue #771) for an
 * address: proposal outcome tallies, rolling reputation score, and the
 * reputation-adjusted effective threshold multiplier.
 */
export function useProposerReputation(
  address: string | undefined,
): UseProposerReputationResult {
  const [reputation, setReputation] = useState<ProposerReputation | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!address) {
      setLoading(false);
      return;
    }

    let cancelled = false;

    async function fetchReputation() {
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

        const reputationClient = new ReputationClient({
          governorAddress,
          timelockAddress,
          votesAddress,
          network,
          ...(rpcUrl && { rpcUrl }),
        });

        const result = await reputationClient.getProposerReputation(address as string);
        if (!cancelled) setReputation(result);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Failed to load proposer reputation");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    fetchReputation();
    return () => {
      cancelled = true;
    };
  }, [address]);

  return { reputation, loading, error };
}
