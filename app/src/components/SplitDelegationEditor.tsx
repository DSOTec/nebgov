"use client";

/**
 * Split delegation editor (issue #994) — add/remove delegatee rows with a
 * percentage input per row, live-validated to sum to 100% before the submit
 * button is enabled. Reused both from the plain delegate flow ("Split my
 * delegation instead") and from a delegate's own profile page.
 */

import { useEffect, useState, type FormEvent } from "react";
import toast from "react-hot-toast";
import { isValidStellarAddress } from "../lib/utils/stellarAddress";
import type { SplitDelegation } from "@nebgov/sdk";
import { useWallet } from "../lib/wallet-context";
import { useSplitDelegation } from "../hooks/useSplitDelegation";
import { useFocusTrap } from "../hooks/useFocusTrap";

interface Props {
  open: boolean;
  onClose: () => void;
  onDelegated?: () => void;
  /** Pre-fill a single row with this address (e.g. coming from the plain delegate flow). */
  prefillAddress?: string;
}

interface Row {
  key: number;
  delegatee: string;
  percent: string; // kept as a string while editing so a blank/partial input doesn't jump to 0
}

let nextRowKey = 0;
function newRow(delegatee = ""): Row {
  return { key: nextRowKey++, delegatee, percent: "" };
}

function explorerTxUrl(txHash: string): string {
  const network = process.env.NEXT_PUBLIC_NETWORK || "testnet";
  const base =
    network === "mainnet"
      ? "https://stellar.expert/explorer/public"
      : "https://stellar.expert/explorer/testnet";
  return `${base}/tx/${txHash}`;
}

