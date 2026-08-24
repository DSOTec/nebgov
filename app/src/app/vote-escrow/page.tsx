"use client";

import { useState } from "react";
import { useWallet } from "@/lib/wallet-context";
import { useVoteEscrow } from "@/hooks/useVoteEscrow";
import { LockCard } from "@/components/LockCard";

export default function VoteEscrowPage() {
  const { publicKey } = useWallet();
  const { lock, votingPower, stats, loading, error } = useVoteEscrow(publicKey);

  const [amount, setAmount] = useState("");
  const [duration, setDuration] = useState("");
  const [activeTab, setActiveTab] = useState<"create" | "manage">("create");

  return (
    <div className="space-y-8 py-12">
      <div className="space-y-2">
        <h1 className="text-4xl font-bold text-gray-900 dark:text-gray-50">Vote Escrow</h1>
        <p className="text-lg text-gray-600 dark:text-gray-400">
          Lock tokens for enhanced voting power with time-based decay
        </p>
      </div>

      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200">
          <p className="text-sm">{error}</p>
        </div>
      )}

      <div className="grid gap-8 md:grid-cols-3">
        <div className="md:col-span-2 space-y-6">
          <div className="rounded-xl border border-gray-200 bg-white p-6 dark:border-gray-800 dark:bg-gray-950">
            <div className="mb-6 flex gap-4 border-b border-gray-200 dark:border-gray-800">
              <button
                onClick={() => setActiveTab("create")}
                className={`pb-4 font-medium transition-colors ${
                  activeTab === "create"
                    ? "border-b-2 border-blue-500 text-blue-600 dark:text-blue-400"
                    : "text-gray-600 hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-50"
                }`}
              >
                Create Lock
              </button>
              <button
                onClick={() => setActiveTab("manage")}
                className={`pb-4 font-medium transition-colors ${
                  activeTab === "manage"
                    ? "border-b-2 border-blue-500 text-blue-600 dark:text-blue-400"
                    : "text-gray-600 hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-50"
                }`}
              >
                Manage Lock
              </button>
            </div>

            {activeTab === "create" && (
              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                    Amount
                  </label>
                  <input
                    type="number"
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                    placeholder="Enter amount to lock"
                    className="mt-1 w-full rounded-lg border border-gray-300 px-4 py-2 text-gray-900 placeholder-gray-500 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-50 dark:placeholder-gray-400"
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                    Lock Duration (Ledgers)
                  </label>
                  <input
                    type="number"
                    value={duration}
                    onChange={(e) => setDuration(e.target.value)}
                    placeholder="Enter lock duration in ledgers"
                    className="mt-1 w-full rounded-lg border border-gray-300 px-4 py-2 text-gray-900 placeholder-gray-500 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-50 dark:placeholder-gray-400"
                  />
                </div>

                {amount && duration && (
                  <div className="space-y-2 rounded-lg bg-blue-50 p-4 dark:bg-blue-950">
                    <p className="text-sm text-blue-900 dark:text-blue-200">
                      You will lock <span className="font-semibold">{amount} tokens</span> for{" "}
                      <span className="font-semibold">{duration} ledgers</span>
                    </p>
                    <p className="text-sm text-blue-800 dark:text-blue-300">
                      After unlock, your voting power will decay linearly over the lock period
                    </p>
                  </div>
                )}

                <button className="w-full rounded-lg bg-blue-600 px-4 py-2 font-medium text-white transition-colors hover:bg-blue-700 dark:bg-blue-600 dark:hover:bg-blue-700">
                  Create Lock
                </button>
              </div>
            )}

            {activeTab === "manage" && (
              <div className="space-y-4">
                {lock ? (
                  <>
                    <p className="text-sm text-gray-600 dark:text-gray-400">
                      Manage your existing lock below
                    </p>
                    <button className="w-full rounded-lg bg-green-600 px-4 py-2 font-medium text-white transition-colors hover:bg-green-700 dark:bg-green-600 dark:hover:bg-green-700">
                      Increase Amount
                    </button>
                    <button className="w-full rounded-lg bg-purple-600 px-4 py-2 font-medium text-white transition-colors hover:bg-purple-700 dark:bg-purple-600 dark:hover:bg-purple-700">
                      Extend Lock
                    </button>
                    <button className="w-full rounded-lg bg-orange-600 px-4 py-2 font-medium text-white transition-colors hover:bg-orange-700 dark:bg-orange-600 dark:hover:bg-orange-700">
                      Withdraw
                    </button>
                  </>
                ) : (
                  <p className="text-sm text-gray-600 dark:text-gray-400">
                    You don't have an active lock. Create one to get started.
                  </p>
                )}
              </div>
            )}
          </div>
        </div>

        <div>
          <LockCard lock={lock || null} currentVotingPower={votingPower} loading={loading} />
        </div>
      </div>

      {stats && (
        <div className="grid gap-6 md:grid-cols-3">
          <div className="rounded-xl border border-gray-200 bg-white p-6 dark:border-gray-800 dark:bg-gray-950">
            <p className="text-sm text-gray-600 dark:text-gray-400">Total Locked</p>
            <p className="mt-2 text-2xl font-bold text-gray-900 dark:text-gray-50">
              {(stats.total_locked || 0n).toString()}
            </p>
          </div>

          <div className="rounded-xl border border-gray-200 bg-white p-6 dark:border-gray-800 dark:bg-gray-950">
            <p className="text-sm text-gray-600 dark:text-gray-400">Active Locks</p>
            <p className="mt-2 text-2xl font-bold text-gray-900 dark:text-gray-50">
              {stats.num_active_locks}
            </p>
          </div>

          <div className="rounded-xl border border-gray-200 bg-white p-6 dark:border-gray-800 dark:bg-gray-950">
            <p className="text-sm text-gray-600 dark:text-gray-400">Avg Duration</p>
            <p className="mt-2 text-2xl font-bold text-gray-900 dark:text-gray-50">
              {stats.avg_lock_duration} ledgers
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
