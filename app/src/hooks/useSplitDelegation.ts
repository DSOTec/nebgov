"use client";

import { useState, useEffect, useCallback } from "react";
import { VotesClient, type SplitDelegation, type Network } from "@nebgov/sdk";
import { useWallet } from "../lib/wallet-context";

interface UseSplitDelegationResult {
  splits: SplitDelegation[];
  loading: boolean;
  error: string | null;
  submitting: boolean;
  refetch: () => void;
  /**
   * Delegate arbitrary basis-point percentages of the caller's voting power
   * across multiple delegatees (issue #994). `splits` must sum to 10000.
   * Throws on failure.
   */
  delegateSplit: (splits: SplitDelegation[]) => Promise<string>;
  /** Revoke split delegation and return full voting power to the caller. */
  undelegateSplit: () => Promise<string>;
}

function getVotesClientFromEnv(): VotesClient {
  const governorAddress = process.env.NEXT_PUBLIC_GOVERNOR_ADDRESS;
  const timelockAddress = process.env.NEXT_PUBLIC_TIMELOCK_ADDRESS;
  const votesAddress = process.env.NEXT_PUBLIC_VOTES_ADDRESS;
  const network = (process.env.NEXT_PUBLIC_NETWORK || "testnet") as Network;
  const rpcUrl = process.env.NEXT_PUBLIC_RPC_URL;

  if (!governorAddress || !timelockAddress || !votesAddress) {
    throw new Error("Missing NEXT_PUBLIC_* contract addresses in .env.local");
  }

  return new VotesClient({
    governorAddress,
    timelockAddress,
    votesAddress,
    network,
    ...(rpcUrl && { rpcUrl }),
  });
}

/**
 * Split delegation (issue #994): read the current split for `address` and
 * expose wallet-signing actions to update or revoke it. `splits` falls back
 * to a single 100% entry when the address is using the legacy single-target
 * `delegate()` path instead — see `getSplitDelegations` in votes.ts.
 */
export function useSplitDelegation(address: string | undefined): UseSplitDelegationResult {
  const [splits, setSplits] = useState<SplitDelegation[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [refreshToken, setRefreshToken] = useState(0);
  const { publicKey, signTransaction } = useWallet();

  useEffect(() => {
    if (!address) {
      setLoading(false);
      return;
    }

    let cancelled = false;

    async function fetchSplits() {
      setLoading(true);
      setError(null);
      try {
        const client = getVotesClientFromEnv();
        const result = await client.getSplitDelegations(address as string);
        if (!cancelled) setSplits(result);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Failed to load split delegations");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    fetchSplits();
    return () => {
      cancelled = true;
    };
  }, [address, refreshToken]);

  const refetch = useCallback(() => setRefreshToken((t) => t + 1), []);

  const delegateSplit = useCallback(
    async (newSplits: SplitDelegation[]) => {
      if (!publicKey) throw new Error("Connect your wallet first.");
      setSubmitting(true);
      try {
        const client = getVotesClientFromEnv();
        const hash = await client.delegateSplitWithSign(publicKey, newSplits, signTransaction);
        refetch();
        return hash;
      } finally {
        setSubmitting(false);
      }
    },
    [publicKey, signTransaction, refetch],
  );

  const undelegateSplit = useCallback(async () => {
    if (!publicKey) throw new Error("Connect your wallet first.");
    setSubmitting(true);
    try {
      const client = getVotesClientFromEnv();
      const hash = await client.undelegateSplitWithSign(publicKey, signTransaction);
      refetch();
      return hash;
    } finally {
      setSubmitting(false);
    }
  }, [publicKey, signTransaction, refetch]);

  return { splits, loading, error, submitting, refetch, delegateSplit, undelegateSplit };
}
