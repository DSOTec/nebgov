"use client";

import { useCallback, useState } from "react";
import { ProposalSimulationClient, type Network, type SimulationResult } from "@nebgov/sdk";
import { backendBaseUrl } from "../lib/backend";

interface UseProposalSimulationResult {
  results: SimulationResult[] | null;
  loading: boolean;
  error: string | null;
  anyActionWouldRevert: boolean;
  previewDraft: (
    targets: string[],
    fnNames: string[],
    calldatas: Uint8Array[],
    descriptionHash?: string,
  ) => Promise<SimulationResult[] | null>;
  simulateProposal: (proposalId: number) => Promise<SimulationResult[] | null>;
  reset: () => void;
}

function makeClient(): ProposalSimulationClient {
  const governorAddress = process.env.NEXT_PUBLIC_GOVERNOR_ADDRESS;
  const timelockAddress = process.env.NEXT_PUBLIC_TIMELOCK_ADDRESS;
  const votesAddress = process.env.NEXT_PUBLIC_VOTES_ADDRESS;
  const network = (process.env.NEXT_PUBLIC_NETWORK || "testnet") as Network;

  if (!governorAddress || !timelockAddress || !votesAddress) {
    throw new Error("Missing required environment variables for ProposalSimulationClient");
  }

  return new ProposalSimulationClient({
    governorAddress,
    timelockAddress,
    votesAddress,
    network,
    backendUrl: backendBaseUrl(),
  });
}

/**
 * Pre-vote proposal calldata simulation (issue #1000): backend-sourced, not
 * indexer or on-chain directly — same data-source shape as
 * {@link useGovernanceTuning}.
 */
export function useProposalSimulation(): UseProposalSimulationResult {
  const [results, setResults] = useState<SimulationResult[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reset = useCallback(() => {
    setResults(null);
    setError(null);
  }, []);

  const previewDraft = useCallback(
    async (
      targets: string[],
      fnNames: string[],
      calldatas: Uint8Array[],
      descriptionHash?: string,
    ): Promise<SimulationResult[] | null> => {
      setLoading(true);
      setError(null);
      try {
        const client = makeClient();
        const preview = await client.previewDraft(targets, fnNames, calldatas, descriptionHash);
        setResults(preview);
        return preview;
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to simulate proposal");
        setResults(null);
        return null;
      } finally {
        setLoading(false);
      }
    },
    [],
  );

  const simulateProposal = useCallback(
    async (proposalId: number): Promise<SimulationResult[] | null> => {
      setLoading(true);
      setError(null);
      try {
        const client = makeClient();
        const preview = await client.simulateProposal(proposalId);
        setResults(preview);
        return preview;
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to simulate proposal");
        setResults(null);
        return null;
      } finally {
        setLoading(false);
      }
    },
    [],
  );

  const anyActionWouldRevert = (results ?? []).some((r) => !r.success);

  return { results, loading, error, anyActionWouldRevert, previewDraft, simulateProposal, reset };
}
