"use client";

import { useCallback, useEffect, useState } from "react";
import { SignalingClient, type SignalingPoll, type SignalingPollResults } from "@nebgov/sdk";
import { readGovernorConfig } from "../lib/nebgov-env";
import { useWallet } from "../lib/wallet-context";

const POLL_INTERVAL_MS = 30_000;

function useSignalingClient(): SignalingClient | null {
  const [client, setClient] = useState<SignalingClient | null>(null);

  useEffect(() => {
    const config = readGovernorConfig();
    setClient(config ? new SignalingClient(config) : null);
  }, []);

  return client;
}

/** Active/closed poll list, auto-refreshing — no wallet connection required to browse. */
export function useSignalingPolls(status?: "active" | "closed") {
  const client = useSignalingClient();
  const [polls, setPolls] = useState<SignalingPoll[]>([]);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    if (!client) return;
    setLoading(true);
    try {
      setPolls(await client.listPolls(status));
    } catch {
      // Backend unreachable — leave prior state in place.
    } finally {
      setLoading(false);
    }
  }, [client, status]);

  useEffect(() => {
    void refresh();
    const interval = setInterval(() => void refresh(), POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [refresh]);

  return { polls, loading, refresh };
}

/** A single poll plus its live/final results, auto-refreshing while open. */
export function useSignalingPoll(pollId: number | null) {
  const client = useSignalingClient();
  const [poll, setPoll] = useState<SignalingPoll | null>(null);
  const [results, setResults] = useState<SignalingPollResults | null>(null);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    if (!client || pollId === null) return;
    setLoading(true);
    try {
      const [nextPoll, nextResults] = await Promise.all([
        client.getPoll(pollId),
        client.getResults(pollId),
      ]);
      setPoll(nextPoll);
      setResults(nextResults);
    } catch {
      // Backend unreachable — leave prior state in place.
    } finally {
      setLoading(false);
    }
  }, [client, pollId]);

  useEffect(() => {
    void refresh();
    if (poll?.finalized) return;
    const interval = setInterval(() => void refresh(), POLL_INTERVAL_MS);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refresh, poll?.finalized]);

  return { poll, results, loading, refresh };
}

/** Create-poll and cast-vote mutations — both require a connected wallet. */
export function useSignalingActions() {
  const client = useSignalingClient();
  const { publicKey, isConnected, connect, signMessage } = useWallet();

  const createPoll = useCallback(
    async (params: {
      title: string;
      description: string;
      choices: string[];
      snapshotLedger: number;
      startTime: Date;
      endTime: Date;
    }): Promise<number> => {
      if (!client) throw new Error("Signaling is not configured for this deployment.");
      let pk = publicKey;
      if (!isConnected || !pk) pk = await connect();
      if (!pk) throw new Error("Connect your wallet first.");

      // Poll creation is verified server-side by the creator's live on-chain
      // voting power (see backend/src/routes/signaling.ts), not by a
      // signature — creator is passed as a bare address since the wallet
      // extension never exposes a private key / Keypair to the SDK.
      return client.createPoll(
        pk,
        params.title,
        params.description,
        params.choices,
        params.snapshotLedger,
        params.startTime,
        params.endTime,
      );
    },
    [client, publicKey, isConnected, connect],
  );

  const castVote = useCallback(
    async (pollId: number, choiceIndex: number): Promise<void> => {
      if (!client) throw new Error("Signaling is not configured for this deployment.");
      let pk = publicKey;
      if (!isConnected || !pk) pk = await connect();
      if (!pk) throw new Error("Connect your wallet first.");

      await client.castVoteWithSign(pk, signMessage, pollId, choiceIndex);
    },
    [client, publicKey, isConnected, connect, signMessage],
  );

  return { createPoll, castVote };
}
