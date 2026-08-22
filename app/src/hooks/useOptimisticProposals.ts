"use client";

import { useCallback, useEffect, useState } from "react";
import { readIndexerUrl } from "../lib/nebgov-env";

export type OptimisticProposalStatus =
  | "challenge_window"
  | "objected"
  | "passed"
  | "executed"
  | "cancelled";

export interface OptimisticProposalView {
  proposalId: string;
  proposer: string;
  createdLedger: number;
  challengeEndLedger: number;
  objectionVotes: bigint;
  state: OptimisticProposalStatus;
}

export interface OptimisticObjectionView {
  objector: string;
  weight: bigint;
  runningTotal: bigint;
  ledger: number;
}

function parseProposal(row: Record<string, unknown>): OptimisticProposalView {
  return {
    proposalId: String(row.proposal_id),
    proposer: String(row.proposer),
    createdLedger: Number(row.created_ledger),
    challengeEndLedger: Number(row.challenge_end_ledger),
    objectionVotes: BigInt(String(row.objection_votes ?? 0)),
    state: row.state as OptimisticProposalStatus,
  };
}

/** Lists optimistic-governance proposals from the indexer, optionally filtered by lifecycle state. */
export function useOptimisticProposals(status?: OptimisticProposalStatus) {
  const [proposals, setProposals] = useState<OptimisticProposalView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const indexerUrl = readIndexerUrl();

  const refresh = useCallback(async () => {
    if (!indexerUrl) {
      setError("NEXT_PUBLIC_INDEXER_URL is not configured");
      setLoading(false);
      return;
    }
    try {
      setError(null);
      const query = status ? `?status=${encodeURIComponent(status)}` : "";
      const response = await fetch(`${indexerUrl}/optimistic/proposals${query}`, {
        cache: "no-store",
      });
      if (!response.ok) throw new Error(`Indexer returned ${response.status}`);
      const body = (await response.json()) as { data: Record<string, unknown>[] };
      setProposals(body.data.map(parseProposal));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Failed to load proposals");
    } finally {
      setLoading(false);
    }
  }, [indexerUrl, status]);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 15_000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  return { proposals, loading, error, refresh };
}

/** Fetches a single optimistic-governance proposal plus its objection history. */
export function useOptimisticProposal(id: string | undefined) {
  const [proposal, setProposal] = useState<OptimisticProposalView | null>(null);
  const [objections, setObjections] = useState<OptimisticObjectionView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const indexerUrl = readIndexerUrl();

  const refresh = useCallback(async () => {
    if (!indexerUrl || !id) {
      setLoading(false);
      return;
    }
    try {
      setError(null);
      const [proposalRes, objectionsRes] = await Promise.all([
        fetch(`${indexerUrl}/optimistic/proposals/${id}`, { cache: "no-store" }),
        fetch(`${indexerUrl}/optimistic/proposals/${id}/objections`, { cache: "no-store" }),
      ]);
      if (proposalRes.status === 404) {
        setProposal(null);
        setObjections([]);
        return;
      }
      if (!proposalRes.ok) throw new Error(`Indexer returned ${proposalRes.status}`);
      const proposalRow = (await proposalRes.json()) as Record<string, unknown>;
      setProposal(parseProposal(proposalRow));

      if (objectionsRes.ok) {
        const body = (await objectionsRes.json()) as { data: Record<string, unknown>[] };
        setObjections(
          body.data.map((row) => ({
            objector: String(row.objector),
            weight: BigInt(String(row.weight)),
            runningTotal: BigInt(String(row.running_total)),
            ledger: Number(row.ledger),
          })),
        );
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Failed to load proposal");
    } finally {
      setLoading(false);
    }
  }, [indexerUrl, id]);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 15_000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  return { proposal, objections, loading, error, refresh };
}
