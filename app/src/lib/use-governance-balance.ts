"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { VotesClient } from "@nebgov/sdk";
import { readGovernorConfig } from "./nebgov-env";
import { useDebounce } from "../hooks/useDebounce";

type GovernanceBalance = {
  loading: boolean;
  baseVotes: bigint | null;
  votingPower: bigint | null;
  delegatee: string | null;
  error: string | null;
  refresh: () => void;
};

export function useGovernanceBalance(address: string | null | undefined): GovernanceBalance {
  const config = useMemo(() => readGovernorConfig(), []);
  const client = useMemo(() => (config ? new VotesClient(config) : null), [config]);

  const debouncedAddress = useDebounce(address, 400);

  const [loading, setLoading] = useState(false);
  const [baseVotes, setBaseVotes] = useState<bigint | null>(null);
  const [votingPower, setVotingPower] = useState<bigint | null>(null);
  const [delegatee, setDelegatee] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [refreshIndex, setRefreshIndex] = useState(0);
  const refresh = () => setRefreshIndex((i) => i + 1);

  useEffect(() => {
    if (!debouncedAddress || !client) return;

    let alive = true;
    async function run() {
      setLoading(true);
      setError(null);
      try {
        const [raw, power, del] = await Promise.all([
          client.getBaseVotes(debouncedAddress),
          client.getVotes(debouncedAddress),
          client.getDelegatee(debouncedAddress),
        ]);
        if (!alive) return;
        setBaseVotes(raw);
        setVotingPower(power);
        setDelegatee(del);
      } catch (e) {
        if (!alive) return;
        setError(e instanceof Error ? e.message : String(e));
        setBaseVotes(null);
        setVotingPower(null);
        setDelegatee(null);
      } finally {
        if (alive) setLoading(false);
      }
    }

    run();

    const interval = window.setInterval(run, 30_000);
    return () => {
      alive = false;
      window.clearInterval(interval);
    };
  }, [debouncedAddress, client, refreshIndex]);

  useEffect(() => {
    if (!address) {
      setLoading(false);
      setBaseVotes(null);
      setVotingPower(null);
      setDelegatee(null);
      setError(null);
    }
  }, [address]);

  return { loading, baseVotes, votingPower, delegatee, error, refresh };
}
