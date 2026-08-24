"use client";

import { CheckCircle2, Clock, Gift } from "lucide-react";
import type { ClaimableRewardRow, RewardEpochSummary } from "../hooks/useVotingRewards";

function formatAmount(amount: bigint): string {
  const n = Number(amount);
  if (!Number.isFinite(n)) return amount.toString();
  return new Intl.NumberFormat("en").format(n);
}

interface EpochRewardCardProps {
  epoch: RewardEpochSummary;
  /** This wallet's reward for the epoch, if it earned one. */
  reward?: ClaimableRewardRow;
  /** Omitted for an epoch whose root hasn't been published yet. */
  onClaim?: () => void;
  claiming?: boolean;
}

/**
 * One past reward epoch, from the connected wallet's point of view (Issue #1011).
 *
 * An epoch is only claimable once its Merkle root has been published
 * on-chain — until then the backend has computed an amount but the contract
 * has nothing to verify a proof against, so the card shows the pending
 * amount without offering a button that would certainly revert.
 */
export function EpochRewardCard({ epoch, reward, onClaim, claiming }: EpochRewardCardProps) {
  const published = epoch.publishedAt !== null;
  const claimable = published && reward !== undefined && !reward.claimed;

  return (
    <div className="border border-gray-200 dark:border-gray-700 rounded-xl p-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <span className="font-medium text-gray-900 dark:text-gray-100">
              Epoch {epoch.epochId.toString()}
            </span>
            {published ? (
              <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300">
                <CheckCircle2 className="h-3 w-3" aria-hidden="true" />
                Published
              </span>
            ) : (
              <span className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-700 dark:bg-amber-900/30 dark:text-amber-300">
                <Clock className="h-3 w-3" aria-hidden="true" />
                Awaiting publication
              </span>
            )}
          </div>
          <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
            Ledgers {epoch.startLedger.toLocaleString()} – {epoch.endLedger.toLocaleString()} ·
            pool {formatAmount(epoch.totalRewardAmount)}
          </p>
        </div>

        <div className="text-right">
          {reward ? (
            <>
              <p className="text-lg font-semibold text-gray-900 dark:text-gray-100">
                {formatAmount(reward.amount)}
              </p>
              <p className="text-xs text-gray-500 dark:text-gray-400">
                {reward.claimed ? "Claimed" : published ? "Ready to claim" : "Pending"}
              </p>
            </>
          ) : (
            <p className="text-sm text-gray-400 dark:text-gray-500">No reward</p>
          )}
        </div>
      </div>

      {claimable && onClaim && (
        <button
          onClick={onClaim}
          disabled={claiming}
          className="mt-4 inline-flex items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white shadow-sm transition-colors hover:bg-indigo-700 disabled:opacity-50"
        >
          <Gift className="h-4 w-4" aria-hidden="true" />
          {claiming ? "Claiming…" : `Claim ${formatAmount(reward!.amount)}`}
        </button>
      )}
    </div>
  );
}
