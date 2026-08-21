"use client";

/**
 * Lets a proposal's own proposer lock (or retry locking) their proposal
 * bond from the proposal detail page. Addresses a maintainer review note on
 * PR #1003: the propose wizard fires the bond-lock transaction right after
 * the proposal already exists on-chain, and previously had no retry path
 * if that second transaction failed — the proposal would end up
 * permanently unbonded with no way to fix it from the UI.
 */

import { useEffect, useState } from "react";
import toast from "react-hot-toast";
import { ProposalBondsClient, type ProposalBond } from "@nebgov/sdk";
import { useWallet } from "../lib/wallet-context";
import { readGovernorConfig, readIndexerUrl } from "../lib/nebgov-env";
import { BondStatusBadge } from "./BondStatusBadge";

interface Props {
  descriptionHash: string;
  proposer: string;
}

export function ProposalBondCard({ descriptionHash, proposer }: Props) {
  const { isConnected, publicKey, signTransaction } = useWallet();
  const [bond, setBond] = useState<ProposalBond | null>(null);
  const [loading, setLoading] = useState(true);
  const [locking, setLocking] = useState(false);

  const client = (() => {
    const config = readGovernorConfig();
    if (!config || !config.proposalBondsAddress) return null;
    const indexerUrl = readIndexerUrl();
    return new ProposalBondsClient({ ...config, ...(indexerUrl ? { indexerUrl } : {}) });
  })();

  useEffect(() => {
    if (!client || !descriptionHash) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    client
      .getBond(descriptionHash)
      .then((result) => {
        if (!cancelled) setBond(result);
      })
      .catch(() => {
        /* Bonding is optional/best-effort here — swallow and just show no bond. */
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [descriptionHash]);

  if (!client || loading) return null;
  if (bond) {
    return (
      <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl p-6 mb-6">
        <div className="flex items-center justify-between gap-4">
          <h2 className="text-sm font-semibold text-gray-600 dark:text-gray-400 uppercase tracking-wide">
            Proposal Bond
          </h2>
          <BondStatusBadge state={bond.state} />
        </div>
      </div>
    );
  }

  // Only the proposer can lock a bond for their own proposal, and only
  // once connected — nothing to offer otherwise.
  if (!isConnected || !publicKey || publicKey !== proposer) return null;

  async function handleLock() {
    if (!client || !publicKey || !signTransaction) return;
    setLocking(true);
    try {
      await client.lockBondWithSign(publicKey, descriptionHash, signTransaction);
      toast.success("Proposal bond locked.");
      const refreshed = await client.getBond(descriptionHash);
      setBond(refreshed);
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Locking the bond failed");
    } finally {
      setLocking(false);
    }
  }

  return (
    <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl p-6 mb-6">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h2 className="text-sm font-semibold text-gray-600 dark:text-gray-400 uppercase tracking-wide mb-1">
            Proposal Bond
          </h2>
          <p className="text-sm text-gray-500 dark:text-gray-400">
            This proposal has no bond locked yet.
          </p>
        </div>
        <button
          onClick={() => void handleLock()}
          disabled={locking}
          className="px-4 py-2 border border-gray-200 rounded-lg text-sm font-medium hover:bg-gray-50 transition-colors disabled:opacity-50"
        >
          {locking ? "Locking..." : "Lock Bond"}
        </button>
      </div>
    </div>
  );
}
