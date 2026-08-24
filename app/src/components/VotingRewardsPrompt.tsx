"use client";

import Link from "next/link";
import { Gift } from "lucide-react";
import { useClaimableRewards } from "../hooks/useVotingRewards";

interface VotingRewardsPromptProps {
  /** The connected wallet, or `null` when nobody is connected. */
  address: string | null;
}

/**
 * Closes the loop between casting a vote and knowing it pays (Issue #1011).
 *
 * Rendered inside the proposal voting UI, it only appears once a wallet is
 * connected *and* actually has something unclaimed — an empty nudge on every
 * proposal page would be noise, and a prompt to a voter with nothing waiting
 * would be a broken promise.
 */
export function VotingRewardsPrompt({ address }: VotingRewardsPromptProps) {
  const { totalUnclaimed, unclaimed, loading, error } = useClaimableRewards(address);

  if (!address || loading || error || unclaimed.length === 0) return null;

  const amount = Number(totalUnclaimed);
  const formatted = Number.isFinite(amount)
    ? new Intl.NumberFormat("en").format(amount)
    : totalUnclaimed.toString();

  return (
    <div className="mb-4 flex flex-col gap-3 rounded-lg border border-emerald-200 bg-emerald-50 p-4 sm:flex-row sm:items-center sm:justify-between dark:border-emerald-800 dark:bg-emerald-900/20">
      <div className="flex items-start gap-3">
        <Gift
          className="mt-0.5 h-5 w-5 shrink-0 text-emerald-600 dark:text-emerald-300"
          aria-hidden="true"
        />
        <div>
          <p className="text-sm font-semibold text-emerald-900 dark:text-emerald-100">
            Voting earns rewards — you have {formatted} unclaimed
          </p>
          <p className="text-xs text-emerald-800/80 dark:text-emerald-200/80">
            Across {unclaimed.length} epoch{unclaimed.length === 1 ? "" : "s"}. Voting on this
            proposal counts toward the current one.
          </p>
        </div>
      </div>
      <Link
        href="/rewards"
        className="inline-flex shrink-0 items-center justify-center rounded-lg bg-emerald-600 px-3 py-2 text-sm font-medium text-white shadow-sm transition-colors hover:bg-emerald-700"
      >
        Claim rewards
      </Link>
    </div>
  );
}
