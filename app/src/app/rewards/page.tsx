"use client";

/**
 * Voting participation rewards page (Issue #1011).
 *
 * Shows how far the current epoch has run, what the connected wallet has
 * earned across every past epoch, and a "Claim All" flow that submits each
 * unclaimed epoch's Merkle proof in sequence. Proofs come from the backend,
 * which built them from the same tree whose root was published on-chain —
 * the page never rebuilds a tree client-side.
 */

import { useMemo, useState } from "react";
import toast from "react-hot-toast";
import { Gift } from "lucide-react";
import { useWallet } from "../../lib/wallet-context";
import { useLedgerClock } from "../../lib/hooks/useLedgerClock";
import {
  buildVotingRewardsClient,
  useClaimableRewards,
  useCurrentRewardEpoch,
  useRewardEpochs,
  type ClaimableRewardRow,
} from "../../hooks/useVotingRewards";
import { EpochRewardCard } from "../../components/EpochRewardCard";
import { RewardsLeaderboard } from "../../components/RewardsLeaderboard";
import { Skeleton } from "../../components/ui/Skeleton";

function formatAmount(amount: bigint): string {
  const n = Number(amount);
  if (!Number.isFinite(n)) return amount.toString();
  return new Intl.NumberFormat("en").format(n);
}

