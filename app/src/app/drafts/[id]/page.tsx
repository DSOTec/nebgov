"use client";

import { useState } from "react";
import { useParams } from "next/navigation";
import toast from "react-hot-toast";
import { CoSponsorshipClient } from "@nebgov/sdk";
import { useDraft } from "../../../hooks/useDraft";
import { useWallet } from "../../../lib/wallet-context";
import { readGovernorConfig } from "../../../lib/nebgov-env";
import { CoSponsorModal } from "../../../components/CoSponsorModal";
import { Skeleton } from "../../../components/ui/Skeleton";

function formatAddress(address: string): string {
  return `${address.slice(0, 4)}...${address.slice(-4)}`;
}

export default function DraftDetailPage() {
  const params = useParams<{ id: string }>();
  const draftId = (() => {
    try {
      return BigInt(params.id);
    } catch {
      return null;
    }
  })();

  const { draft, loading, error, refetch } = useDraft(draftId);
  const { isConnected, connect, publicKey, signTransaction } = useWallet();
  const [showCoSponsorModal, setShowCoSponsorModal] = useState(false);
  const [busy, setBusy] = useState(false);

  if (draftId === null) {
    return (
      <div className="max-w-2xl mx-auto px-4 py-8 text-red-600">Invalid draft id.</div>
    );
  }

  const isCreator = !!publicKey && !!draft && publicKey === draft.creator;
  const alreadyCoSponsored =
    !!publicKey && !!draft && draft.coSponsors.includes(publicKey);

  async function withWallet(action: (publicKey: string) => Promise<void>) {
    if (!isConnected || !publicKey) {
      try {
        await connect();
      } catch {
        toast.error("Please connect your wallet to continue.");
        return;
      }
    }
    if (!publicKey) return;
    setBusy(true);
    try {
      await action(publicKey);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function handleWithdraw() {
    await withWallet(async (pk) => {
      const config = readGovernorConfig();
      if (!config?.coSponsorshipAddress) throw new Error("Co-sponsorship not configured");
      const client = new CoSponsorshipClient(config);
      await client.withdrawCoSponsorshipWithSign(pk, draftId, signTransaction);
      toast.success("Co-sponsorship withdrawn.");
      refetch();
    });
  }

  async function handleFinalize() {
    await withWallet(async (pk) => {
      const config = readGovernorConfig();
      if (!config?.coSponsorshipAddress) throw new Error("Co-sponsorship not configured");
      const client = new CoSponsorshipClient(config);
      const proposalId = await client.finalizeDraftWithSign(pk, draftId, signTransaction);
      toast.success(`Draft finalized as proposal #${proposalId.toString()}!`);
      refetch();
    });
  }

  async function handleCancel() {
    await withWallet(async (pk) => {
      const config = readGovernorConfig();
      if (!config?.coSponsorshipAddress) throw new Error("Co-sponsorship not configured");
      const client = new CoSponsorshipClient(config);
      await client.cancelDraftWithSign(pk, draftId, signTransaction);
      toast.success("Draft cancelled.");
      refetch();
    });
  }

  return (
    <div className="max-w-2xl mx-auto px-4 py-8">
      {loading && (
        <div className="space-y-4">
          <Skeleton className="h-8 w-1/2" />
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-2/3" />
        </div>
      )}

      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 dark:bg-red-900/20 dark:border-red-800 p-4 text-sm text-red-700 dark:text-red-300">
          {error}
        </div>
      )}

      {!loading && draft && (
        <>
          <div className="flex items-center justify-between mb-2">
            <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">
              Draft #{draft.id.toString()}
            </h1>
            {draft.finalized && (
              <span className="text-xs font-medium px-2 py-1 rounded-full bg-green-100 text-green-800">
                Finalized
              </span>
            )}
            {draft.cancelled && (
              <span className="text-xs font-medium px-2 py-1 rounded-full bg-gray-100 text-gray-600">
                Cancelled
              </span>
            )}
          </div>
          <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">
            Created by {formatAddress(draft.creator)}
          </p>
          <p className="text-gray-700 dark:text-gray-200 mb-6 whitespace-pre-wrap">
            {draft.description}
          </p>

          <div className="border border-gray-200 dark:border-gray-700 rounded-xl p-4 mb-6">
            <div className="flex items-center justify-between mb-2">
              <span className="text-sm font-medium text-gray-900 dark:text-gray-100">
                Co-sponsor power
              </span>
              <span className="text-sm text-gray-500 dark:text-gray-400">
                {draft.totalPower.toString()} pledged
              </span>
            </div>
            <ul className="text-sm text-gray-600 dark:text-gray-300 space-y-1">
              {draft.coSponsors.map((sponsor, i) => (
                <li key={sponsor} className="flex justify-between">
                  <span>{formatAddress(sponsor)}</span>
                  <span>{draft.coSponsorPower[i]?.toString() ?? "0"}</span>
                </li>
              ))}
              {draft.coSponsors.length === 0 && (
                <li className="text-gray-400 dark:text-gray-500">No co-sponsors yet.</li>
              )}
            </ul>
          </div>

          {!draft.finalized && !draft.cancelled && (
            <div className="flex flex-wrap gap-3">
              {!alreadyCoSponsored && (
                <button
                  onClick={() => setShowCoSponsorModal(true)}
                  disabled={busy}
                  className="px-4 py-2 rounded-lg bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-50"
                >
                  Co-Sponsor
                </button>
              )}
              {alreadyCoSponsored && (
                <button
                  onClick={handleWithdraw}
                  disabled={busy}
                  className="px-4 py-2 rounded-lg border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700 disabled:opacity-50"
                >
                  Withdraw Pledge
                </button>
              )}
              {isCreator && (
                <button
                  onClick={handleFinalize}
                  disabled={busy}
                  className="px-4 py-2 rounded-lg bg-green-600 text-white hover:bg-green-700 disabled:opacity-50"
                >
                  Finalize
                </button>
              )}
              {isCreator && (
                <button
                  onClick={handleCancel}
                  disabled={busy}
                  className="px-4 py-2 rounded-lg border border-red-300 text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20 disabled:opacity-50"
                >
                  Cancel Draft
                </button>
              )}
            </div>
          )}

          {showCoSponsorModal && (
            <CoSponsorModal
              draftId={draftId}
              onClose={() => setShowCoSponsorModal(false)}
              onSuccess={refetch}
            />
          )}
        </>
      )}
    </div>
  );
}
