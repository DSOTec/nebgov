"use client";

/**
 * Proposal bonds page (Issue #996).
 *
 * Lists the connected wallet's own proposer bonds and lets them manually
 * trigger a refund once their correlated proposal has reached a terminal
 * state and the post-terminal grace window has elapsed — see the
 * ProposalBonds contract (contracts/proposal-bonds) and ProposalBondsClient
 * in the SDK.
 */

import { useState } from "react";
import toast from "react-hot-toast";
import { ProposalBondsClient } from "@nebgov/sdk";
import { useWallet } from "../../lib/wallet-context";
import { readGovernorConfig, readIndexerUrl } from "../../lib/nebgov-env";
import { useBondsByProposer, useBondEligibility } from "../../hooks/useProposalBonds";
import { BondStatusBadge } from "../../components/BondStatusBadge";
import { Skeleton } from "../../components/ui/Skeleton";
import { useLedgerClock } from "../../lib/hooks/useLedgerClock";

function formatAddress(address: string): string {
  return `${address.slice(0, 4)}...${address.slice(-4)}`;
}

function BondCardSkeleton() {
  return (
    <div className="border border-gray-200 dark:border-gray-700 rounded-xl p-4">
      <Skeleton className="h-4 w-1/3 mb-2" />
      <Skeleton className="h-3 w-2/3 mb-4" />
      <Skeleton className="h-2 w-full" />
    </div>
  );
}

export default function BondsPage() {
  const { isConnected, publicKey, signTransaction } = useWallet();
  const { bonds, loading, error, refetch } = useBondsByProposer(publicKey ?? null);
  const { currentLedger } = useLedgerClock();
  const { eligibility } = useBondEligibility(bonds, currentLedger);
  const [refundingHash, setRefundingHash] = useState<string | null>(null);

  async function handleRefund(descriptionHash: string) {
    if (!publicKey || !signTransaction) return;
    const config = readGovernorConfig();
    if (!config || !config.proposalBondsAddress) return;
    const indexerUrl = readIndexerUrl();
    if (!indexerUrl) {
      toast.error("Indexer is not configured — cannot resolve the correlated proposal.");
      return;
    }

    setRefundingHash(descriptionHash);
    try {
      const client = new ProposalBondsClient({ ...config, indexerUrl });
      const proposalId = await client.getProposalIdForDescriptionHash(descriptionHash);
      if (proposalId === null) {
        toast.error("Correlated proposal not found in the indexer yet.");
        return;
      }
      await client.refundBondWithSign(publicKey, descriptionHash, proposalId, signTransaction);
      toast.success("Bond refund submitted.");
      refetch();
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Refund failed");
    } finally {
      setRefundingHash(null);
    }
  }

  return (
    <div className="max-w-4xl mx-auto px-4 py-8">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">
          My Proposal Bonds
        </h1>
        <p className="text-sm text-gray-500 dark:text-gray-300">
          Bonds you&apos;ve posted alongside proposals. Refund once your proposal reaches a
          terminal state and the grace window elapses, or check back if it was slashed by a
          follow-up governance vote.
        </p>
      </div>

      {!isConnected && (
        <div className="text-center py-16 text-gray-500 dark:text-gray-400">
          Connect your wallet to view your proposal bonds.
        </div>
      )}

      {isConnected && error && (
        <div className="rounded-lg border border-red-200 bg-red-50 dark:bg-red-900/20 dark:border-red-800 p-4 text-sm text-red-700 dark:text-red-300 mb-4">
          {error}
        </div>
      )}

      {isConnected && loading && (
        <div className="space-y-4">
          <BondCardSkeleton />
          <BondCardSkeleton />
        </div>
      )}

      {isConnected && !loading && !error && bonds.length === 0 && (
        <div className="text-center py-16 text-gray-500 dark:text-gray-400">
          No proposal bonds yet.
        </div>
      )}

      {isConnected && !loading && bonds.length > 0 && (
        <div className="space-y-4">
          {bonds.map((bond) => (
            <div
              key={bond.descriptionHash}
              className="border border-gray-200 dark:border-gray-700 rounded-xl p-4"
            >
              <div className="flex items-center justify-between mb-1">
                <span className="font-medium text-gray-900 dark:text-gray-100">
                  {formatAddress(bond.proposer)}
                </span>
                <BondStatusBadge state={bond.state} />
              </div>
              <p className="text-xs text-gray-500 dark:text-gray-400 mb-3 break-all">
                {bond.descriptionHash}
              </p>
              <div className="flex items-center justify-between text-xs text-gray-500 dark:text-gray-400">
                <span>Amount: {bond.amount.toString()}</span>
                <span>Locked at ledger {bond.lockedLedger}</span>
              </div>
              {bond.state === "Locked" && eligibility[bond.descriptionHash] && (
                <button
                  onClick={() => handleRefund(bond.descriptionHash)}
                  disabled={refundingHash === bond.descriptionHash}
                  className="mt-3 px-4 py-2 rounded-lg bg-indigo-600 text-white hover:bg-indigo-700 text-sm font-medium disabled:opacity-50"
                >
                  {refundingHash === bond.descriptionHash ? "Refunding..." : "Refund"}
                </button>
              )}
              {bond.state === "Locked" && eligibility[bond.descriptionHash] === false && (
                <p className="mt-3 text-xs text-gray-400 dark:text-gray-500">
                  Not yet refund-eligible — waiting on your proposal to reach a terminal state
                  and the post-terminal grace window to elapse.
                </p>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
