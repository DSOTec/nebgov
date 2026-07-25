"use client";

import { useCallback, useEffect, useState } from "react";
import { CoSponsorshipClient, type ProposalDraft } from "@nebgov/sdk";
import { readGovernorConfig } from "../lib/nebgov-env";

interface UseDraftResult {
  draft: ProposalDraft | null;
  loading: boolean;
  error: string | null;
  refetch: () => void;
}

/** Fetch a single co-sponsorship draft by id, with manual refetch. */
export function useDraft(draftId: bigint | null): UseDraftResult {
  const [draft, setDraft] = useState<ProposalDraft | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refetchToken, setRefetchToken] = useState(0);

  useEffect(() => {
    if (draftId === null) {
      setLoading(false);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);

    const config = readGovernorConfig();
    if (!config || !config.coSponsorshipAddress) {
      setError("Co-sponsorship registry is not configured.");
      setLoading(false);
      return;
    }

    const client = new CoSponsorshipClient(config);
    client
      .getDraft(draftId)
      .then((result) => {
        if (!cancelled) setDraft(result);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [draftId, refetchToken]);

  const refetch = useCallback(() => setRefetchToken((t) => t + 1), []);

  return { draft, loading, error, refetch };
}

interface UseActiveDraftsResult {
  drafts: ProposalDraft[];
  loading: boolean;
  error: string | null;
  refetch: () => void;
}

/** Fetch a page of active co-sponsorship drafts. */
export function useActiveDrafts(offset = 0, limit = 20): UseActiveDraftsResult {
  const [drafts, setDrafts] = useState<ProposalDraft[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refetchToken, setRefetchToken] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    const config = readGovernorConfig();
    if (!config || !config.coSponsorshipAddress) {
      setError("Co-sponsorship registry is not configured.");
      setLoading(false);
      return;
    }

    const client = new CoSponsorshipClient(config);
    client
      .getActiveDrafts(offset, limit)
      .then((result) => {
        if (!cancelled) setDrafts(result.filter((d) => !d.finalized && !d.cancelled));
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [offset, limit, refetchToken]);

  const refetch = useCallback(() => setRefetchToken((t) => t + 1), []);

  return { drafts, loading, error, refetch };
}