export function SplitDelegationEditor({ open, onClose, onDelegated, prefillAddress }: Props) {
  const { publicKey } = useWallet();
  const { delegateSplit, submitting } = useSplitDelegation(publicKey ?? undefined);
  const [rows, setRows] = useState<Row[]>([newRow(prefillAddress)]);
  const dialogRef = useFocusTrap<HTMLDivElement>(open, onClose);

  useEffect(() => {
    if (open) setRows([newRow(prefillAddress), newRow()]);
  }, [open, prefillAddress]);

  if (!open) return null;

  const totalPercent = rows.reduce((sum, r) => sum + (Number(r.percent) || 0), 0);
  const remaining = 100 - totalPercent;

  const rowErrors = rows.map((r) => {
    if (!r.delegatee.trim() && !r.percent.trim()) return null; // untouched trailing row
    if (!r.delegatee.trim()) return "Address is required.";
    if (!isValidStellarAddress(r.delegatee)) return "Invalid Stellar address.";
    const pct = Number(r.percent);
    if (!r.percent.trim() || Number.isNaN(pct) || pct <= 0) return "Enter a percentage > 0.";
    return null;
  });

  const activeRows = rows.filter((r) => r.delegatee.trim() || r.percent.trim());
  const duplicateAddresses = new Set(
    activeRows
      .map((r) => r.delegatee.trim())
      .filter((addr, i, arr) => addr && arr.indexOf(addr) !== i),
  );

  const isValid =
    activeRows.length > 0 &&
    rowErrors.every((e) => e === null) &&
    duplicateAddresses.size === 0 &&
    Math.abs(totalPercent - 100) < 0.001;

  function updateRow(key: number, patch: Partial<Row>) {
    setRows((prev) => prev.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  }

  function addRow() {
    setRows((prev) => [...prev, newRow()]);
  }

  function removeRow(key: number) {
    setRows((prev) => (prev.length > 1 ? prev.filter((r) => r.key !== key) : prev));
  }

  function splitEvenly() {
    const active = rows.filter((r) => r.delegatee.trim());
    if (active.length === 0) return;
    const base = Math.floor((10000 / active.length)) / 100;
    setRows((prev) => {
      const activeKeys = prev.filter((r) => r.delegatee.trim()).map((r) => r.key);
      let allocated = 0;
      return prev.map((r) => {
        if (!activeKeys.includes(r.key)) return r;
        const isLast = r.key === activeKeys[activeKeys.length - 1];
        const pct = isLast ? (100 - allocated).toFixed(2) : base.toFixed(2);
        allocated += Number(pct);
        return { ...r, percent: pct };
      });
    });
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!isValid) return;

    const splits: SplitDelegation[] = activeRows.map((r) => ({
      delegatee: r.delegatee.trim(),
      weightBps: Math.round(Number(r.percent) * 100),
    }));

    // Rounding each row to the nearest bp can leave the sum a hair off
    // 10000; credit any remainder to the last entry so the contract's exact
    // sum-to-10000 check passes.
    const sum = splits.reduce((s, x) => s + x.weightBps, 0);
    if (sum !== 10000 && splits.length > 0) {
      splits[splits.length - 1].weightBps += 10000 - sum;
    }

    try {
      const hash = await delegateSplit(splits);
      toast.success(
        <div>
          Split delegation submitted!{" "}
          <a href={explorerTxUrl(hash)} target="_blank" rel="noreferrer" className="underline">
            View on Explorer →
          </a>
        </div>,
        { duration: 8000 },
      );
      onDelegated?.();
      onClose();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      toast.error(`Split delegation failed: ${msg}`);
    }
  }

  return (
    <div
      ref={dialogRef}
      className="fixed inset-0 bg-black/40 flex items-center justify-center z-50"
      role="dialog"
      aria-modal="true"
      aria-labelledby="split-delegation-title"
      tabIndex={-1}
    >
      <div className="bg-white rounded-2xl p-6 w-full max-w-lg shadow-xl">
        <div className="flex items-start justify-between mb-1">
          <h2 id="split-delegation-title" className="text-lg font-bold text-gray-900">
            Split Delegation
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
          Spread your voting power across multiple delegates by percentage.
        </p>

        <form onSubmit={handleSubmit} className="space-y-3">
          {rows.map((row) => {
            const err = rowErrors[rows.indexOf(row)];
            const isDup = row.delegatee.trim() && duplicateAddresses.has(row.delegatee.trim());
            return (
              <div key={row.key} className="flex items-start gap-2">
                <input
                  type="text"
                  placeholder="Stellar address (G...)"
                  value={row.delegatee}
                  onChange={(e) => updateRow(row.key, { delegatee: e.target.value })}
                  className={`flex-1 border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 font-mono ${
                    err || isDup ? "border-red-400" : "border-gray-300"
                  }`}
                />
                <div className="relative w-24">
                  <input
                    type="number"
                    min="0"
                    max="100"
                    step="0.01"
                    placeholder="0"
                    value={row.percent}
                    onChange={(e) => updateRow(row.key, { percent: e.target.value })}
                    className="w-full border border-gray-300 rounded-lg pl-3 pr-6 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
                  />
                  <span className="absolute right-2 top-2.5 text-xs text-gray-400">%</span>
                </div>
                <button
                  type="button"
                  onClick={() => removeRow(row.key)}
                  disabled={rows.length === 1}
                  className="text-gray-400 hover:text-red-500 p-2 disabled:opacity-30"
                  aria-label="Remove row"
                >
                  ✕
                </button>
              </div>
            );
          })}

          {(rowErrors.some((e) => e) || duplicateAddresses.size > 0) && (
            <p className="text-xs text-red-500">
              {duplicateAddresses.size > 0
                ? "Duplicate delegatee addresses aren't allowed."
                : rowErrors.find((e) => e)}
            </p>
          )}

          <div className="flex items-center justify-between">
            <button
              type="button"
              onClick={addRow}
              className="text-xs px-3 py-1.5 rounded-lg border border-gray-200 text-gray-700 hover:bg-gray-50"
            >
              + Add delegatee
            </button>
            <button
              type="button"
              onClick={splitEvenly}
              className="text-xs px-3 py-1.5 rounded-lg border border-gray-200 text-gray-700 hover:bg-gray-50"
            >
              Split evenly
            </button>
          </div>

          <div
            className={`rounded-lg px-3 py-2 text-sm flex items-center justify-between ${
              Math.abs(remaining) < 0.001
                ? "bg-green-50 text-green-800 border border-green-200"
                : "bg-amber-50 text-amber-800 border border-amber-200"
            }`}
          >
            <span>Total allocated</span>
            <span className="font-medium">
              {totalPercent.toFixed(2)}%{" "}
              {Math.abs(remaining) >= 0.001 &&
                `(${remaining > 0 ? remaining.toFixed(2) + "% remaining" : Math.abs(remaining).toFixed(2) + "% over"})`}
            </span>
          </div>

          <div className="flex gap-3 pt-1">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 border border-gray-200 text-gray-600 py-2 rounded-lg text-sm hover:bg-gray-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting || !isValid || !publicKey}
              className="flex-1 bg-indigo-600 text-white py-2 rounded-lg text-sm font-medium hover:bg-indigo-700 disabled:opacity-50"
            >
              {submitting ? "Delegating..." : "Split Delegate"}
            </button>
          </div>
          {!publicKey && (
            <p className="text-xs text-gray-400 text-center">Connect your wallet first.</p>
          )}
        </form>
      </div>
    </div>
  );
}
