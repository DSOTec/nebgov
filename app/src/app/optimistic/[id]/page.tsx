"use client";

/**
 * Optimistic-governance proposal detail (Issue #993).
 *
 * Shows the challenge-window countdown, objector list, and an "Object"
 * button gated to connected-wallet holders who had voting power at the
 * proposal's created_ledger and haven't already objected.
 */

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import toast from "react-hot-toast";
import { OptimisticGovernorClient, VotesClient } from "@nebgov/sdk";
import { useWallet } from "../../../lib/wallet-context";
import { readGovernorConfig } from "../../../lib/nebgov-env";
import { useOptimisticProposal } from "../../../hooks/useOptimisticProposals";
import { ChallengeCountdown } from "../../../components/ChallengeCountdown";
import { useLedgerClock } from "../../../lib/hooks/useLedgerClock";

function formatAddress(address: string): string {
  return `${address.slice(0, 4)}...${address.slice(-4)}`;
}

const STATE_LABELS: Record<string, string> = {
  challenge_window: "In challenge window",
  objected: "Objected",
  passed: "Passed",
  executed: "Executed",
  cancelled: "Cancelled",
};

export default function OptimisticProposalPage() {
  const params = useParams<{ id: string }>();
  const id = params.id;
  const { publicKey, signTransaction } = useWallet();
  const { proposal, objections, loading, error, refresh } = useOptimisticProposal(id);
  const { currentLedger } = useLedgerClock();
  const [votingPower, setVotingPower] = useState<bigint | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const hasObjected = !!publicKey && objections.some((o) => o.objector === publicKey);
  const challengeElapsed = !!proposal && currentLedger >= proposal.challengeEndLedger;

  useEffect(() => {
    if (!publicKey || !proposal) {
      setVotingPower(null);
      return;
    }
    const config = readGovernorConfig();
    if (!config) return;
    void (async () => {
      try {
        const votes = new VotesClient(config);
        const power = await votes.getPastVotes(publicKey, proposal.createdLedger);
        setVotingPower(power);
      } catch {
        setVotingPower(null);
      }
    })();
  }, [publicKey, proposal]);

  async function handleObject() {
    if (!publicKey || !signTransaction || !proposal) return;
    const config = readGovernorConfig();
    if (!config || !config.optimisticGovernorAddress) {
      toast.error("Optimistic governance is not configured.");
      return;
    }
    setSubmitting(true);
    try {
      const client = new OptimisticGovernorClient(config);
      await client.objectWithSign(publicKey, Number(proposal.proposalId), signTransaction);
      toast.success("Objection submitted.");
      refresh();
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Objection failed");
    } finally {
      setSubmitting(false);
    }
  }

  if (loading) {
    return <main className="mx-auto max-w-5xl px-4 py-10">Loading proposal…</main>;
  }
  if (!proposal) {
    return <main className="mx-auto max-w-5xl px-4 py-10">Proposal not found.</main>;
  }

  const canObject =
    !!publicKey &&
    proposal.state === "challenge_window" &&
    !challengeElapsed &&
    !hasObjected &&
    votingPower !== null &&
    votingPower > 0n;

  return (
    <main className="mx-auto max-w-5xl px-4 py-10">
      <div className="flex items-center justify-between gap-4">
        <h1 className="text-3xl font-bold">Optimistic proposal #{id}</h1>
        <ChallengeCountdown
          challengeEndLedger={proposal.challengeEndLedger}
          isElapsed={proposal.state !== "challenge_window" || challengeElapsed}
        />
      </div>
      {error && <p className="mt-4 text-red-600">{error}</p>}

      <dl className="mt-6 grid gap-3 rounded-xl border p-5 dark:border-slate-700">
        <div>
          <dt className="text-sm text-slate-500">Proposer</dt>
          <dd className="break-all">{proposal.proposer}</dd>
        </div>
        <div>
          <dt className="text-sm text-slate-500">State</dt>
          <dd>{STATE_LABELS[proposal.state] ?? proposal.state}</dd>
        </div>
        <div>
          <dt className="text-sm text-slate-500">Total objection weight</dt>
          <dd>{proposal.objectionVotes.toString()}</dd>
        </div>
      </dl>

      <section className="mt-8">
        <div className="flex items-center justify-between">
          <h2 className="text-xl font-semibold">Objections</h2>
          {!publicKey && (
            <span className="text-sm text-slate-500">Connect your wallet to object.</span>
          )}
          {publicKey && hasObjected && (
            <span className="text-sm text-slate-500">You&apos;ve already objected.</span>
          )}
          {publicKey && !hasObjected && votingPower !== null && votingPower <= 0n && (
            <span className="text-sm text-slate-500">
              No voting power at this proposal&apos;s created ledger.
            </span>
          )}
          <button
            onClick={handleObject}
            disabled={!canObject || submitting}
            className="rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-50"
          >
            {submitting ? "Submitting…" : "Object"}
          </button>
        </div>
        <div className="mt-4 grid gap-2">
          {objections.map((objection) => (
            <div
              key={objection.objector}
              className="flex items-center justify-between rounded-lg border p-3 text-sm dark:border-slate-700"
            >
              <span title={objection.objector}>{formatAddress(objection.objector)}</span>
              <span>{objection.weight.toString()}</span>
            </div>
          ))}
          {objections.length === 0 && <p className="text-sm text-slate-500">No objections yet.</p>}
        </div>
      </section>
    </main>
  );
}
