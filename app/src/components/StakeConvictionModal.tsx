"use client";

import { useEffect, useState } from "react";

interface StakeConvictionModalProps {
  open: boolean;
  proposalId: string;
  currentStake?: bigint;
  activeProposalId?: string;
  onClose: () => void;
  onStake: (amount: bigint) => Promise<void>;
  onWithdraw: () => Promise<void>;
}

export function StakeConvictionModal(props: StakeConvictionModalProps) {
  const [amount, setAmount] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (props.open) setAmount(props.currentStake?.toString() ?? "");
  }, [props.currentStake, props.open]);

  if (!props.open) return null;
  const moving = Boolean(
    props.activeProposalId && props.activeProposalId !== props.proposalId,
  );

  async function run(action: () => Promise<void>) {
    setSubmitting(true);
    setError(null);
    try {
      await action();
      props.onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Transaction failed");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-4" role="dialog" aria-modal="true" aria-labelledby="stake-title">
      <div className="w-full max-w-md rounded-xl bg-white p-6 text-slate-950 shadow-xl dark:bg-slate-900 dark:text-white">
        <h2 id="stake-title" className="text-xl font-semibold">Support proposal #{props.proposalId}</h2>
        <p className="mt-2 text-sm text-slate-600 dark:text-slate-300">
          Your voting power remains yours. Conviction grows while it stays committed.
        </p>
        {moving && (
          <p className="mt-3 rounded-lg bg-amber-100 p-3 text-sm text-amber-900">
            You currently support proposal #{props.activeProposalId}. Staking here automatically withdraws that stake first.
          </p>
        )}
        <label className="mt-5 block text-sm font-medium" htmlFor="stake-amount">Voting power</label>
        <input id="stake-amount" inputMode="numeric" value={amount} onChange={(event) => setAmount(event.target.value)} className="mt-2 w-full rounded-lg border border-slate-300 bg-transparent px-3 py-2" />
        {error && <p className="mt-3 text-sm text-red-600">{error}</p>}
        <div className="mt-6 flex flex-wrap justify-end gap-2">
          {props.currentStake && props.currentStake > 0n && (
            <button disabled={submitting} onClick={() => void run(props.onWithdraw)} className="rounded-lg border px-4 py-2">Withdraw</button>
          )}
          <button onClick={props.onClose} className="rounded-lg border px-4 py-2">Cancel</button>
          <button disabled={submitting || !/^\d+$/.test(amount) || BigInt(amount || 0) <= 0n} onClick={() => void run(() => props.onStake(BigInt(amount)))} className="rounded-lg bg-indigo-600 px-4 py-2 text-white disabled:opacity-50">Stake</button>
        </div>
      </div>
    </div>
  );
}
