"use client";

import { useState } from "react";
import toast from "react-hot-toast";
import type { TreasuryClient, TreasuryBudgetStream } from "../lib/treasury-client";

interface ExtendStreamModalProps {
  client: TreasuryClient;
  stream: TreasuryBudgetStream;
  signerPublicKey: string;
  signUnsignedXdr: (xdr: string) => Promise<string>;
  busy: boolean;
  setBusy: (busy: boolean) => void;
  onClose: () => void;
  onExtended: () => void;
}

export function ExtendStreamModal({
  client,
  stream,
  signerPublicKey,
  signUnsignedXdr,
  busy,
  setBusy,
  onClose,
  onExtended,
}: ExtendStreamModalProps) {
  const [newEndLedger, setNewEndLedger] = useState(String(stream.endLedger + 50000));
  const [error, setError] = useState("");

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const parsed = Number(newEndLedger);
    if (!newEndLedger || !Number.isInteger(parsed) || parsed <= 0) {
      setError("Enter a valid whole ledger number.");
      return;
    }
    if (parsed <= stream.endLedger) {
      setError(`New end ledger must be greater than the current end ledger (${stream.endLedger}).`);
      return;
    }

    setBusy(true);
    try {
      await client.extendStream(signerPublicKey, Number(stream.id), parsed, signUnsignedXdr);
      toast.success("Stream extended");
      onExtended();
      onClose();
    } catch (err) {
      toast.error(`Extend failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50">
      <div className="bg-white rounded-lg p-6 w-full max-w-md">
        <h2 className="text-lg font-semibold mb-1">Extend Stream</h2>
        <p className="text-xs text-gray-500 mb-4">
          {stream.name} — Current End Ledger: {stream.endLedger}
        </p>
        <form onSubmit={handleSubmit} className="space-y-3">
          <div>
            <label className="text-xs text-gray-500">New End Ledger</label>
            <input
              type="number"
              value={newEndLedger}
              onChange={(e) => { setNewEndLedger(e.target.value); setError(""); }}
              placeholder={String(stream.endLedger + 50000)}
              className={`w-full border rounded-md px-3 py-2 text-sm ${
                error ? "border-red-400" : "border-gray-300"
              }`}
              required
            />
            {error && <p className="text-xs text-red-500 mt-1">{error}</p>}
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
              disabled={busy || !!error}
              className="flex-1 bg-indigo-600 text-white rounded-md py-2 text-sm hover:bg-indigo-700 disabled:opacity-50"
            >
              {busy ? "Extending..." : "Extend Stream"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
