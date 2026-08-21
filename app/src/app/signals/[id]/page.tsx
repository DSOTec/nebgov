"use client";

import { useState } from "react";
import { useParams } from "next/navigation";
import toast from "react-hot-toast";
import { useSignalingPoll, useSignalingActions } from "../../../hooks/useSignalingPolls";
import { SignalResultsChart } from "../../../components/SignalResultsChart";
import { AnchorVerifiedBadge } from "../../../components/AnchorVerifiedBadge";
import { useWallet } from "../../../lib/wallet-context";

export default function SignalDetailPage() {
  const params = useParams<{ id: string }>();
  const pollId = Number(params.id);
  const { isConnected } = useWallet();
  const { poll, results, loading, refresh } = useSignalingPoll(Number.isFinite(pollId) ? pollId : null);
  const { castVote } = useSignalingActions();
  const [selected, setSelected] = useState<number | null>(null);
  const [submitting, setSubmitting] = useState(false);

  if (loading && !poll) {
    return <p className="max-w-2xl mx-auto px-4 py-8 text-sm text-gray-500">Loading signal…</p>;
  }
  if (!poll) {
    return <p className="max-w-2xl mx-auto px-4 py-8 text-sm text-gray-500">Signal not found.</p>;
  }

  const isOpen = !poll.finalized && new Date(poll.endTime) > new Date();

  async function handleCastSignal() {
    if (selected === null) {
      toast.error("Pick a choice first.");
      return;
    }
    setSubmitting(true);
    try {
      await castVote(pollId, selected);
      toast.success("Signal cast — no transaction fee, nothing was submitted on-chain.");
      await refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to cast signal");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="max-w-2xl mx-auto px-4 py-8">
      <div className="flex items-center gap-2 mb-1">
        <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-indigo-50 text-indigo-700 border border-indigo-200 dark:bg-indigo-900/30 dark:text-indigo-300 dark:border-indigo-800">
          Non-binding signal
        </span>
        {poll.finalized && <AnchorVerifiedBadge pollId={pollId} resultHash={poll.resultHash} />}
      </div>
      <h1 className="text-3xl font-bold text-gray-900 dark:text-white mb-1">{poll.title}</h1>
      <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">
        by {poll.creatorAddress.slice(0, 4)}…{poll.creatorAddress.slice(-4)} · snapshot ledger{" "}
        {poll.snapshotLedger} · {poll.finalized ? "closed" : `ends ${new Date(poll.endTime).toLocaleString()}`}
      </p>
      <p className="text-gray-700 dark:text-gray-300 whitespace-pre-wrap mb-6">{poll.description}</p>

      <div className="rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 p-4 mb-6">
        {results ? <SignalResultsChart results={results} /> : <p className="text-sm text-gray-500">Loading results…</p>}
      </div>

      {isOpen && (
        <div className="rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 p-4">
          <p className="text-sm font-medium text-gray-900 dark:text-white mb-3">Cast your signal</p>
          <div className="flex flex-wrap gap-2 mb-4">
            {poll.choices.map((choice, i) => (
              <button
                key={choice}
                onClick={() => setSelected(i)}
                className={`px-3 py-1.5 rounded-full text-sm font-medium border transition-colors ${
                  selected === i
                    ? "bg-indigo-600 border-indigo-600 text-white"
                    : "border-gray-300 dark:border-gray-700 text-gray-700 dark:text-gray-300 hover:border-indigo-400"
                }`}
              >
                {choice}
              </button>
            ))}
          </div>
          <button
            onClick={() => void handleCastSignal()}
            disabled={submitting}
            className="px-4 py-2 rounded-full bg-indigo-600 text-white text-sm font-semibold hover:bg-indigo-700 disabled:opacity-50 transition-colors"
          >
            {submitting ? "Signing…" : isConnected ? "Cast signal" : "Connect & cast signal"}
          </button>
          <p className="text-xs text-gray-400 mt-2">
            You&apos;ll be asked to sign a message with your wallet — this is free and never
            submits a transaction.
          </p>
        </div>
      )}
    </div>
  );
}
