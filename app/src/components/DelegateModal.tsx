"use client";

/**
 * Delegation modal - lets users delegate or revoke delegation.
 */

import { useEffect, useState, type FormEvent } from "react";
import { Keypair } from "@stellar/stellar-sdk";
import toast from "react-hot-toast";
import { VotesClient, type Network } from "@nebgov/sdk";
import { useWallet } from "../lib/wallet-context";

interface Props {
  open: boolean;
  onClose: () => void;
  onDelegated?: () => void;
  prefillAddress?: string;
  currentDelegatee?: string | null;
}

function getVotesClientFromEnv(): VotesClient {
  const governorAddress = process.env.NEXT_PUBLIC_GOVERNOR_ADDRESS;
  const timelockAddress = process.env.NEXT_PUBLIC_TIMELOCK_ADDRESS;
  const votesAddress = process.env.NEXT_PUBLIC_VOTES_ADDRESS;
  const network = (process.env.NEXT_PUBLIC_NETWORK || "testnet") as Network;
  const rpcUrl = process.env.NEXT_PUBLIC_RPC_URL;

  if (!governorAddress || !timelockAddress || !votesAddress) {
    throw new Error("Missing NEXT_PUBLIC_* contract addresses in .env.local");
  }

  return new VotesClient({
    governorAddress,
    timelockAddress,
    votesAddress,
    network,
    ...(rpcUrl && { rpcUrl }),
  });
}

function getDelegateSigner(): Keypair {
  const secret = process.env.NEXT_PUBLIC_DELEGATE_SECRET_KEY;
  if (!secret) {
    throw new Error(
      "Missing NEXT_PUBLIC_DELEGATE_SECRET_KEY (required to sign delegation txs in this demo app).",
    );
  }
  return Keypair.fromSecret(secret);
}

function explorerTxUrl(txHash: string): string {
  const network = process.env.NEXT_PUBLIC_NETWORK || "testnet";
  const base =
    network === "mainnet"
      ? "https://stellar.expert/explorer/public"
      : "https://stellar.expert/explorer/testnet";
  return `${base}/tx/${txHash}`;
}

export function DelegateModal({
  open,
  onClose,
  onDelegated,
  prefillAddress,
  currentDelegatee,
}: Props) {
  const [delegatee, setDelegatee] = useState(prefillAddress || "");
  const [submitting, setSubmitting] = useState(false);
  const { isConnected, publicKey } = useWallet();

  useEffect(() => {
    setDelegatee(prefillAddress ?? "");
  }, [open, prefillAddress]);

  if (!open) return null;

  const isDelegatingAway =
    Boolean(currentDelegatee) &&
    Boolean(publicKey) &&
    currentDelegatee !== publicKey;

  async function handleDelegate(e: FormEvent) {
    e.preventDefault();
    if (!delegatee.trim()) return;

    setSubmitting(true);
    try {
      if (!isConnected || !publicKey) {
        throw new Error("Connect your wallet first.");
      }

      const client = getVotesClientFromEnv();
      const signer = getDelegateSigner();
      const txHash = await client.delegate(signer, delegatee.trim());
      toast.success(
        <div>
          Delegation submitted!{" "}
          <a href={explorerTxUrl(txHash)} target="_blank" rel="noreferrer" className="underline">
            View on Explorer →
          </a>
        </div>,
        { duration: 8000 },
      );
      onDelegated?.();
      onClose();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      toast.error(`Delegation failed: ${msg}`);
    } finally {
      setSubmitting(false);
    }
  }

  async function handleUndelegate() {
    if (!isConnected || !publicKey) {
      toast.error("Connect your wallet first.");
      return;
    }

    setSubmitting(true);
    try {
      const client = getVotesClientFromEnv();
      const signer = getDelegateSigner();
      const txHash = await client.undelegate(signer);
      toast.success(
        <div>
          Undelegation submitted!{" "}
          <a href={explorerTxUrl(txHash)} target="_blank" rel="noreferrer" className="underline">
            View on Explorer →
          </a>
        </div>,
        { duration: 8000 },
      );
      onDelegated?.();
      onClose();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      toast.error(`Undelegation failed: ${msg}`);
    } finally {
      setSubmitting(false);
    }
  }

  async function handleDelegateBySig() {
    if (!delegatee.trim()) return;

    setSubmitting(true);
    try {
      if (!isConnected || !publicKey) {
        throw new Error("Connect your wallet first.");
      }

      const client = getVotesClientFromEnv();
      const signer = getDelegateSigner();
      const nonce = 0n; // TODO: Query current nonce from contract
      const expiry = BigInt(Math.floor(Date.now() / 1000) + 3600);
      const signature = client.signDelegation(
        signer,
        delegatee.trim(),
        nonce,
        expiry,
      );

      await client.delegateBySig(
        signer,
        publicKey,
        delegatee.trim(),
        nonce,
        expiry,
        signature,
      );

      onDelegated?.();
      onClose();
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50">
      <div className="bg-white rounded-2xl p-6 w-full max-w-md shadow-xl">
        <h2 className="text-lg font-bold text-gray-900 mb-1">
          Delegate Voting Power
        </h2>
        <p className="text-sm text-gray-500 mb-4">
          Delegate to yourself to activate your voting power, or choose another
          address.
        </p>

        {isDelegatingAway && (
          <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
            You are currently delegating to{" "}
            <span className="font-mono">{currentDelegatee}</span>. Use
            undelegation to move power back to yourself.
          </div>
        )}

        <form onSubmit={handleDelegate} className="space-y-4">
          <div className="flex items-center justify-between gap-3">
            <span className="text-xs text-gray-500 font-mono">
              {publicKey
                ? `You: ${publicKey.slice(0, 4)}...${publicKey.slice(-4)}`
                : "Not connected"}
            </span>
            <button
              type="button"
              disabled={!publicKey}
              onClick={() => publicKey && setDelegatee(publicKey)}
              className="text-xs px-3 py-1.5 rounded-lg border border-gray-200 text-gray-700 hover:bg-gray-50 disabled:opacity-50"
            >
              Delegate to myself
            </button>
          </div>

          <input
            type="text"
            placeholder="Stellar address (G...)"
            value={delegatee}
            onChange={(e) => setDelegatee(e.target.value)}
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 font-mono"
            required
          />

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
              disabled={submitting}
              className="flex-1 bg-indigo-600 text-white py-2 rounded-lg text-sm font-medium hover:bg-indigo-700 disabled:opacity-50"
            >
              {submitting ? "Delegating..." : "Delegate"}
            </button>
          </div>

          {isDelegatingAway && (
            <button
              type="button"
              onClick={() => void handleUndelegate()}
              disabled={submitting}
              className="w-full rounded-lg border border-amber-200 bg-amber-50 py-2 text-sm font-medium text-amber-800 hover:bg-amber-100 disabled:opacity-50"
            >
              {submitting ? "Updating..." : "Undelegate"}
            </button>
          )}

          <div className="border-t border-gray-200 pt-4 mt-4">
            <p className="text-xs text-gray-500 mb-2">
              Or delegate without paying gas
            </p>
            <button
              type="button"
              onClick={() => void handleDelegateBySig()}
              disabled={submitting || !delegatee.trim()}
              className="w-full bg-green-600 text-white py-2 rounded-lg text-sm font-medium hover:bg-green-700 disabled:opacity-50"
            >
              {submitting ? "Signing..." : "Delegate without paying gas"}
            </button>
            <p className="text-xs text-gray-400 mt-1">
              Sign off-chain, relayer submits transaction
            </p>
          </div>
        </form>
      </div>
    </div>
  );
}
