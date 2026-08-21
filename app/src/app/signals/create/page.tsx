"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import toast from "react-hot-toast";
import { useSignalingActions } from "../../../hooks/useSignalingPolls";
import { useLedgerClock } from "../../../lib/hooks/useLedgerClock";
import { useWallet } from "../../../lib/wallet-context";

export default function CreateSignalPage() {
  const router = useRouter();
  const { isConnected } = useWallet();
  const { createPoll } = useSignalingActions();
  const { currentLedger } = useLedgerClock();

  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [choices, setChoices] = useState(["For", "Against", "Abstain"]);
  const [snapshotLedger, setSnapshotLedger] = useState<number>(0);
  const [durationHours, setDurationHours] = useState(72);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (currentLedger > 0 && snapshotLedger === 0) setSnapshotLedger(currentLedger);
  }, [currentLedger, snapshotLedger]);

  function updateChoice(index: number, value: string) {
    setChoices((prev) => prev.map((c, i) => (i === index ? value : c)));
  }

  function addChoice() {
    if (choices.length >= 10) return;
    setChoices((prev) => [...prev, ""]);
  }

  function removeChoice(index: number) {
    if (choices.length <= 2) return;
    setChoices((prev) => prev.filter((_, i) => i !== index));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmedChoices = choices.map((c) => c.trim()).filter(Boolean);
    if (!title.trim() || !description.trim() || trimmedChoices.length < 2 || !snapshotLedger) {
      toast.error("Fill in a title, description, and at least two choices.");
      return;
    }

    setSubmitting(true);
    try {
      const pollId = await createPoll({
        title: title.trim(),
        description: description.trim(),
        choices: trimmedChoices,
        snapshotLedger,
        startTime: new Date(),
        endTime: new Date(Date.now() + durationHours * 3_600_000),
      });
      toast.success("Signal created");
      router.push(`/signals/${pollId}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to create signal");
    } finally {
      setSubmitting(false);
    }
  }

  if (!isConnected) {
    return (
      <div className="max-w-2xl mx-auto px-4 py-8">
        <p className="text-sm text-gray-500 rounded-xl border border-dashed border-gray-200 dark:border-gray-800 bg-gray-50/80 dark:bg-gray-900/50 p-6">
          Connect your wallet to create a signal. Your address needs at least the governor&apos;s
          current proposal threshold in voting power.
        </p>
      </div>
    );
  }

  return (
    <div className="max-w-2xl mx-auto px-4 py-8">
      <h1 className="text-3xl font-bold text-gray-900 dark:text-white mb-1">New signal</h1>
      <p className="text-gray-500 mb-6">
        Non-binding, gasless temperature check. Votes are signed messages, not transactions.
      </p>

      <form onSubmit={handleSubmit} className="space-y-5">
        <div>
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
            Title
          </label>
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            maxLength={200}
            className="w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 px-3 py-2 text-sm"
            placeholder="Should we fund grant #4?"
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
            Description
          </label>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={4}
            className="w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 px-3 py-2 text-sm"
            placeholder="Context ahead of a formal on-chain proposal…"
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
            Choices
          </label>
          <div className="space-y-2">
            {choices.map((choice, i) => (
              <div key={i} className="flex gap-2">
                <input
                  value={choice}
                  onChange={(e) => updateChoice(i, e.target.value)}
                  maxLength={100}
                  className="flex-1 rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 px-3 py-2 text-sm"
                  placeholder={`Choice ${i + 1}`}
                />
                {choices.length > 2 && (
                  <button
                    type="button"
                    onClick={() => removeChoice(i)}
                    className="text-xs text-rose-600 hover:text-rose-800 px-2"
                  >
                    Remove
                  </button>
                )}
              </div>
            ))}
          </div>
          {choices.length < 10 && (
            <button
              type="button"
              onClick={addChoice}
              className="mt-2 text-xs font-medium text-indigo-600 hover:text-indigo-800"
            >
              + Add choice
            </button>
          )}
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
              Snapshot ledger
            </label>
            <input
              type="number"
              value={snapshotLedger || ""}
              onChange={(e) => setSnapshotLedger(Number(e.target.value))}
              className="w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 px-3 py-2 text-sm"
            />
            <p className="text-xs text-gray-400 mt-1">Voting power is weighted as of this ledger.</p>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
              Duration (hours)
            </label>
            <input
              type="number"
              min={1}
              value={durationHours}
              onChange={(e) => setDurationHours(Number(e.target.value))}
              className="w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 px-3 py-2 text-sm"
            />
          </div>
        </div>

        <button
          type="submit"
          disabled={submitting}
          className="w-full px-4 py-2.5 rounded-full bg-indigo-600 text-white text-sm font-semibold hover:bg-indigo-700 disabled:opacity-50 transition-colors"
        >
          {submitting ? "Creating…" : "Create signal"}
        </button>
      </form>
    </div>
  );
}
