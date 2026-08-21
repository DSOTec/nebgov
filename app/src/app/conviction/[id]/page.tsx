"use client";

import { useEffect, useMemo, useState } from "react";
import { useParams } from "next/navigation";

interface Snapshot { ledger: number; conviction: bigint }

export default function ConvictionProposalPage() {
  const params = useParams<{ id: string }>();
  const id = params.id;
  const indexerUrl = process.env.NEXT_PUBLIC_INDEXER_URL;
  const [proposal, setProposal] = useState<Record<string, unknown> | null>(null);
  const [history, setHistory] = useState<Snapshot[]>([]);

  useEffect(() => {
    if (!indexerUrl) return;
    void Promise.all([
      fetch(`${indexerUrl}/conviction/proposals/${id}`).then((r) => r.json()),
      fetch(`${indexerUrl}/conviction/proposals/${id}/conviction-history`).then((r) => r.json()),
    ]).then(([nextProposal, nextHistory]) => {
      setProposal(nextProposal as Record<string, unknown>);
      setHistory(((nextHistory as { data?: Record<string, unknown>[] }).data ?? []).map((row) => ({ ledger: Number(row.ledger), conviction: BigInt(String(row.conviction)) })));
    });
  }, [id, indexerUrl]);

  const points = useMemo(() => {
    if (history.length === 0) return "";
    const max = history.reduce((value, point) => point.conviction > value ? point.conviction : value, 1n);
    return history.map((point, index) => `${(index / Math.max(1, history.length - 1)) * 100},${100 - Number(point.conviction * 100n / max)}`).join(" ");
  }, [history]);

  if (!proposal) return <main className="mx-auto max-w-5xl px-4 py-10">Loading proposal…</main>;
  return (
    <main className="mx-auto max-w-5xl px-4 py-10">
      <h1 className="text-3xl font-bold">Conviction proposal #{id}</h1>
      <dl className="mt-6 grid gap-3 rounded-xl border p-5"><div><dt className="text-sm text-slate-500">Target</dt><dd className="break-all">{String(proposal.target)}</dd></div><div><dt className="text-sm text-slate-500">Requested</dt><dd>{String(proposal.requested_amount)}</dd></div><div><dt className="text-sm text-slate-500">Conviction</dt><dd>{String(proposal.conviction)}</dd></div></dl>
      <section className="mt-8"><h2 className="text-xl font-semibold">Conviction growth</h2><svg viewBox="0 0 100 100" className="mt-4 h-64 w-full rounded-xl border p-4" role="img" aria-label="Conviction growth over time"><line x1="0" y1="20" x2="100" y2="20" stroke="currentColor" strokeDasharray="3 2" opacity="0.45" /><polyline points={points} fill="none" stroke="rgb(79 70 229)" strokeWidth="2" vectorEffect="non-scaling-stroke" /></svg><p className="mt-2 text-sm text-slate-500">Dashed line represents the required threshold; the trend extends as new checkpoints arrive.</p></section>
    </main>
  );
}
