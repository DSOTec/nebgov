"use client";

import { useCallback, useEffect, useState } from "react";
import { readIndexerUrl } from "../lib/nebgov-env";

export interface ConvictionProposalView {
  proposalId: string;
  proposer: string;
  target: string;
  requestedAmount: bigint;
  conviction: bigint;
  lastUpdatedLedger: number;
  executed: boolean;
  cancelled: boolean;
}

function parseProposal(row: Record<string, unknown>): ConvictionProposalView {
  return {
    proposalId: String(row.proposal_id),
    proposer: String(row.proposer),
    target: String(row.target),
    requestedAmount: BigInt(String(row.requested_amount ?? 0)),
    conviction: BigInt(String(row.conviction ?? 0)),
    lastUpdatedLedger: Number(row.last_updated_ledger),
    executed: Boolean(row.executed),
    cancelled: Boolean(row.cancelled),
  };
}

export function useConvictionProposals(status = "active") {
  const [proposals, setProposals] = useState<ConvictionProposalView[]>([]);
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
      const response = await fetch(
        `${indexerUrl}/conviction/proposals?status=${encodeURIComponent(status)}`,
        { cache: "no-store" },
      );
      if (!response.ok) throw new Error(`Indexer returned ${response.status}`);
      const body = await response.json() as { data: Record<string, unknown>[] };
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
