"use client";

import { useState, useEffect } from "react";
import { VotesClient, DelegateProfile, Network } from "@nebgov/sdk";

interface UseDelegateProfileResult {
  profile: DelegateProfile | null;
  loading: boolean;
  error: string | null;
}

/**
 * Fetch the on-chain delegation registry profile (issue #769) for an
 * address: current/base voting power, delegator count, total delegated
 * power, the configured chain depth limit, and when it was first delegated
 * to.
 */
export function useDelegateProfile(address: string | undefined): UseDelegateProfileResult {
  const [profile, setProfile] = useState<DelegateProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!address) {
      setLoading(false);
      return;
    }

    let cancelled = false;

    async function fetchProfile() {
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

        const result = await votesClient.getDelegateProfile(address as string);
        if (!cancelled) setProfile(result);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Failed to load delegate profile");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    fetchProfile();
    return () => {
      cancelled = true;
    };
  }, [address]);

  return { profile, loading, error };
}
