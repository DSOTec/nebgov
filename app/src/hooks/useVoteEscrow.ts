"use client";

import { useState, useEffect } from "react";
import { VoteEscrowClient, VoteEscrowLock, VoteEscrowStats } from "@nebgov/sdk";

export interface UseVoteEscrowResult {
  lock: VoteEscrowLock | null;
  votingPower: bigint;
  stats: VoteEscrowStats | null;
  loading: boolean;
  error: string | null;
}

export function useVoteEscrow(address: string | undefined): UseVoteEscrowResult {
  const [lock, setLock] = useState<VoteEscrowLock | null>(null);
  const [votingPower, setVotingPower] = useState<bigint>(0n);
  const [stats, setStats] = useState<VoteEscrowStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!address) {
      setLoading(false);
      return;
    }

    let cancelled = false;

    async function fetchData() {
      setLoading(true);
      setError(null);

      try {
        const voteEscrowAddress = process.env.NEXT_PUBLIC_VOTE_ESCROW_ADDRESS;
        const governorAddress = process.env.NEXT_PUBLIC_GOVERNOR_ADDRESS;
        const timelockAddress = process.env.NEXT_PUBLIC_TIMELOCK_ADDRESS;
        const votesAddress = process.env.NEXT_PUBLIC_VOTES_ADDRESS;

        if (!voteEscrowAddress) {
          throw new Error("NEXT_PUBLIC_VOTE_ESCROW_ADDRESS not configured");
        }

        const client = new VoteEscrowClient({
          governorAddress: governorAddress || "",
          timelockAddress: timelockAddress || "",
          votesAddress: votesAddress || "",
          voteEscrowAddress,
          network: (process.env.NEXT_PUBLIC_NETWORK || "testnet") as any,
          rpcUrl: process.env.NEXT_PUBLIC_RPC_URL,
          simulationAccount: process.env.NEXT_PUBLIC_SIMULATION_ACCOUNT,
        });

        const [lockData, votingPowerData, statsData] = await Promise.all([
          client.getLock(address),
          client.getVotingPower(address),
          client.getEscrowStats(),
        ]);

        if (!cancelled) {
          setLock(lockData);
          setVotingPower(votingPowerData);
          setStats(statsData);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Failed to load vote escrow data");
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    fetchData();

    return () => {
      cancelled = true;
    };
  }, [address]);

  return { lock, votingPower, stats, loading, error };
}
