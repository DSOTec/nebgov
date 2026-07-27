"use client";

/**
 * Gasless delegation modal — sign a delegation permit with the connected
 * wallet, and let the protocol's relayer pay the fee and submit it.
 */

import { useEffect, useState, type FormEvent } from "react";
import toast from "react-hot-toast";
import type { TopDelegate } from "@nebgov/sdk";
import { useWallet } from "../lib/wallet-context";
import { isValidStellarAddress } from "../lib/utils/stellarAddress";
import {
  useGaslessDelegation,
  EXPIRY_PRESET_LABELS,
  type ExpiryPreset,
} from "../hooks/useGaslessDelegation";
import { useFocusTrap } from "../hooks/useFocusTrap";

interface Props {
  open: boolean;
  onClose: () => void;
  onDelegated?: () => void;
  prefillAddress?: string;
  /** Optional pre-fetched leaderboard to pick a delegatee from. */
  topDelegates?: TopDelegate[];
}

function explorerTxUrl(txHash: string): string {
  const network = process.env.NEXT_PUBLIC_NETWORK || "testnet";
  const base =
    network === "mainnet"
      ? "https://stellar.expert/explorer/public"
      : "https://stellar.expert/explorer/testnet";
  return `${base}/tx/${txHash}`;
}

const EXPIRY_PRESETS: ExpiryPreset[] = ["1week", "1month", "6months", "1year"];

export function GaslessDelegateModal({
  open,
  onClose,
  onDelegated,
  prefillAddress,
  topDelegates,
}: Props) {
  const [delegatee, setDelegatee] = useState(prefillAddress || "");
  const [delegateeError, setDelegateeError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [expiryPreset, setExpiryPreset] = useState<ExpiryPreset>("1month");
  const { isConnected, publicKey, connect } = useWallet();
  const { delegateGasless, preflightDelegatee } = useGaslessDelegation();
  const dialogRef = useFocusTrap<HTMLDivElement>(open, onClose);

  useEffect(() => {
    setDelegatee(prefillAddress ?? "");
  }, [open, prefillAddress]);

  if (!open) return null;

  function validateDelegatee(value: string) {
    if (!value.trim()) {
      setDelegateeError("Address is required.");
      return false;
    }
    if (!isValidStellarAddress(value)) {
      setDelegateeError("Invalid Stellar address.");
      return false;
    }
    setDelegateeError("");
    return true;
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!validateDelegatee(delegatee)) return;

    setSubmitting(true);
    try {
      if (!isConnected || !publicKey) {
        toast.error("Connect your wallet first.");
        return;
      }

      let preflight;
      try {
        preflight = await preflightDelegatee(delegatee);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setDelegateeError(msg);
        return;
      }

      if (!preflight.ok) {
        setDelegateeError(preflight.error ?? "Unable to validate this delegation.");
        return;
      }

      const result = await delegateGasless(delegatee.trim(), expiryPreset);
      toast.success(
        <div>
          Delegated for free — the protocol paid the fee.{" "}
          <a
            href={explorerTxUrl(result.txHash)}
            target="_blank"
            rel="noreferrer"
            className="underline"
          >
            View on Explorer →
          </a>
        </div>,
        { duration: 8000 },
      );
      onDelegated?.();
      onClose();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      toast.error(`Gasless delegation failed: ${msg}`);
    } finally {
      setSubmitting(false);
    }
  }

  async function handleInvalidatePermits() {
    try {
      if (!isConnected || !publicKey) {
        toast.error("Connect your wallet first.");
        return;
      }

      const result = await invalidateAllPermits();
      toast.success(
        <div>
          Pending gasless permits were invalidated.{" "}
          <a
            href={explorerTxUrl(result.txHash)}
            target="_blank"
            rel="noreferrer"
            className="underline"
          >
            View on Explorer →
          </a>
        </div>,
        { duration: 8000 },
      );
      onClose();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      toast.error(`Permit invalidation failed: ${msg}`);
    }
  }

  return (
    <div
      ref={dialogRef}
      className="fixed inset-0 bg-black/40 flex items-center justify-center z-50"
      role="dialog"
      aria-modal="true"
      aria-labelledby="gasless-delegate-modal-title"
      tabIndex={-1}
    >
      <div className="bg-white rounded-2xl p-6 w-full max-w-md shadow-xl">
        <div className="flex items-start justify-between mb-1">
          <h2 id="gasless-delegate-modal-title" className="text-lg font-bold text-gray-900">
            Delegate for free — we pay the fee
          </h2>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600 p-1 rounded focus:outline-none focus:ring-2 focus:ring-indigo-500"
            aria-label="Close"
          >
            ✕
          </button>
        </div>
        <p className="text-sm text-gray-500 mb-4">
          Sign a delegation permit with your wallet. No transaction, no gas —
          our relayer submits it and pays the network fee for you.
        </p>

        {!isConnected && (
          <button
            type="button"
            onClick={() => void connect()}
            className="w-full mb-4 border border-indigo-200 bg-indigo-50 text-indigo-700 py-2 rounded-lg text-sm font-medium hover:bg-indigo-100"
          >
            Connect wallet to continue
          </button>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1.5">
              Delegate to
            </label>
            <input
              type="text"
              placeholder="Stellar address (G...)"
              value={delegatee}
              onChange={(e) => { setDelegatee(e.target.value); setDelegateeError(""); }}
              onBlur={(e) => validateDelegatee(e.target.value)}
              className={`w-full border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 font-mono ${
                delegateeError ? "border-red-400" : "border-gray-300"
              }`}
              required
            />
            {delegateeError && (
              <p className="text-xs text-red-500 mt-1">{delegateeError}</p>
            )}
            {topDelegates && topDelegates.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {topDelegates.slice(0, 5).map((d) => (
                  <button
                    key={d.address}
                    type="button"
                    onClick={() => setDelegatee(d.address)}
                    className="text-xs px-2 py-1 rounded-md border border-gray-200 text-gray-700 hover:bg-gray-50 font-mono"
                  >
                    {d.address.slice(0, 4)}...{d.address.slice(-4)}
                  </button>
                ))}
              </div>
            )}
          </div>

          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1.5">
              Permit expires in
            </label>
            <div className="grid grid-cols-4 gap-2">
              {EXPIRY_PRESETS.map((preset) => (
                <button
                  key={preset}
                  type="button"
                  onClick={() => setExpiryPreset(preset)}
                  className={`text-xs py-1.5 rounded-lg border transition-colors ${
                    expiryPreset === preset
                      ? "border-indigo-600 bg-indigo-50 text-indigo-700 font-medium"
                      : "border-gray-200 text-gray-600 hover:bg-gray-50"
                  }`}
                >
                  {EXPIRY_PRESET_LABELS[preset]}
                </button>
              ))}
            </div>
          </div>

          <div className="flex gap-3">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 border border-gray-200 text-gray-600 py-2 rounded-lg text-sm hover:bg-gray-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting || !delegatee.trim() || !!delegateeError || !isConnected}
              className="flex-1 bg-green-600 text-white py-2 rounded-lg text-sm font-medium hover:bg-green-700 disabled:opacity-50"
            >
              {submitting ? "Signing…" : "Delegate for free"}
            </button>
          </div>

          <button
            type="button"
            onClick={() => void handleInvalidatePermits()}
            disabled={submitting || !isConnected || !publicKey}
            className="w-full rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm font-medium text-amber-800 hover:bg-amber-100 disabled:opacity-50"
          >
            {submitting ? "Submitting…" : "Invalidate pending gasless permits"}
          </button>
        </form>
      </div>
    </div>
  );
}
