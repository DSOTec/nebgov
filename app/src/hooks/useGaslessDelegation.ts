"use client";

import { useCallback, useState } from "react";
import { DelegationSigClient, VotesClient, type Network } from "@nebgov/sdk";
import { isValidStellarAddress } from "../lib/utils/stellarAddress";
import { useWallet } from "../lib/wallet-context";
import { backendFetch } from "../lib/backend";
import { readGovernorConfig } from "../lib/nebgov-env";

/**
 * Approximate ledger close time used to convert a human-friendly expiry
 * ("1 week") into a ledger sequence number. Matches the ~5s/ledger
 * assumption already used elsewhere in the SDK (see votes.ts's
 * DEFAULT_SCAN_WINDOW comment).
 */
const LEDGER_SECONDS = 5;

export type ExpiryPreset = "1week" | "1month" | "6months" | "1year";

const EXPIRY_SECONDS: Record<ExpiryPreset, number> = {
  "1week": 7 * 24 * 60 * 60,
  "1month": 30 * 24 * 60 * 60,
  "6months": 182 * 24 * 60 * 60,
  "1year": 365 * 24 * 60 * 60,
};

export const EXPIRY_PRESET_LABELS: Record<ExpiryPreset, string> = {
  "1week": "1 week",
  "1month": "1 month",
  "6months": "6 months",
  "1year": "1 year",
};

export interface GaslessDelegationResult {
  txHash: string;
  nonce?: number;
}

export interface GaslessPreflightResult {
  ok: boolean;
  error?: string;
}

export interface InvalidatePermitsResult {
  txHash: string;
}

function getDelegationSigClientFromEnv(): DelegationSigClient {
  const votesAddress = process.env.NEXT_PUBLIC_VOTES_ADDRESS;
  const network = (process.env.NEXT_PUBLIC_NETWORK || "testnet") as Network;
  const rpcUrl = process.env.NEXT_PUBLIC_RPC_URL;

  if (!votesAddress) {
    throw new Error("Missing NEXT_PUBLIC_VOTES_ADDRESS in .env.local");
  }

  return new DelegationSigClient({
    votesAddress,
    network,
    ...(rpcUrl && { rpcUrl }),
  });
}

/**
 * Cycle/depth-limit checks (`wouldCreateCycle`, `getDelegationDepthLimit`,
 * `getChainDepth`) live on the token-votes contract, not the delegation-sig
 * one — they're read through `VotesClient`, which needs the full governor
 * config (governor + timelock + votes addresses), unlike
 * `DelegationSigClient`.
 */
function getVotesClientFromEnv(): VotesClient {
  const config = readGovernorConfig();
  if (!config) {
    throw new Error(
      "Missing NEXT_PUBLIC_GOVERNOR_ADDRESS/NEXT_PUBLIC_TIMELOCK_ADDRESS/NEXT_PUBLIC_VOTES_ADDRESS in .env.local",
    );
  }
  return new VotesClient(config);
}

/**
 * Sign a delegation permit with the connected wallet and submit it through
 * the backend relayer — the connected wallet never pays a fee or submits a
 * transaction itself, it only signs an authorization off-chain.
 */
export function useGaslessDelegation() {
  const { isConnected, publicKey, signTransaction, signAuthEntry } = useWallet();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const preflightDelegatee = useCallback(
    async (delegatee: string): Promise<GaslessPreflightResult> => {
      if (!delegatee.trim()) {
        return { ok: false, error: "Address is required." };
      }

      if (!isValidStellarAddress(delegatee)) {
        return { ok: false, error: "Invalid Stellar address." };
      }

      if (!isConnected || !publicKey) {
        return { ok: false, error: "Connect your wallet first." };
      }

      try {
        const client = getVotesClientFromEnv();
        const [wouldCreateCycle, depthLimit, currentDepth] = await Promise.all([
          client.wouldCreateCycle(publicKey, delegatee.trim()),
          client.getDelegationDepthLimit(),
          client.getChainDepth(publicKey),
        ]);

        if (wouldCreateCycle) {
          return { ok: false, error: "This delegation would create a cycle." };
        }

        if (currentDepth + 1 > depthLimit) {
          return {
            ok: false,
            error: `This delegation would exceed the maximum delegation depth of ${depthLimit}.`,
          };
        }

        return { ok: true };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { ok: false, error: message };
      }
    },
    [isConnected, publicKey],
  );

  const delegateGasless = useCallback(
    async (
      delegatee: string,
      expiryPreset: ExpiryPreset,
    ): Promise<GaslessDelegationResult> => {
      if (!isConnected || !publicKey) {
        throw new Error("Connect your wallet first.");
      }

      setSubmitting(true);
      setError(null);
      try {
        const client = getDelegationSigClientFromEnv();
        const currentLedger = await client.currentLedger();
        const expiryLedger =
          currentLedger +
          Math.ceil(EXPIRY_SECONDS[expiryPreset] / LEDGER_SECONDS);

        const { permit, authEntry } = await client.signDelegationPermit({
          delegator: {
            publicKey,
            sign: async (preimage) => {
              const signed = await signAuthEntry(preimage.toXDR("base64"));
              return Buffer.from(signed, "base64");
            },
          },
          delegatee,
          expiryLedger,
        });

        const result = await backendFetch<GaslessDelegationResult>(
          "/relayer/delegate",
          {
            method: "POST",
            body: JSON.stringify({
              permit: {
                delegator: permit.delegator,
                delegatee: permit.delegatee,
                nonce: permit.nonce.toString(),
                expiryLedger: permit.expiryLedger,
                chainId: permit.chainId.toString("base64"),
                contractId: permit.contractId,
              },
              signature: authEntry,
            }),
          },
        );

        return result;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setError(message);
        throw err;
      } finally {
        setSubmitting(false);
      }
    },
    [isConnected, publicKey, signAuthEntry],
  );

  const invalidateAllPermits = useCallback(async (): Promise<InvalidatePermitsResult> => {
    if (!isConnected || !publicKey || !signTransaction) {
      throw new Error("Connect your wallet first.");
    }

    setSubmitting(true);
    setError(null);
    try {
      const client = getDelegationSigClientFromEnv();
      const result = await client.invalidateAllPermitsWithSign(publicKey, signTransaction);
      return { txHash: result.hash };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      throw err;
    } finally {
      setSubmitting(false);
    }
  }, [isConnected, publicKey, signTransaction]);

  return {
    delegateGasless,
    preflightDelegatee,
    invalidateAllPermits,
    submitting,
    error,
  };
}
