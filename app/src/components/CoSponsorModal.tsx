"use client";

import { useState } from "react";
import toast from "react-hot-toast";
import { CoSponsorshipClient } from "@nebgov/sdk";
import { useWallet } from "../lib/wallet-context";
import { readGovernorConfig } from "../lib/nebgov-env";

interface Props {
  draftId: bigint;
  onClose: () => void;
  onSuccess?: () => void;
}

function explorerTxUrl(txHash: string): string {
  const network = process.env.NEXT_PUBLIC_NETWORK || "testnet";
  const base =
    network === "mainnet"
      ? "https://stellar.expert/explorer/public"
      : "https://stellar.expert/explorer/testnet";
  return `${base}/tx/${txHash}`;
}

export function CoSponsorModal({ draftId, onClose, onSuccess }: Props) {
  const { isConnected, connect, publicKey, signTransaction } = useWallet();
  const [submitting, setSubmitting] = useState(false);

  async function handleConfirm() {
    if (!isConnected || !publicKey) {
      try {
        await connect();
      } catch {
        toast.error("Please connect your wallet to continue.");
        return;
      }
    }
    if (!publicKey) return;

    const config = readGovernorConfig();
    if (!config || !config.coSponsorshipAddress) {
      toast.error("Co-sponsorship registry is not configured.");
      return;
    }

    setSubmitting(true);
    try {
      const client = new CoSponsorshipClient(config);
      const txHash = await client.coSponsorWithSign(publicKey, draftId, signTransaction);
      toast.success(
        <div>
          Co-sponsorship submitted!{" "}
          {txHash && (
            <a
              href={explorerTxUrl(txHash)}
              target="_blank"
              rel="noreferrer"
              className="underline"
            >
              View on Explorer →
            </a>
          )}
        </div>,
      );
      onSuccess?.();
      onClose();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      toast.error(`Failed to co-sponsor draft: ${msg}`);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      className="fixed inset-0 bg-black/40 flex items-center justify-center z-50"
      role="dialog"
      aria-modal="true"
      aria-labelledby="co-sponsor-modal-title"
    >
      <div className="bg-white dark:bg-gray-800 rounded-2xl p-6 w-full max-w-md shadow-xl">
        <div className="flex items-start justify-between mb-3">
          <div>
            <h2 id="co-sponsor-modal-title" className="text-lg font-bold text-gray-900 dark:text-gray-100">
              Co-Sponsor Draft #{draftId.toString()}
            </h2>
            <p className="text-sm text-gray-500 dark:text-gray-300">
              Pledge your current voting power toward this draft.
            </p>
          </div>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600 p-1 rounded focus:outline-none focus:ring-2 focus:ring-indigo-500"
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        <p className="text-sm text-gray-600 dark:text-gray-300 mb-4">
          Once the draft&apos;s accumulated co-sponsor power meets the governor&apos;s proposal
          threshold, the creator can finalize it into a real governance proposal.
        </p>

        <div className="flex justify-end gap-3">
          <button
            onClick={onClose}
            disabled={submitting}
            className="px-4 py-2 rounded-lg border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            onClick={handleConfirm}
            disabled={submitting}
            className="px-4 py-2 rounded-lg bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-50"
          >
            {submitting ? "Submitting…" : "Co-Sponsor"}
          </button>
        </div>
      </div>
    </div>
  );
}
