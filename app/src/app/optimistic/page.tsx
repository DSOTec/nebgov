"use client";

/**
 * Optimistic-governance proposals list (Issue #993).
 *
 * Every proposal here executes by default once its challenge window
 * elapses — it only fails if enough token holders object. Grouped by
 * lifecycle state with a countdown and a live objection-weight progress bar
 * against the configured threshold.
 */

import { useEffect, useState } from "react";
import Link from "next/link";
import { OptimisticGovernorClient, VotesClient } from "@nebgov/sdk";
import { readGovernorConfig } from "../../lib/nebgov-env";
import {
  useOptimisticProposals,
  type OptimisticProposalView,
} from "../../hooks/useOptimisticProposals";
import { ChallengeCountdown } from "../../components/ChallengeCountdown";
import { useLedgerClock } from "../../lib/hooks/useLedgerClock";

const GROUPS: { status: OptimisticProposalView["state"]; label: string }[] = [
  { status: "challenge_window", label: "In challenge window" },
  { status: "objected", label: "Objected" },
  { status: "passed", label: "Passed" },
  { status: "executed", label: "Executed" },
  { status: "cancelled", label: "Cancelled" },
];

function ProposalCard({
  proposal,
  currentLedger,
  thresholdBps,
  totalSupply,
}: {
  proposal: OptimisticProposalView;
  currentLedger: number;
  thresholdBps: number | null;
  totalSupply: bigint | null;
}) {
  const thresholdAmount =
    thresholdBps !== null && totalSupply !== null
      ? (totalSupply * BigInt(thresholdBps)) / 10_000n
      : null;
  const progressPct =
    thresholdAmount && thresholdAmount > 0n
      ? Math.min(100, Number((proposal.objectionVotes * 100n) / thresholdAmount))
      : 0;

  return (
    <Link
      key={proposal.proposalId}
      href={`/optimistic/${proposal.proposalId}`}
      className="block rounded-xl border border-slate-200 p-5 transition hover:border-indigo-500 dark:border-slate-700"
    >
      <div className="flex items-center justify-between gap-4">
        <h2 className="font-semibold">Proposal #{proposal.proposalId}</h2>
        <ChallengeCountdown
          challengeEndLedger={proposal.challengeEndLedger}
          isElapsed={proposal.state !== "challenge_window" || currentLedger >= proposal.challengeEndLedger}
        />
      </div>
      <p className="mt-2 truncate text-sm text-slate-500" title={proposal.proposer}>
        Proposer: {proposal.proposer}
      </p>
      {proposal.state === "challenge_window" && (
        <>
          <div className="mt-4 h-3 overflow-hidden rounded-full bg-slate-200 dark:bg-slate-700">
            <div
              className={`h-full ${progressPct >= 100 ? "bg-red-600" : "bg-amber-500"}`}
              style={{ width: `${progressPct}%` }}
            />
          </div>
          <p className="mt-2 text-sm text-slate-500">
            Objection weight: {proposal.objectionVotes.toString()}
            {thresholdAmount !== null ? ` / ~${thresholdAmount.toString()} to freeze` : ""}
          </p>
        </>
      )}
    </Link>
  );
}

export default function OptimisticProposalsPage() {
  const [statusFilter, setStatusFilter] = useState<OptimisticProposalView["state"] | undefined>(
    undefined,
  );
  const { proposals, loading, error } = useOptimisticProposals(statusFilter);
  const { currentLedger } = useLedgerClock();
  const [thresholdBps, setThresholdBps] = useState<number | null>(null);
  const [totalSupply, setTotalSupply] = useState<bigint | null>(null);

  useEffect(() => {
    const config = readGovernorConfig();
    if (!config || !config.optimisticGovernorAddress || currentLedger === 0) return;
    void (async () => {
      try {
        const client = new OptimisticGovernorClient(config);
        const settings = await client.getConfig();
        setThresholdBps(settings.objectionThresholdBps);
        // Approximation: uses current total supply rather than each
        // proposal's own created_ledger snapshot, to avoid one RPC round
        // trip per listed proposal. Good enough for a progress-bar
        // estimate; the proposal detail page computes an exact figure.
        const votes = new VotesClient(config);
        const supply = await votes.getPastTotalSupply(currentLedger);
        setTotalSupply(supply);
      } catch {
        // Optimistic governance not deployed/configured — leave the
        // progress bar's denominator unavailable rather than erroring.
      }
    })();
  }, [currentLedger]);

  return (
    <main className="mx-auto max-w-5xl px-4 py-10">
      <h1 className="text-3xl font-bold">Optimistic governance</h1>
      <p className="mt-2 text-slate-600 dark:text-slate-300">
        These proposals execute by default once their challenge window elapses — object if you
        disagree.
      </p>

      <div className="mt-6 flex flex-wrap gap-2">
        <button
          onClick={() => setStatusFilter(undefined)}
          className={`rounded-full px-3 py-1 text-sm ${!statusFilter ? "bg-indigo-600 text-white" : "border border-slate-300 dark:border-slate-600"}`}
        >
          All
        </button>
        {GROUPS.map((group) => (
          <button
            key={group.status}
            onClick={() => setStatusFilter(group.status)}
            className={`rounded-full px-3 py-1 text-sm ${statusFilter === group.status ? "bg-indigo-600 text-white" : "border border-slate-300 dark:border-slate-600"}`}
          >
            {group.label}
          </button>
        ))}
      </div>

      {loading && <p className="mt-8">Loading proposals…</p>}
      {error && <p className="mt-8 text-red-600">{error}</p>}

      <div className="mt-8 grid gap-4">
        {proposals.map((proposal) => (
          <ProposalCard
            key={proposal.proposalId}
            proposal={proposal}
            currentLedger={currentLedger}
            thresholdBps={thresholdBps}
            totalSupply={totalSupply}
          />
        ))}
        {!loading && !error && proposals.length === 0 && (
          <p>No optimistic-governance proposals yet.</p>
        )}
      </div>
    </main>
  );
}
