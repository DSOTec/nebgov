"use client";

import { useState } from "react";
import toast from "react-hot-toast";
import type { TreasuryClient, TreasuryBudgetStream } from "../lib/treasury-client";
import { isValidStellarAddress } from "../lib/utils/stellarAddress";
import { useFocusTrap } from "../hooks/useFocusTrap";

interface StreamSpendModalProps {
  client: TreasuryClient;
  stream: TreasuryBudgetStream;
  signerPublicKey: string;
  signUnsignedXdr: (xdr: string) => Promise<string>;
  onClose: () => void;
  onSpent: () => void;
}

export function StreamSpendModal({
  client,
  stream,
  signerPublicKey,
  signUnsignedXdr,
  onClose,
  onSpent,
}: StreamSpendModalProps) {
  const [recipient, setRecipient] = useState("");
  const [recipientError, setRecipientError] = useState("");
  const [amount, setAmount] = useState("");
  const [memo, setMemo] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const dialogRef = useFocusTrap<HTMLDivElement>(true, onClose);

  const remaining = stream.totalAllocated - stream.totalSpent;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!recipient || !amount) {
      toast.error("Please fill in recipient and amount");
      return;
    }
    if (!isValidStellarAddress(recipient)) {
      setRecipientError("Invalid Stellar address.");
      return;
    }

    let amt: bigint;
    try {
      amt = BigInt(amount);
    } catch {
      toast.error("Enter a whole-number amount");
      return;
    }
    if (amt > remaining) {
      toast.error("Amount exceeds remaining budget");
      return;
    }
    if (amt > stream.maxSingleSpend) {
      toast.error(`Amount exceeds max single spend (${stream.maxSingleSpend.toString()})`);
      return;
    }

    setSubmitting(true);
    try {
      await client.streamSpend(
        signerPublicKey,
        Number(stream.id),
        recipient,
        amt,
        memo,
        signUnsignedXdr,
      );
      toast.success("Stream spend executed successfully");
      onSpent();
      onClose();
    } catch (err) {
      toast.error(`Spend failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      ref={dialogRef}
      className="fixed inset-0 bg-black/40 flex items-center justify-center z-50"
      role="dialog"
      aria-modal="true"
      aria-labelledby="stream-spend-modal-title"
      tabIndex={-1}
    >
      <div className="bg-white rounded-lg p-6 w-full max-w-md">
        <div className="flex items-start justify-between mb-1">
          <h2 id="stream-spend-modal-title" className="text-lg font-semibold">
            Spend from Stream
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
          {stream.name} — Remaining: {remaining.toString()} / Max: {stream.maxSingleSpend.toString()}
        </p>
        <form onSubmit={handleSubmit} className="space-y-3">
          <div>
            <label className="text-xs text-gray-500">Recipient Address</label>
            <input
              type="text"
              value={recipient}
              onChange={(e) => { setRecipient(e.target.value); setRecipientError(""); }}
              onBlur={(e) => {
                if (e.target.value && !isValidStellarAddress(e.target.value))
                  setRecipientError("Invalid Stellar address.");
                else setRecipientError("");
              }}
              placeholder="G..."
              className={`w-full border rounded-md px-3 py-2 text-sm font-mono ${
                recipientError ? "border-red-400" : "border-gray-300"
              }`}
              required
            />
            {recipientError && <p className="text-xs text-red-500 mt-1">{recipientError}</p>}
          </div>
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
          <div>
            <label className="text-xs text-gray-500">Memo (optional)</label>
            <input
              type="text"
              value={memo}
              onChange={(e) => setMemo(e.target.value)}
              placeholder="Q1 infrastructure payment"
              className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm"
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
              disabled={submitting || !stream.isActive || !!recipientError}
              className="flex-1 bg-indigo-600 text-white rounded-md py-2 text-sm hover:bg-indigo-700 disabled:opacity-50"
            >
              {submitting ? "Spending..." : "Execute Spend"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