export default function RewardsPage() {
  const { isConnected, publicKey, signTransaction, connect } = useWallet();
  const { currentLedger } = useLedgerClock();
  const { epoch: currentEpoch, loading: epochLoading, error: epochError } =
    useCurrentRewardEpoch();
  const { epochs, loading: epochsLoading, refetch: refetchEpochs } = useRewardEpochs(20);
  const {
    rewards,
    unclaimed,
    totalUnclaimed,
    totalEarned,
    loading: rewardsLoading,
    refetch: refetchRewards,
  } = useClaimableRewards(publicKey ?? null);
  const [claimingEpoch, setClaimingEpoch] = useState<string | null>(null);
  const [claimingAll, setClaimingAll] = useState(false);

  const rewardsByEpoch = useMemo(() => {
    const map = new Map<string, ClaimableRewardRow>();
    for (const reward of rewards) map.set(reward.epochId.toString(), reward);
    return map;
  }, [rewards]);

  const latestPublishedEpochId = useMemo(
    () => epochs.find((epoch) => epoch.publishedAt !== null)?.epochId ?? null,
    [epochs],
  );

  const progressPct = useMemo(() => {
    if (!currentEpoch || currentLedger <= 0) return 0;
    const span = currentEpoch.endLedger - currentEpoch.startLedger;
    if (span <= 0) return 100;
    const elapsed = currentLedger - currentEpoch.startLedger;
    return Math.max(0, Math.min(100, Math.round((elapsed / span) * 100)));
  }, [currentEpoch, currentLedger]);

  async function claimOne(reward: ClaimableRewardRow): Promise<void> {
    if (!publicKey) return;
    const client = buildVotingRewardsClient();
    if (!client) {
      toast.error("Voting rewards are not configured for this deployment.");
      return;
    }
    await client.claimWithSign(
      publicKey,
      reward.epochId,
      reward.amount,
      reward.merkleProof,
      signTransaction,
    );
  }

  async function handleClaim(reward: ClaimableRewardRow) {
    setClaimingEpoch(reward.epochId.toString());
    try {
      await claimOne(reward);
      toast.success(`Claimed epoch ${reward.epochId.toString()}.`);
      refetchRewards();
      refetchEpochs();
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Claim failed");
    } finally {
      setClaimingEpoch(null);
    }
  }

  async function handleClaimAll() {
    setClaimingAll(true);
    let claimed = 0;
    try {
      // One transaction per epoch, in sequence: each claim is verified
      // against its own epoch's root, and the wallet has to sign each one.
      for (const reward of unclaimed) {
        setClaimingEpoch(reward.epochId.toString());
        try {
          await claimOne(reward);
          claimed += 1;
        } catch (e: unknown) {
          // Stop at the first failure rather than asking the wallet to sign
          // a run of transactions that are likely to fail the same way.
          toast.error(
            `Epoch ${reward.epochId.toString()}: ${
              e instanceof Error ? e.message : "claim failed"
            }`,
          );
          break;
        }
      }
      if (claimed > 0) {
        toast.success(`Claimed ${claimed} epoch${claimed === 1 ? "" : "s"}.`);
        refetchRewards();
        refetchEpochs();
      }
    } finally {
      setClaimingEpoch(null);
      setClaimingAll(false);
    }
  }

  return (
    <div className="max-w-4xl mx-auto px-4 py-8">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">Voting Rewards</h1>
        <p className="text-sm text-gray-500 dark:text-gray-300">
          Every epoch, a share of the rewards pool is split across the addresses that voted,
          in proportion to the voting power they cast. Claim yours below.
        </p>
      </div>

      {/* Current epoch progress */}
      <section className="mb-8 rounded-xl border border-gray-200 dark:border-gray-700 p-5">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-600 dark:text-gray-400">
          Current epoch
        </h2>
        {epochLoading ? (
          <Skeleton className="mt-3 h-6 w-2/3" />
        ) : epochError || !currentEpoch ? (
          <p className="mt-3 text-sm text-gray-500 dark:text-gray-400">
            {epochError ?? "No epoch is open."}
          </p>
        ) : (
          <>
            <p className="mt-2 text-lg font-semibold text-gray-900 dark:text-gray-100">
              Epoch {currentEpoch.id.toString()}
            </p>
            <p className="text-xs text-gray-500 dark:text-gray-400">
              Ledgers {currentEpoch.startLedger.toLocaleString()} –{" "}
              {currentEpoch.endLedger.toLocaleString()}
              {currentLedger > 0 && ` · now at ${currentLedger.toLocaleString()}`}
            </p>
            <div
              className="mt-3 h-2 w-full overflow-hidden rounded-full bg-gray-200 dark:bg-gray-700"
              role="progressbar"
              aria-valuenow={progressPct}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-label="Current epoch progress"
            >
              <div className="h-full bg-indigo-600" style={{ width: `${progressPct}%` }} />
            </div>
            <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">
              Vote on any active proposal before this epoch closes to earn a share.
            </p>
          </>
        )}
      </section>

      {!isConnected ? (
        <div className="rounded-xl border border-indigo-200 bg-indigo-50 p-5 dark:border-indigo-800 dark:bg-slate-900/80">
          <p className="text-base font-semibold text-slate-900 dark:text-white">
            Connect your wallet to see what you&apos;ve earned
          </p>
          <button
            onClick={connect}
            className="mt-3 inline-flex items-center justify-center rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white shadow-sm transition-colors hover:bg-indigo-700"
          >
            Connect Wallet
          </button>
        </div>
      ) : (
        <>
          {/* Totals + Claim All */}
          <section className="mb-8 flex flex-col gap-4 rounded-xl border border-gray-200 p-5 sm:flex-row sm:items-center sm:justify-between dark:border-gray-700">
            <div className="flex gap-8">
              <div>
                <p className="text-xs uppercase tracking-wide text-gray-500 dark:text-gray-400">
                  Unclaimed
                </p>
                <p className="text-2xl font-bold text-gray-900 dark:text-gray-100">
                  {rewardsLoading ? "—" : formatAmount(totalUnclaimed)}
                </p>
              </div>
              <div>
                <p className="text-xs uppercase tracking-wide text-gray-500 dark:text-gray-400">
                  Earned all-time
                </p>
                <p className="text-2xl font-bold text-gray-900 dark:text-gray-100">
                  {rewardsLoading ? "—" : formatAmount(totalEarned)}
                </p>
              </div>
            </div>

            <button
              onClick={handleClaimAll}
              disabled={claimingAll || unclaimed.length === 0}
              className="inline-flex items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white shadow-sm transition-colors hover:bg-indigo-700 disabled:opacity-50"
            >
              <Gift className="h-4 w-4" aria-hidden="true" />
              {claimingAll
                ? "Claiming…"
                : `Claim All${unclaimed.length > 0 ? ` (${unclaimed.length})` : ""}`}
            </button>
          </section>

          {/* Per-epoch history */}
          <section className="mb-8">
            <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-gray-600 dark:text-gray-400">
              Your epochs
            </h2>
            {epochsLoading || rewardsLoading ? (
              <div className="space-y-3">
                <Skeleton className="h-20 w-full" />
                <Skeleton className="h-20 w-full" />
              </div>
            ) : epochs.length === 0 ? (
              <p className="text-sm text-gray-500 dark:text-gray-400">
                No reward epoch has been computed yet.
              </p>
            ) : (
              <div className="space-y-3">
                {epochs.map((epoch) => {
                  const reward = rewardsByEpoch.get(epoch.epochId.toString());
                  return (
                    <EpochRewardCard
                      key={epoch.epochId.toString()}
                      epoch={epoch}
                      reward={reward}
                      claiming={claimingEpoch === epoch.epochId.toString()}
                      onClaim={reward ? () => handleClaim(reward) : undefined}
                    />
                  );
                })}
              </div>
            )}
          </section>
        </>
      )}

      {/* Leaderboard */}
      <section>
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-gray-600 dark:text-gray-400">
          Top earners
          {latestPublishedEpochId !== null && ` · epoch ${latestPublishedEpochId.toString()}`}
        </h2>
        <RewardsLeaderboard
          epochId={latestPublishedEpochId}
          highlightAddress={publicKey ?? null}
        />
      </section>
    </div>
  );
}
