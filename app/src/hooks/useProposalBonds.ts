"use client";

import { useCallback, useEffect, useState } from "react";
import { ProposalBondsClient, type ProposalBond, type ProposalBondSettings } from "@nebgov/sdk";
import { readGovernorConfig, readIndexerUrl } from "../lib/nebgov-env";

function buildClient(): ProposalBondsClient | null {
  const config = readGovernorConfig();
  if (!config || !config.proposalBondsAddress) return null;
  const indexerUrl = readIndexerUrl();
  return new ProposalBondsClient({
    ...config,
    ...(indexerUrl ? { indexerUrl } : {}),
  });
}

interface UseBondResult {
  bond: ProposalBond | null;
  loading: boolean;
  error: string | null;
  refetch: () => void;
}

/** Fetch a single proposal bond by description hash, with manual refetch. */
export function useProposalBond(descriptionHash: string | null): UseBondResult {
  const [bond, setBond] = useState<ProposalBond | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refetchToken, setRefetchToken] = useState(0);

  useEffect(() => {
    if (!descriptionHash) {
      setLoading(false);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);

    const client = buildClient();
    if (!client) {
      setError("Proposal-bonds registry is not configured.");
      setLoading(false);
      return;
    }

    client
      .getBond(descriptionHash)
      .then((result) => {
        if (!cancelled) setBond(result);
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
  }, [descriptionHash, refetchToken]);

  const refetch = useCallback(() => setRefetchToken((t) => t + 1), []);

  return { bond, loading, error, refetch };
}

interface UseBondsByProposerResult {
  bonds: ProposalBond[];
  loading: boolean;
  error: string | null;
  refetch: () => void;
}

/** Fetch every bond posted by a given proposer address, most-recent first. */
export function useBondsByProposer(address: string | null): UseBondsByProposerResult {
  const [bonds, setBonds] = useState<ProposalBond[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refetchToken, setRefetchToken] = useState(0);

  useEffect(() => {
    if (!address) {
      setLoading(false);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);

    const client = buildClient();
    if (!client) {
      setError("Proposal-bonds registry is not configured.");
      setLoading(false);
      return;
    }

    client
      .getBondsByProposer(address)
      .then((result) => {
        if (!cancelled) setBonds(result);
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
  }, [address, refetchToken]);

  const refetch = useCallback(() => setRefetchToken((t) => t + 1), []);

  return { bonds, loading, error, refetch };
}

interface IndexedProposal {
  end_ledger: number;
  executed: boolean;
  cancelled: boolean;
  queued: boolean;
}

/**
 * Whether refund_bond would currently succeed for a `Locked` bond —
 * mirrors the contract's own gate (contracts/proposal-bonds/src/lib.rs
 * `refund_bond`) so the UI can disable the Refund button rather than let
 * users pay gas + sign a transaction that's guaranteed to revert:
 *
 * - the `MaxLockLedgers` escape hatch (locked for a very long time,
 *   regardless of the correlated proposal's state), OR
 * - the proposal is terminal (executed, cancelled, or past its voting
 *   `end_ledger` without still being queued) AND `RefundGraceLedgers` has
 *   elapsed since `end_ledger`.
 */
function isRefundEligible(
  bond: ProposalBond,
  proposal: IndexedProposal | null,
  settings: ProposalBondSettings,
  currentLedger: number,
): boolean {
  if (bond.state !== "Locked" || currentLedger <= 0) return false;
  if (currentLedger >= bond.lockedLedger + settings.maxLockLedgers) return true;
  if (!proposal) return false;

  const terminal = proposal.executed || proposal.cancelled || (!proposal.queued && currentLedger > proposal.end_ledger);
  if (!terminal) return false;
  return currentLedger >= proposal.end_ledger + settings.refundGraceLedgers;
}

interface UseBondEligibilityResult {
  /** Keyed by descriptionHash. `undefined` while still loading a given bond. */
  eligibility: Record<string, boolean | undefined>;
}

/** Compute refund eligibility for a set of (typically a proposer's own) bonds. */
export function useBondEligibility(
  bonds: ProposalBond[],
  currentLedger: number,
): UseBondEligibilityResult {
  const [eligibility, setEligibility] = useState<Record<string, boolean | undefined>>({});

  useEffect(() => {
    const lockedBonds = bonds.filter((b) => b.state === "Locked");
    if (lockedBonds.length === 0 || currentLedger <= 0) return;

    let cancelled = false;
    const config = readGovernorConfig();
    const indexerUrl = readIndexerUrl();
    if (!config || !config.proposalBondsAddress || !indexerUrl) return;

    const client = new ProposalBondsClient({ ...config, indexerUrl });

    client
      .getSettings()
      .then(async (settings) => {
        const results = await Promise.all(
          lockedBonds.map(async (bond) => {
            try {
              const resp = await fetch(
                `${indexerUrl}/proposals/by-description-hash/${bond.descriptionHash}`,
              );
              const proposal: IndexedProposal | null = resp.ok ? await resp.json() : null;
              return [
                bond.descriptionHash,
                isRefundEligible(bond, proposal, settings, currentLedger),
              ] as const;
            } catch {
              return [bond.descriptionHash, false] as const;
            }
          }),
        );
        if (!cancelled) {
          setEligibility(Object.fromEntries(results));
        }
      })
      .catch(() => {
        /* leave eligibility unset — Refund stays disabled/hidden by default */
      });

    return () => {
      cancelled = true;
    };
  }, [bonds, currentLedger]);

  return { eligibility };
}
