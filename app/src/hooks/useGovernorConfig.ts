"use client";

import { useState, useEffect } from "react";
import {
  Contract,
  SorobanRpc,
  TransactionBuilder,
  Networks,
  BASE_FEE,
  scValToNative,
} from "@stellar/stellar-sdk";

type StellarNetwork = "mainnet" | "testnet" | "futurenet";

const NETWORK_PASSPHRASES: Record<StellarNetwork, string> = {
  mainnet: Networks.PUBLIC,
  testnet: Networks.TESTNET,
  futurenet: Networks.FUTURENET,
};

const RPC_URLS: Record<StellarNetwork, string> = {
  mainnet: "https://soroban-rpc.mainnet.stellar.gateway.fm",
  testnet: "https://soroban-testnet.stellar.org",
  futurenet: "https://rpc-futurenet.stellar.org",
};

const DEFAULT_DECIMALS = 7;

/**
 * Hook to access governance configuration including token decimals.
 *
 * Queries the token-votes contract's `token()` entrypoint for the underlying
 * asset, then that token's `decimals()`, using the same raw-simulate pattern
 * already used by `governors/page.tsx` for `token()`/`name()`. Falls back to
 * the Stellar-native default of 7 if the query fails (e.g. missing env vars
 * or an RPC error), so callers always get a usable divisor.
 */
export function useGovernorConfig() {
  const [decimals, setDecimals] = useState<number>(DEFAULT_DECIMALS);
  const [divisor, setDivisor] = useState<number>(10 ** DEFAULT_DECIMALS);

  useEffect(() => {
    let cancelled = false;

    async function fetchDecimals() {
      try {
        const votesAddress = process.env.NEXT_PUBLIC_VOTES_ADDRESS;
        const network = (process.env.NEXT_PUBLIC_NETWORK ||
          "testnet") as StellarNetwork;
        const rpcUrl = process.env.NEXT_PUBLIC_RPC_URL;
        if (!votesAddress) return;

        const server = new SorobanRpc.Server(rpcUrl ?? RPC_URLS[network], {
          allowHttp: false,
        });
        const networkPassphrase = NETWORK_PASSPHRASES[network];

        const votesContract = new Contract(votesAddress);
        const tokenResult = await server.simulateTransaction(
          new TransactionBuilder(await server.getAccount(votesAddress), {
            fee: BASE_FEE,
            networkPassphrase,
          })
            .addOperation(votesContract.call("token"))
            .setTimeout(30)
            .build(),
        );
        if (SorobanRpc.Api.isSimulationError(tokenResult)) return;
        const tokenAddress = scValToNative(
          (tokenResult as SorobanRpc.Api.SimulateTransactionSuccessResponse).result
            ?.retval,
        ) as string;
        if (!tokenAddress) return;

        const tokenContract = new Contract(tokenAddress);
        const decimalsResult = await server.simulateTransaction(
          new TransactionBuilder(await server.getAccount(tokenAddress), {
            fee: BASE_FEE,
            networkPassphrase,
          })
            .addOperation(tokenContract.call("decimals"))
            .setTimeout(30)
            .build(),
        );
        if (SorobanRpc.Api.isSimulationError(decimalsResult)) return;
        const fetchedDecimals = Number(
          scValToNative(
            (decimalsResult as SorobanRpc.Api.SimulateTransactionSuccessResponse)
              .result?.retval,
          ),
        );
        if (cancelled || !Number.isFinite(fetchedDecimals)) return;

        setDecimals(fetchedDecimals);
        setDivisor(Math.pow(10, fetchedDecimals));
      } catch {
        // Keep the Stellar-native default (7) if the query fails.
      }
    }

    void fetchDecimals();
    return () => {
      cancelled = true;
    };
  }, []);

  return { decimals, divisor };
}
