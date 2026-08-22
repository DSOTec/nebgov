"use client";

import { useState } from "react";
import toast from "react-hot-toast";
import type { TreasuryStrategiesClient } from "@nebgov/sdk";
import type { StrategyRow } from "../hooks/useTreasuryStrategies";
import { useFocusTrap } from "../hooks/useFocusTrap";
import { useLedgerClock } from "../lib/hooks/useLedgerClock";
import { getTimerInfo } from "../lib/utils/ledgerTime";

interface WithdrawalRequestModalProps {
  client: TreasuryStrategiesClient;
  strategy: StrategyRow;
  signerPublicKey: string;
  signUnsignedXdr: (xdr: string) => Promise<string>;
  rpcUrl?: string;
  onClose: () => void;
  onChanged?: () => void;
}

/**
 * On-chain, `request_withdrawal`'s `caller` must equal the configured
 * treasury address — this only succeeds when `signerPublicKey` is itself
 * that address (in practice, invoked via the treasury's own submit/approve
 * flow), same constraint documented on
 * `TreasuryStrategiesClient.requestWithdrawalWithSign`. `claim_withdrawal`
 * is permissionless once the cooldown elapses, so any connected wallet can
 * complete that half of this modal.
 */
export function WithdrawalRequestModal({
  client,
  strategy,
  signerPublicKey,
  signUnsignedXdr,
  rpcUrl,
  onClose,
  onChanged,
}: WithdrawalRequestModalProps) {
  const [amount, setAmount] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [claiming, setClaiming] = useState(false);
  const [withdrawalId, setWithdrawalId] = useState<number | null>(null);
  const [claimableLedger, setClaimableLedger] = useState<number | null>(null);
  const dialogRef = useFocusTrap<HTMLDivElement>(true, onClose);
  const { currentLedger } = useLedgerClock(rpcUrl);

  const timer =
    claimableLedger != null ? getTimerInfo("Claimable in", claimableLedger, currentLedger) : null;
  const isClaimable =
    claimableLedger != null && currentLedger > 0 && currentLedger >= claimableLedger;

  const handleRequest = async (e: React.FormEvent) => {
    e.preventDefault();
    let amt: bigint;
    try {
      amt = BigInt(amount);
    } catch {
      toast.error("Enter a whole-number amount");
      return;
    }
    if (amt <= 0n || amt > strategy.currentAllocation) {
      toast.error("Amount must be positive and within the strategy's current allocation");
      return;
    }

    setSubmitting(true);
    try {
      const id = await client.requestWithdrawalWithSign(
        signerPublicKey,
        strategy.strategyId,
        amt,
        signUnsignedXdr,
      );
      setWithdrawalId(id);
      setClaimableLedger((currentLedger || 0) + strategy.withdrawalCooldownLedgers);
      toast.success(`Withdrawal #${id} requested — cooldown started`);
      onChanged?.();
    } catch (err) {
      toast.error(`Request failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setSubmitting(false);
    }
  };

  const handleClaim = async () => {
    if (withdrawalId == null) return;
    setClaiming(true);
    try {
      await client.claimWithdrawalWithSign(signerPublicKey, withdrawalId, signUnsignedXdr);
      toast.success("Withdrawal claimed");
      onChanged?.();
      onClose();
    } catch (err) {
      toast.error(`Claim failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setClaiming(false);
    }
  };

  return (
    <div
      ref={dialogRef}
      className="fixed inset-0 bg-black/40 flex items-center justify-center z-50"
      role="dialog"
      aria-modal="true"
      aria-labelledby="withdrawal-request-modal-title"
      tabIndex={-1}
    >
      <div className="bg-white rounded-lg p-6 w-full max-w-md">
        <div className="flex items-start justify-between mb-1">
          <h2 id="withdrawal-request-modal-title" className="text-lg font-semibold">
            Request Withdrawal
          </h2>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600 p-1 rounded focus:outline-none focus:ring-2 focus:ring-indigo-500"
            aria-label="Close"
          >
            ✕
          </button>
        </div>
        <p className="text-xs text-gray-500 mb-4">
          Strategy #{strategy.strategyId} — Current allocation:{" "}
          {strategy.currentAllocation.toString()} · Cooldown: {strategy.withdrawalCooldownLedgers}{" "}
          ledgers
        </p>

        {withdrawalId == null ? (
          <form onSubmit={handleRequest} className="space-y-3">
            <div>
              <label className="text-xs text-gray-500">Amount</label>
              <input
                type="text"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                placeholder="1000"
                className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm"
                required
              />
            </div>
            <div className="flex gap-2 pt-2">
              <button
                type="button"
                onClick={onClose}
                className="flex-1 border border-gray-300 text-gray-700 rounded-md py-2 text-sm hover:bg-gray-50"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={submitting}
                className="flex-1 bg-indigo-600 text-white rounded-md py-2 text-sm hover:bg-indigo-700 disabled:opacity-50"
              >
                {submitting ? "Requesting..." : "Request Withdrawal"}
              </button>
            </div>
          </form>
        ) : (
          <div className="space-y-3">
            <div className="rounded-lg bg-slate-50 border border-slate-100 px-3 py-3 text-sm text-slate-800">
              <p className="font-medium">Withdrawal #{withdrawalId} requested</p>
              <p className="mt-1 text-xs text-slate-600">
                {isClaimable
                  ? "Cooldown elapsed — ready to claim."
                  : timer
                    ? `${timer.label} ${timer.countdown}`
                    : "Waiting for cooldown to start ticking…"}
              </p>
            </div>
            <div className="flex gap-2 pt-2">
              <button
                type="button"
                onClick={onClose}
                className="flex-1 border border-gray-300 text-gray-700 rounded-md py-2 text-sm hover:bg-gray-50"
              >
                Close
              </button>
              <button
                type="button"
                onClick={handleClaim}
                disabled={!isClaimable || claiming}
                className="flex-1 bg-indigo-600 text-white rounded-md py-2 text-sm hover:bg-indigo-700 disabled:opacity-50"
              >
                {claiming ? "Claiming..." : "Claim"}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
