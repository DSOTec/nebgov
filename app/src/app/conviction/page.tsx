"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { ConvictionVotingClient } from "@nebgov/sdk";
import { useConvictionProposals } from "../../hooks/useConvictionProposals";
import { readGovernorConfig } from "../../lib/nebgov-env";
import { convictionProgressPercent } from "../../lib/conviction";

export default function ConvictionProposalsPage() {
  const { proposals, loading, error } = useConvictionProposals();
  const [requiredThresholds, setRequiredThresholds] = useState<Record<string, bigint>>({});
  const client = useMemo(() => {
    const config = readGovernorConfig();
    if (!config?.convictionVotingAddress) return null;
    return new ConvictionVotingClient(config);
  }, []);

  useEffect(() => {
    if (!client || proposals.length === 0) {
      setRequiredThresholds({});
      return;
    }

    let cancelled = false;
    void Promise.all(
      proposals.map(async (proposal) => [
        proposal.proposalId,
        await client.getRequiredThreshold(proposal.requestedAmount),
      ] as const),
    ).then((entries) => {
      if (!cancelled) setRequiredThresholds(Object.fromEntries(entries));
    }).catch(() => {
      if (!cancelled) setRequiredThresholds({});
    });

    return () => {
      cancelled = true;
    };
  }, [client, proposals]);

  return (
    <main className="mx-auto max-w-5xl px-4 py-10">
      <h1 className="text-3xl font-bold">Conviction voting</h1>
      <p className="mt-2 text-slate-600 dark:text-slate-300">Continuous support lets focused proposals execute as conviction accumulates.</p>
      {loading && <p className="mt-8">Loading proposals…</p>}
      {error && <p className="mt-8 text-red-600">{error}</p>}
      <div className="mt-8 grid gap-4">
        {proposals.map((proposal) => (
          <Link key={proposal.proposalId} href={`/conviction/${proposal.proposalId}`} className="rounded-xl border border-slate-200 p-5 transition hover:border-indigo-500 dark:border-slate-700">
            <div className="flex items-center justify-between gap-4"><h2 className="font-semibold">Proposal #{proposal.proposalId}</h2><span>{proposal.requestedAmount.toString()} requested</span></div>
            <div className="mt-4 h-3 overflow-hidden rounded-full bg-slate-200 dark:bg-slate-700"><div className="h-full bg-indigo-600" style={{ width: `${convictionProgressPercent(proposal.conviction, requiredThresholds[proposal.proposalId])}%` }} /></div>
            <p className="mt-2 text-sm">Current conviction: {proposal.conviction.toString()}</p>
          </Link>
        ))}
        {!loading && !error && proposals.length === 0 && <p>No active conviction proposals.</p>}
      </div>
    </main>
  );
}
