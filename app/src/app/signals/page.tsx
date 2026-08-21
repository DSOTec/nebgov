"use client";

import { useState } from "react";
import Link from "next/link";
import { useSignalingPolls } from "../../hooks/useSignalingPolls";
import { useWallet } from "../../lib/wallet-context";

type Filter = "active" | "closed";

function timeRemaining(endTime: string): string {
  const ms = new Date(endTime).getTime() - Date.now();
  if (ms <= 0) return "ended";
  const hours = Math.floor(ms / 3_600_000);
  if (hours >= 24) return `${Math.floor(hours / 24)}d left`;
  if (hours >= 1) return `${hours}h left`;
  return `${Math.max(1, Math.floor(ms / 60_000))}m left`;
}

export default function SignalsPage() {
  const { isConnected } = useWallet();
  const [filter, setFilter] = useState<Filter>("active");
  const { polls, loading } = useSignalingPolls(filter);

  return (
    <div className="max-w-3xl mx-auto px-4 py-8">
      <div className="flex items-center justify-between mb-1">
        <h1 className="text-3xl font-bold text-gray-900 dark:text-white">Signals</h1>
        {isConnected && (
          <Link
            href="/signals/create"
            className="px-4 py-2 rounded-full bg-indigo-600 text-white text-sm font-semibold hover:bg-indigo-700 transition-colors"
          >
            New signal
          </Link>
        )}
      </div>
      <p className="text-gray-500 mt-1 mb-6">
        Gasless temperature checks — signal your support before a formal on-chain proposal costs
        anyone a transaction fee. Signing is free; results are weighted by real voting power.
      </p>

      <div className="flex gap-2 mb-4">
        {(["active", "closed"] as const).map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={`px-3 py-1.5 rounded-full text-sm font-medium transition-colors ${
              filter === f
                ? "bg-indigo-600 text-white"
                : "bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-700"
            }`}
          >
            {f === "active" ? "Active" : "Closed"}
          </button>
        ))}
      </div>

      {loading && polls.length === 0 ? (
        <p className="text-sm text-gray-500">Loading signals…</p>
      ) : polls.length === 0 ? (
        <p className="text-sm text-gray-500 rounded-xl border border-dashed border-gray-200 dark:border-gray-800 bg-gray-50/80 dark:bg-gray-900/50 p-6">
          {filter === "active" ? "No active signals right now." : "No closed signals yet."}
        </p>
      ) : (
        <ul className="space-y-2">
          {polls.map((poll) => (
            <li key={poll.id}>
              <Link
                href={`/signals/${poll.id}`}
                className="block rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 p-4 hover:border-indigo-300 dark:hover:border-indigo-700 transition-colors"
              >
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="font-medium text-gray-900 dark:text-white">{poll.title}</p>
                    <p className="text-sm text-gray-500 dark:text-gray-400 mt-0.5">
                      {poll.choices.length} choices · by {poll.creatorAddress.slice(0, 4)}…
                      {poll.creatorAddress.slice(-4)}
                    </p>
                  </div>
                  <span className="text-xs text-gray-400 shrink-0">
                    {poll.finalized ? "closed" : timeRemaining(poll.endTime)}
                  </span>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
