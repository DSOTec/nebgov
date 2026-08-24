"use client";

import { VoteEscrowLock } from "@nebgov/sdk";

interface LockCardProps {
  lock: VoteEscrowLock | null;
  currentVotingPower: bigint;
  loading?: boolean;
}

export function LockCard({ lock, currentVotingPower, loading }: LockCardProps) {
  if (loading) {
    return (
      <div className="rounded-xl border border-gray-200 bg-white p-6 dark:border-gray-800 dark:bg-gray-950">
        <div className="animate-pulse space-y-4">
          <div className="h-4 w-1/3 rounded bg-gray-200 dark:bg-gray-800" />
          <div className="space-y-2">
            <div className="h-3 w-1/2 rounded bg-gray-200 dark:bg-gray-800" />
            <div className="h-3 w-2/3 rounded bg-gray-200 dark:bg-gray-800" />
          </div>
        </div>
      </div>
    );
  }

  if (!lock) {
    return (
      <div className="rounded-xl border border-gray-200 bg-white p-6 text-center dark:border-gray-800 dark:bg-gray-950">
        <p className="text-sm text-gray-600 dark:text-gray-400">No active lock</p>
      </div>
    );
  }

  const durationLedgers = lock.end_ledger - lock.start_ledger;
  const decayPercentage =
    durationLedgers > 0
      ? ((Number(lock.initial_voting_power - lock.amount) * 100) /
          Number(lock.initial_voting_power)) |
        0
      : 0;

  return (
    <div className="rounded-xl border border-gray-200 bg-white p-6 dark:border-gray-800 dark:bg-gray-950">
      <h3 className="mb-4 text-lg font-semibold text-gray-900 dark:text-gray-50">
        Your Lock
      </h3>

      <div className="space-y-3">
        <div className="flex justify-between">
          <span className="text-sm text-gray-600 dark:text-gray-400">Locked Amount</span>
          <span className="text-sm font-medium text-gray-900 dark:text-gray-50">
            {lock.amount.toString()} tokens
          </span>
        </div>

        <div className="flex justify-between">
          <span className="text-sm text-gray-600 dark:text-gray-400">Multiplier</span>
          <span className="text-sm font-medium text-gray-900 dark:text-gray-50">
            {((Number(lock.initial_voting_power) / Number(lock.amount)) * 100) / 100}x
          </span>
        </div>

        <div className="flex justify-between">
          <span className="text-sm text-gray-600 dark:text-gray-400">Voting Power</span>
          <span className="text-sm font-medium text-gray-900 dark:text-gray-50">
            {currentVotingPower.toString()}
          </span>
        </div>

        <div className="flex justify-between">
          <span className="text-sm text-gray-600 dark:text-gray-400">Duration</span>
          <span className="text-sm font-medium text-gray-900 dark:text-gray-50">
            {durationLedgers} ledgers
          </span>
        </div>

        <div className="flex justify-between">
          <span className="text-sm text-gray-600 dark:text-gray-400">Unlock Ledger</span>
          <span className="text-sm font-medium text-gray-900 dark:text-gray-50">
            {lock.end_ledger}
          </span>
        </div>

        <div className="flex justify-between">
          <span className="text-sm text-gray-600 dark:text-gray-400">Status</span>
          <span className="text-sm font-medium">
            {lock.withdrawn ? (
              <span className="text-red-600 dark:text-red-400">Withdrawn</span>
            ) : (
              <span className="text-green-600 dark:text-green-400">Active</span>
            )}
          </span>
        </div>

        <div className="mt-4 pt-4">
          <div className="mb-2 flex justify-between">
            <span className="text-xs text-gray-600 dark:text-gray-400">Decay Progress</span>
            <span className="text-xs font-medium text-gray-900 dark:text-gray-50">
              {decayPercentage}%
            </span>
          </div>
          <div className="h-2 w-full rounded-full bg-gray-200 dark:bg-gray-800">
            <div
              className="h-2 rounded-full bg-blue-500"
              style={{ width: `${decayPercentage}%` }}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
